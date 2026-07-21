import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export interface PolicyEnforcerStackProps extends cdk.StackProps {
  /** S3 bucket containing the Lambda code zip. */
  deploymentAssetsBucketName?: string;
  /** Path within the deployment assets bucket to the Lambda code zip. */
  lambdaCodeZipPath?: string;
  /** VPC for the in-VPC bulk-refresh Lambda. */
  privateVpcId?: string;
  /** Subnet (no internet gateway) for the bulk-refresh Lambda. */
  backendSubnetId?: string;
  /** Website bucket the bulk-refresh Lambda reads the catalog from. */
  websiteBucketName?: string;
}

export enum PolicyEnforcerStackOutputs {
  PolicyTableName = 'PolicyTableName',
  PolicyTableArn = 'PolicyTableArn',
  IamHelperLambdaName = 'IamHelperLambdaName',
  PolicyRefreshLambdaName = 'PolicyRefreshLambdaName',
}

/**
 * Optional Policy Enforcer stack.
 *
 * Owns:
 * - DynamoDB table for `PolicyConfiguration` records.
 * - Out-of-VPC IAM Helper Lambda that performs `iam:*Policy*` mutations on
 *   `PolicyEnforcer-*` policies (the in-VPC API Lambda can't reach IAM
 *   directly because IAM has no VPC endpoint).
 *
 * Wiring to the API Lambda (env vars + permissions to invoke the helper) is
 * added on the main Capability Insights stack when `--enable-policy-enforcer`
 * is set; the table name and helper Lambda name are passed as CFN parameters.
 *
 * The Policy Enforcer creates IAM Managed Policies named `PolicyEnforcer-*`.
 * The helper Lambda's IAM permissions are scoped to that prefix, keeping the
 * blast radius limited to policies the feature itself owns.
 */
export class PolicyEnforcerStack extends cdk.Stack {
  public readonly tableName: string;
  public readonly iamHelperLambdaName: string;
  public readonly policyRefreshLambdaName: string;

