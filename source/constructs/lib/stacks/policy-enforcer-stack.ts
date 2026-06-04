import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

export interface PolicyEnforcerStackProps extends cdk.StackProps {
  policyTableName?: string;
  /** S3 bucket containing the Lambda code zip. */
  deploymentAssetsBucketName?: string;
  /** Path within the deployment assets bucket to the Lambda code zip. */
  lambdaCodeZipPath?: string;
}

export enum PolicyEnforcerStackOutputs {
  PolicyTableName = 'PolicyTableName',
  PolicyTableArn = 'PolicyTableArn',
  IamHelperLambdaName = 'IamHelperLambdaName',
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

    // ----- DynamoDB table -----

    const policyTableName = props?.policyTableName ?? `${prefix}PolicyConfiguration`;
    this.tableName = policyTableName;

    const policyTable = new dynamodb.CfnTable(this, 'PolicyConfigurationTable', {
      tableName: policyTableName,
      billingMode: 'PAY_PER_REQUEST',
      sseSpecification: { sseEnabled: true },
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Composite primary key gives us atomic per-account name uniqueness
      // (Put with `attribute_not_exists(policyName)` is race-free) and
      // primary-key Query for listing — no GSI required. `policyName` is
      // therefore the policy's stable identifier; rename is unsupported
      // (would require delete + recreate).
      keySchema: [
        { attributeName: 'accountId', keyType: 'HASH' },
        { attributeName: 'policyName', keyType: 'RANGE' },
      ],
      attributeDefinitions: [
        { attributeName: 'accountId', attributeType: 'S' },
        { attributeName: 'policyName', attributeType: 'S' },
      ],
    });
    policyTable.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, PolicyEnforcerStackOutputs.PolicyTableName, {
      value: policyTableName,
      description: 'Name of the Policy_Configuration DynamoDB table.',
      exportName: `${prefix}PolicyTableName`,
    });

    new cdk.CfnOutput(this, PolicyEnforcerStackOutputs.PolicyTableArn, {
      value: cdk.Fn.getAtt(policyTable.logicalId, 'Arn').toString(),
      description: 'ARN of the Policy_Configuration DynamoDB table.',
      exportName: `${prefix}PolicyTableArn`,
    });

    // ----- IAM Helper Lambda (out of VPC) -----

    const iamHelperLambdaName = `${prefix}PolicyEnforcerIamHelper`;
    this.iamHelperLambdaName = iamHelperLambdaName;

    const iamHelperRole = new iam.CfnRole(this, `${iamHelperLambdaName}Role`, {
      roleName: cdk.Fn.sub(`${iamHelperLambdaName}Role-\${AWS::Region}`),
      description:
        'Execution role for the Policy Enforcer IAM Helper Lambda. Scoped to PolicyEnforcer-* managed policies only.',
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      managedPolicyArns: [cdk.Fn.sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')],
      policies: [
        {
          policyName: 'PolicyEnforcerIamManagement',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'iam:CreatePolicy',
                  'iam:CreatePolicyVersion',
                  'iam:DeletePolicy',
                  'iam:DeletePolicyVersion',
                  'iam:GetPolicy',
                  'iam:GetPolicyVersion',
                  'iam:ListPolicyVersions',
                ],
                Resource: cdk.Fn.sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/PolicyEnforcer-*'),
              },
            ],
          },
        },
      ],
    });

    new lambda.CfnFunction(this, iamHelperLambdaName, {
      functionName: iamHelperLambdaName,
      runtime: 'nodejs24.x',
      handler: 'policy-enforcer-iam-helper.handler',
      role: cdk.Fn.getAtt(iamHelperRole.logicalId, 'Arn').toString(),
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
  }
}