  constructor(app: cdk.App, id: string, props?: PolicyEnforcerStackProps) {
    super(app, id, props);

    const prefix = 'CapabilityInsights';

    const deploymentAssetsBucketNameParameter = new cdk.CfnParameter(this, 'DeploymentAssetsBucketName', {
      type: 'String',
      description: 'Name of S3 bucket where deployment assets (Lambda code zip) are located.',
      default: props?.deploymentAssetsBucketName,
    });

    const lambdaCodeZipPathParameter = new cdk.CfnParameter(this, 'LambdaCodeZipPath', {
      type: 'String',
      description: 'Path in the deployment assets bucket where the Lambda code zip is located.',
      default: props?.lambdaCodeZipPath ?? 'lambdaAssets.zip',
    });

    const privateVpcIdParameter = new cdk.CfnParameter(this, 'PrivateVpcId', {
      type: 'AWS::EC2::VPC::Id',
      description: 'VPC where the in-VPC bulk policy-refresh Lambda runs.',
      default: props?.privateVpcId,
    });

    const backendSubnetIdParameter = new cdk.CfnParameter(this, 'BackendSubnetId', {
      type: 'AWS::EC2::Subnet::Id',
      description:
        'Subnet (no internet gateway) for the bulk policy-refresh Lambda. Must reach DynamoDB and S3 via gateway endpoints.',
      default: props?.backendSubnetId,
    });

    const websiteBucketNameParameter = new cdk.CfnParameter(this, 'WebsiteBucketName', {
      type: 'String',
      description: 'Website bucket the bulk refresh Lambda reads the catalog (apis.json) from.',
      default: props?.websiteBucketName,
    });

    // ----- DynamoDB table -----
    //
    // The logical ID is explicitly pinned via overrideLogicalId so a future
    // CDK refactor (e.g. wrapping the table in a sub-construct) cannot
    // silently change it underneath the hardcoded tableName. A hardcoded
    // physical name + a drifting logical ID would have CFN plan an Add for
    // a brand-new table while the old one still owns the name, failing
    // ResourceExistenceCheck. Pinning keeps both stable; an intentional
    // future replacement must change BOTH the logical ID and the name.

    const policyTableName = `${prefix}PolicyConfiguration`;
    this.tableName = policyTableName;
    const policyTable = new dynamodb.Table(this, 'PolicyConfigurationTable', {
      tableName: policyTableName,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // AWS-managed KMS key (aws/dynamodb) — equivalent to the prior
      // SSESpecification { SSEEnabled: true } with no explicit SSEType.
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Composite primary key gives us atomic per-account name uniqueness
      // (Put with `attribute_not_exists(policyName)` is race-free) and
      // primary-key Query for listing — no GSI required. `policyName` is
      // therefore the policy's stable identifier; rename is unsupported
      // (would require delete + recreate).
      partitionKey: { name: 'accountId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'policyName', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    (policyTable.node.defaultChild as cdk.CfnElement).overrideLogicalId('PolicyConfigurationTable');

    new cdk.CfnOutput(this, PolicyEnforcerStackOutputs.PolicyTableName, {
      value: policyTableName,
      description: 'Name of the Policy_Configuration DynamoDB table.',
      exportName: `${prefix}PolicyTableName`,
    });

    new cdk.CfnOutput(this, PolicyEnforcerStackOutputs.PolicyTableArn, {
      value: policyTable.tableArn,
      description: 'ARN of the Policy_Configuration DynamoDB table.',
      exportName: `${prefix}PolicyTableArn`,
    });

    // ----- IAM Helper Lambda (out of VPC) -----

    const iamHelperLambdaName = `${prefix}PolicyEnforcerIamHelper`;
    this.iamHelperLambdaName = iamHelperLambdaName;

    const iamHelperRole = new iam.Role(this, `${iamHelperLambdaName}Role`, {
      // Logical ID is pinned via overrideLogicalId (below) to keep it stable
      // across deploys. The physical role name is left for CloudFormation to
      // generate — no need to force one (auto-names are always within limits).
      description:
        'Execution role for the Policy Enforcer IAM Helper Lambda. Scoped to PolicyEnforcer-* managed policies only.',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      inlinePolicies: {
        PolicyEnforcerIamManagement: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'iam:CreatePolicy',
                'iam:CreatePolicyVersion',
                'iam:DeletePolicy',
                'iam:DeletePolicyVersion',
                'iam:GetPolicy',
                'iam:GetPolicyVersion',
                'iam:ListPolicyVersions',
              ],
              resources: [cdk.Fn.sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/PolicyEnforcer-*')],
            }),
            // Resolve the runtime account ID for the adopt-on-existing path.
            // Required because the Lambda runtime does not expose the
            // function ARN via env vars — STS is the only portable lookup.
            new iam.PolicyStatement({
              actions: ['sts:GetCallerIdentity'],
              resources: ['*'],
            }),
          ],
        }),
      },
    });
    (iamHelperRole.node.defaultChild as cdk.CfnElement).overrideLogicalId(`${iamHelperLambdaName}Role`);

    new lambda.CfnFunction(this, iamHelperLambdaName, {
      functionName: iamHelperLambdaName,
      runtime: 'nodejs24.x',
      handler: 'policy-enforcer-iam-helper.handler',
      role: iamHelperRole.roleArn,
      code: {
        s3Bucket: deploymentAssetsBucketNameParameter.valueAsString,
        s3Key: lambdaCodeZipPathParameter.valueAsString,
      },
      memorySize: 256,
      timeout: 60,
    });

    new cdk.CfnOutput(this, PolicyEnforcerStackOutputs.IamHelperLambdaName, {
      value: iamHelperLambdaName,
      description: 'Name of the out-of-VPC IAM Helper Lambda the API Lambda must invoke for IAM policy mutations.',
      exportName: `${prefix}IamHelperLambdaName`,
    });

    // ----- Bulk Policy Refresh Lambda (in VPC) -----
    //
    // Recomputes every policy against the current catalog. Runs in-VPC because
    // it reads the VPC-restricted website bucket (catalog) and DynamoDB via
    // gateway endpoints, and invokes the out-of-VPC IAM helper for mutations.
    // Driven by `POST /policies/refresh-all` (async invoke from the API Lambda)
    // and a weekly EventBridge schedule.

    const refreshLambdaName = `${prefix}PolicyEnforcerBulkRefresh`;
    this.policyRefreshLambdaName = refreshLambdaName;

    const refreshSecurityGroup = new ec2.CfnSecurityGroup(this, `${refreshLambdaName}SG`, {
      groupDescription: 'Security group for the Policy Enforcer bulk refresh Lambda.',
      vpcId: privateVpcIdParameter.valueAsString,
      securityGroupEgress: [
        {
          ipProtocol: '-1',
          cidrIp: '0.0.0.0/0',
          description: 'Allow all outbound (S3/DynamoDB gateway endpoints, Lambda VPC endpoint).',
        },
      ],
    });

    const refreshRole = new iam.Role(this, `${refreshLambdaName}Role`, {
      // Logical ID pinned below — see the IAM Helper role above for the rationale.
      description: 'Execution role for the Policy Enforcer bulk refresh Lambda.',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        // VPCAccessExecutionRole covers ENI management + basic logging for in-VPC Lambdas.
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
      inlinePolicies: {
        BulkRefreshAccess: new iam.PolicyDocument({
          statements: [
            // Read/write the policy table.
            new iam.PolicyStatement({
              actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
              resources: [policyTable.tableArn],
            }),
            // Read the catalog from the website bucket.
            new iam.PolicyStatement({
              actions: ['s3:GetObject'],
              resources: [
                cdk.Fn.sub('arn:${AWS::Partition}:s3:::${WebsiteBucket}/*', {
                  WebsiteBucket: websiteBucketNameParameter.valueAsString,
                }),
              ],
            }),
            // Invoke the out-of-VPC IAM helper to apply policy documents.
            new iam.PolicyStatement({
              actions: ['lambda:InvokeFunction'],
              resources: [
                cdk.Fn.sub(
                  'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:' + iamHelperLambdaName,
                ),
              ],
            }),
            // Resolve the current account ID at runtime.
            new iam.PolicyStatement({
              actions: ['sts:GetCallerIdentity'],
              resources: ['*'],
            }),
          ],
        }),
      },
    });
    (refreshRole.node.defaultChild as cdk.CfnElement).overrideLogicalId(`${refreshLambdaName}Role`);

    const refreshLambda = new lambda.CfnFunction(this, refreshLambdaName, {
      functionName: refreshLambdaName,
      runtime: 'nodejs24.x',
      handler: 'policy-refresh-lambda-main.handler',
      role: refreshRole.roleArn,
      code: {
        s3Bucket: deploymentAssetsBucketNameParameter.valueAsString,
        s3Key: lambdaCodeZipPathParameter.valueAsString,
      },
      memorySize: 512,
      // Bulk refresh is sequential across all policies, each an IAM round-trip.
      // 15 minutes is the Lambda max and a safe ceiling for large policy sets.
      timeout: 900,
      environment: {
        variables: {
          POLICY_TABLE_NAME: policyTableName,
          WEBSITE_BUCKET_NAME: websiteBucketNameParameter.valueAsString,
          IAM_HELPER_LAMBDA_NAME: iamHelperLambdaName,
        },
      },
      vpcConfig: {
        subnetIds: [backendSubnetIdParameter.valueAsString],
        securityGroupIds: [cdk.Fn.getAtt(refreshSecurityGroup.logicalId, 'GroupId').toString()],
      },
    });

    // Weekly schedule. EventBridge invokes the refresh Lambda directly.
    const weeklyRule = new events.CfnRule(this, `${refreshLambdaName}WeeklyRule`, {
      description: 'Weekly bulk refresh of all Policy Enforcer policies against the latest catalog.',
      scheduleExpression: 'rate(7 days)',
      state: 'ENABLED',
      targets: [
        {
          arn: cdk.Fn.getAtt(refreshLambda.logicalId, 'Arn').toString(),
          id: 'PolicyEnforcerBulkRefreshTarget',
        },
      ],
    });

    new lambda.CfnPermission(this, `${refreshLambdaName}InvokePermission`, {
      action: 'lambda:InvokeFunction',
      functionName: refreshLambdaName,
      principal: 'events.amazonaws.com',
      sourceArn: cdk.Fn.getAtt(weeklyRule.logicalId, 'Arn').toString(),
    });

    new cdk.CfnOutput(this, PolicyEnforcerStackOutputs.PolicyRefreshLambdaName, {
      value: refreshLambdaName,
      description: 'Name of the in-VPC bulk refresh Lambda. The API Lambda invokes it for POST /policies/refresh-all.',
      exportName: `${prefix}PolicyRefreshLambdaName`,
    });
  }
}
