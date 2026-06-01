import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';

export interface UsageAnalysisStackProps extends cdk.StackProps {
  websiteBucketName?: string;
  websiteBucketArn?: string;
  deploymentAssetsBucketName?: string;
  lambdaCodeZipPath?: string;
  cloudTrailBucketName?: string;
  /**
   * Name of the IAM role used to deploy this stack. Added as a Lake Formation
   * Data Lake Admin during stack creation so that subsequent
   * `AWS::LakeFormation::Permissions` resources can be created. On a fresh
   * account no admins are configured by default, which causes those resources
   * to fail with AccessDeniedException. Defaults to `Admin`.
   */
  deployerRoleName?: string;
  /**
   * EventBridge schedule expression for automated analysis runs. Accepts the
   * AWS Schedule Expression syntax: `rate(...)` for fixed intervals (`rate(1 day)`,
   * `rate(12 hours)`) or `cron(...)` for time-of-day scheduling
   * (`cron(0 6 * * ? *)` = daily at 06:00 UTC).
   *
   * Default is `rate(1 day)`. To change without redeploying CDK, set the
   * AnalysisSchedule CloudFormation parameter at deploy time.
   */
  analysisSchedule?: string;
  /**
   * CloudTrail lookback window (days) for scheduled analyzer runs. Default
   * is 30. Bigger windows catch less-frequent APIs but cost more in Athena
   * scans; smaller windows are cheaper but miss occasional usage.
   */
  daysToScan?: number;
}

export enum UsageAnalysisStackOutputs {
  CloudTrailAnalyzerLambdaName = 'CloudTrailAnalyzerLambdaName',
  CloudFormationAnalyzerLambdaName = 'CloudFormationAnalyzerLambdaName',
  UsageDecoratorLambdaName = 'UsageDecoratorLambdaName',
  AnalysisStateMachineArn = 'AnalysisStateMachineArn',
  ConfiguredCloudTrailBucketName = 'ConfiguredCloudTrailBucketName',
}

/**
 * Usage Analysis CDK stack for the personalization feature.
 *
 * Contains the CloudTrail Analyzer Lambda, Step Functions state machine,
 * and associated IAM roles. Deployed after the insights stack and consumes
 * the website bucket outputs for storing analysis results.
 *
 * Deployment order: Environment → Insights → Usage Analysis
 */
export class UsageAnalysisStack extends cdk.Stack {
  constructor(app: cdk.App, id: string, props?: UsageAnalysisStackProps) {
    super(app, id, props);

    const prefix = 'CapabilityInsights';

    const websiteBucketNameParameter = new cdk.CfnParameter(this, 'WebsiteBucketName', {
      type: 'String',
      description: 'Name of the Capability Insights website S3 bucket (for storing analysis results).',
      default: props?.websiteBucketName,
    });

    const websiteBucketArnParameter = new cdk.CfnParameter(this, 'WebsiteBucketArn', {
      type: 'String',
      description: 'ARN of the Capability Insights website S3 bucket.',
      default: props?.websiteBucketArn,
    });

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

    const cloudTrailBucketNameParameter = new cdk.CfnParameter(this, 'CloudTrailBucketName', {
      type: 'String',
      description: 'Name of the S3 bucket containing CloudTrail logs for usage analysis.',
      default: props?.cloudTrailBucketName ?? '',
    });

    const deployerRoleNameParameter = new cdk.CfnParameter(this, 'DeployerRoleName', {
      type: 'String',
      description:
        'Name of the IAM role used to deploy this stack. Added as a Lake Formation Data Lake Admin so subsequent LF Permissions can be granted. Defaults to "Admin".',
      default: props?.deployerRoleName ?? 'Admin',
    });

    const analysisScheduleParameter = new cdk.CfnParameter(this, 'AnalysisSchedule', {
      type: 'String',
      description:
        'EventBridge schedule expression for automated analysis runs (e.g. "rate(1 day)", "cron(0 6 * * ? *)").',
      default: props?.analysisSchedule ?? 'rate(1 day)',
      // Reject empty / clearly-malformed values at deploy time.
      allowedPattern: '^(rate|cron)\\(.+\\)$',
      constraintDescription: 'Must be a valid EventBridge schedule expression like rate(1 day) or cron(0 6 * * ? *).',
    });

    const daysToScanParameter = new cdk.CfnParameter(this, 'DaysToScan', {
      type: 'Number',
      description: 'CloudTrail lookback window (days) for scheduled analyzer runs.',
      default: props?.daysToScan ?? 30,
      minValue: 1,
      maxValue: 90,
    });

    // Glue Database and Table for CloudTrail analysis (pre-provisioned at deploy time)
    const glueDatabase = new glue.CfnDatabase(this, `${prefix}CloudTrailDatabase`, {
      catalogId: cdk.Fn.ref('AWS::AccountId'),
      databaseInput: {
        name: 'cloudtrail_analysis',
        description: 'Database for CloudTrail usage analysis queries',
      },
    });

    const glueTable = new glue.CfnTable(this, `${prefix}CloudTrailTable`, {
      catalogId: cdk.Fn.ref('AWS::AccountId'),
      databaseName: 'cloudtrail_analysis',
      tableInput: {
        name: 'cloudtrail_logs',
        description: 'CloudTrail logs table with partition projection',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          'projection.enabled': 'false',
        },
        storageDescriptor: {
          location: cdk.Fn.sub('s3://${BucketName}/AWSLogs/${AWS::AccountId}/CloudTrail/', {
            BucketName: cloudTrailBucketNameParameter.valueAsString,
          }),
          inputFormat: 'com.amazon.emr.cloudtrail.CloudTrailInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'com.amazon.emr.hive.serde.CloudTrailSerde',
          },
          columns: [
            { name: 'eventversion', type: 'string' },
            {
              name: 'useridentity',
              type: 'struct<type:string,principalid:string,arn:string,accountid:string,invokedby:string,accesskeyid:string,username:string,sessioncontext:struct<attributes:struct<mfaauthenticated:string,creationdate:string>,sessionissuer:struct<type:string,principalid:string,arn:string,accountid:string,username:string>>>',
            },
            { name: 'eventtime', type: 'string' },
            { name: 'eventsource', type: 'string' },
            { name: 'eventname', type: 'string' },
            { name: 'awsregion', type: 'string' },
            { name: 'sourceipaddress', type: 'string' },
            { name: 'useragent', type: 'string' },
            { name: 'errorcode', type: 'string' },
            { name: 'errormessage', type: 'string' },
            { name: 'requestparameters', type: 'string' },
            { name: 'responseelements', type: 'string' },
            { name: 'additionaleventdata', type: 'string' },
            { name: 'requestid', type: 'string' },
            { name: 'eventid', type: 'string' },
            { name: 'resources', type: 'array<struct<arn:string,accountid:string,type:string>>' },
            { name: 'eventtype', type: 'string' },
            { name: 'apiversion', type: 'string' },
            { name: 'readonly', type: 'string' },
            { name: 'recipientaccountid', type: 'string' },
            { name: 'serviceeventdetails', type: 'string' },
            { name: 'sharedeventid', type: 'string' },
            { name: 'vpcendpointid', type: 'string' },
          ],
        },
        partitionKeys: [],
      },
    });
    glueTable.addDependency(glueDatabase);

    // CloudTrail Analyzer Lambda
    const cloudtrailAnalyzerLambdaName = `${prefix}CloudTrailAnalyzer`;
    const cloudtrailAnalyzerRole = new iam.CfnRole(this, `${cloudtrailAnalyzerLambdaName}Role`, {
      roleName: cdk.Fn.sub(`${cloudtrailAnalyzerLambdaName}Role-\${AWS::Region}`),
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
          policyName: 'AthenaAccess',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'athena:StartQueryExecution',
                  'athena:GetQueryExecution',
                  'athena:GetQueryResults',
                  'athena:StopQueryExecution',
                ],
                Resource: cdk.Fn.sub('arn:${AWS::Partition}:athena:${AWS::Region}:${AWS::AccountId}:workgroup/primary'),
              },
            ],
          },
        },
        {
          policyName: 'GlueCatalogAccess',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['glue:GetDatabase'],
                Resource: [
                  cdk.Fn.sub('arn:${AWS::Partition}:glue:${AWS::Region}:${AWS::AccountId}:catalog'),
                  cdk.Fn.sub(
                    'arn:${AWS::Partition}:glue:${AWS::Region}:${AWS::AccountId}:database/cloudtrail_analysis',
                  ),
                ],
              },
              {
                Effect: 'Allow',
                Action: ['glue:GetTable', 'glue:GetTables'],
                Resource: [
                  cdk.Fn.sub('arn:${AWS::Partition}:glue:${AWS::Region}:${AWS::AccountId}:catalog'),
                  cdk.Fn.sub(
                    'arn:${AWS::Partition}:glue:${AWS::Region}:${AWS::AccountId}:database/cloudtrail_analysis',
                  ),
                  cdk.Fn.sub('arn:${AWS::Partition}:glue:${AWS::Region}:${AWS::AccountId}:table/cloudtrail_analysis/*'),
                ],
              },
            ],
          },
        },
        {
          policyName: 'S3ReadAccess',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'ReadCloudTrailLogs',
                Effect: 'Allow',
                Action: ['s3:GetObject', 's3:ListBucket'],
                Resource: [
                  cdk.Fn.sub('arn:${AWS::Partition}:s3:::${BucketName}', {
                    BucketName: cloudTrailBucketNameParameter.valueAsString,
                  }),
                  cdk.Fn.sub('arn:${AWS::Partition}:s3:::${BucketName}/*', {
                    BucketName: cloudTrailBucketNameParameter.valueAsString,
                  }),
                ],
              },
              {
                Sid: 'ReadAthenaResults',
                Effect: 'Allow',
                Action: ['s3:GetObject', 's3:ListBucket'],
                Resource: [
                  websiteBucketArnParameter.valueAsString,
                  cdk.Fn.sub('${BucketArn}/athena-results/*', {
                    BucketArn: websiteBucketArnParameter.valueAsString,
                  }),
                ],
              },
              {
                Sid: 'GetWebsiteBucketLocation',
                Effect: 'Allow',
                Action: ['s3:GetBucketLocation'],
                Resource: websiteBucketArnParameter.valueAsString,
              },
            ],
          },
        },
        {
          policyName: 'S3WriteAccess',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['s3:PutObject'],
                Resource: [
                  cdk.Fn.sub('${BucketArn}/athena-results/*', {
                    BucketArn: websiteBucketArnParameter.valueAsString,
                  }),
                  cdk.Fn.sub('${BucketArn}/usage/*', {
                    BucketArn: websiteBucketArnParameter.valueAsString,
                  }),
                ],
              },
            ],
          },
        },
      ],
    });

    // Bootstrap Lake Formation Data Lake Admins. Adding LF Permissions resources
    // (below) requires the deployer principal to be a Data Lake Admin. On a fresh
    // account, no admins are configured, so AWS::LakeFormation::Permissions creation
    // fails with AccessDeniedException. This custom resource appends the analyzer
    // role and the deployer role to the existing admin list so the stack can
    // self-bootstrap LF without clobbering pre-existing admins.
    //
    // Implemented as a hand-rolled L1 (lambda.CfnFunction with inline zipFile
    // + cdk.CfnCustomResource) rather than cr.AwsCustomResource because the
    // L2 construct ships its provider Lambda code via CDK assets, which this
    // codebase's deploy.sh flow does not upload (it uses `aws cloudformation
    // deploy` directly, not `cdk deploy`).
    const lakeFormationBootstrapLambdaName = `${prefix}LakeFormationBootstrapLambda`;
    const lakeFormationBootstrapRoleName = `${prefix}LakeFormationBootstrapLambdaRole`;
    const lakeFormationBootstrapRoleNameFn = cdk.Fn.sub(`${lakeFormationBootstrapRoleName}-\${AWS::Region}`);
    const lakeFormationBootstrapRole = new iam.CfnRole(this, lakeFormationBootstrapRoleName, {
      roleName: lakeFormationBootstrapRoleNameFn,
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
          policyName: 'LakeFormationBootstrap',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['lakeformation:GetDataLakeSettings', 'lakeformation:PutDataLakeSettings'],
                Resource: '*',
              },
            ],
          },
        },
      ],
    });

    const lakeFormationBootstrapLambda = new lambda.CfnFunction(this, lakeFormationBootstrapLambdaName, {
      functionName: lakeFormationBootstrapLambdaName,
      runtime: 'python3.11',
      handler: 'index.lambda_handler',
      role: cdk.Fn.getAtt(lakeFormationBootstrapRole.logicalId, 'Arn').toString(),
      code: {
        zipFile: `import boto3
import cfnresponse

lf = boto3.client('lakeformation')

def lambda_handler(event, context):
    try:
        # Don't strip LF admins on stack delete — would orphan any
        # LF-protected resources still managed by those admins.
        if event['RequestType'] == 'Delete':
            cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
            return

        admins_to_add = event['ResourceProperties']['AdminsToAdd']
        if isinstance(admins_to_add, str):
            admins_to_add = [admins_to_add]

        existing = lf.get_data_lake_settings()['DataLakeSettings']
        existing_admins = existing.get('DataLakeAdmins', []) or []
        existing_arns = {a.get('DataLakePrincipalIdentifier') for a in existing_admins}

        merged = list(existing_admins)
        for arn in admins_to_add:
            if arn and arn not in existing_arns:
                merged.append({'DataLakePrincipalIdentifier': arn})
                existing_arns.add(arn)

        new_settings = dict(existing)
        new_settings['DataLakeAdmins'] = merged
        lf.put_data_lake_settings(DataLakeSettings=new_settings)

        cfnresponse.send(event, context, cfnresponse.SUCCESS, {'AdminsConfigured': str(len(merged))})
    except Exception as e:
        print(f"Error: {str(e)}")
        cfnresponse.send(event, context, cfnresponse.FAILED, {'Error': str(e)})`,
      },
      timeout: 60,
    });
    lakeFormationBootstrapLambda.addDependency(lakeFormationBootstrapRole);

    const lakeFormationBootstrap = new cdk.CfnCustomResource(this, `${prefix}LakeFormationBootstrap`, {
      serviceToken: cdk.Fn.getAtt(lakeFormationBootstrapLambda.logicalId, 'Arn').toString(),
    });
    lakeFormationBootstrap.addPropertyOverride('AdminsToAdd', [
      cdk.Fn.getAtt(cloudtrailAnalyzerRole.logicalId, 'Arn').toString(),
      cdk.Fn.sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${DeployerRoleName}', {
        DeployerRoleName: deployerRoleNameParameter.valueAsString,
      }),
    ]);
    lakeFormationBootstrap.addDependency(cloudtrailAnalyzerRole);

    // Lake Formation permissions for the Lambda role to access the Glue database and table
    const lakeFormationDbPermission = new lakeformation.CfnPermissions(this, `${prefix}LakeFormationDbPermission`, {
      dataLakePrincipal: {
        dataLakePrincipalIdentifier: cdk.Fn.getAtt(cloudtrailAnalyzerRole.logicalId, 'Arn').toString(),
      },
      resource: {
        databaseResource: {
          name: 'cloudtrail_analysis',
        },
      },
      permissions: ['DESCRIBE'],
    });
    lakeFormationDbPermission.addDependency(glueDatabase);
    lakeFormationDbPermission.addDependency(cloudtrailAnalyzerRole);
    lakeFormationDbPermission.node.addDependency(lakeFormationBootstrap);

    const lakeFormationTablePermission = new lakeformation.CfnPermissions(
      this,
      `${prefix}LakeFormationTablePermission`,
      {
        dataLakePrincipal: {
          dataLakePrincipalIdentifier: cdk.Fn.getAtt(cloudtrailAnalyzerRole.logicalId, 'Arn').toString(),
        },
        resource: {
          tableResource: {
            databaseName: 'cloudtrail_analysis',
            tableWildcard: {},
          },
        },
        permissions: ['DESCRIBE', 'SELECT'],
      },
    );
    lakeFormationTablePermission.addDependency(glueTable);
    lakeFormationTablePermission.addDependency(cloudtrailAnalyzerRole);
    lakeFormationTablePermission.node.addDependency(lakeFormationBootstrap);

    const cloudtrailAnalyzerLambda = new lambda.CfnFunction(this, cloudtrailAnalyzerLambdaName, {
      functionName: cloudtrailAnalyzerLambdaName,
      runtime: 'nodejs24.x',
      handler: 'cloudtrail-analyzer.handler',
      role: cdk.Fn.getAtt(cloudtrailAnalyzerRole.logicalId, 'Arn').toString(),
      code: {
        s3Bucket: deploymentAssetsBucketNameParameter.valueAsString,
        s3Key: lambdaCodeZipPathParameter.valueAsString,
      },
      timeout: 300,
      environment: {
        variables: {
          WEBSITE_BUCKET_NAME: websiteBucketNameParameter.valueAsString,
        },
      },
      memorySize: 512,
    });

    // CloudFormation Analyzer Lambda
    //
    // Security note: this Lambda reads every active CloudFormation stack's
    // processed template in the account via cloudformation:GetTemplate. Templates
    // may contain sensitive configuration (resource ARNs, VPC/subnet IDs, KMS
    // key references, etc.). The analyzer only extracts scalar property values
    // (strings, numbers, booleans) and resource types; nested objects and arrays
    // are ignored. Output is written to the website bucket's usage/ prefix,
    // which is only accessible from within the configured VPC.
    const cloudformationAnalyzerLambdaName = `${prefix}CloudFormationAnalyzer`;
    const cloudformationAnalyzerRole = new iam.CfnRole(this, `${cloudformationAnalyzerLambdaName}Role`, {
      roleName: cdk.Fn.sub(`${cloudformationAnalyzerLambdaName}Role-\${AWS::Region}`),
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
          policyName: 'CloudFormationRead',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['cloudformation:ListStacks', 'cloudformation:GetTemplate', 'cloudformation:DescribeStacks'],
                // Resource '*' is required: ListStacks does not support resource-level
                // permissions, and we need to scan all stacks in the account.
                Resource: '*',
              },
            ],
          },
        },
        {
          policyName: 'S3WriteAccess',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['s3:PutObject'],
                Resource: [
                  cdk.Fn.sub('${BucketArn}/usage/*', {
                    BucketArn: websiteBucketArnParameter.valueAsString,
                  }),
                ],
              },
            ],
          },
        },
      ],
    });

    const cloudformationAnalyzerLambda = new lambda.CfnFunction(this, cloudformationAnalyzerLambdaName, {
      functionName: cloudformationAnalyzerLambdaName,
      runtime: 'nodejs24.x',
      handler: 'cloudformation-analyzer.handler',
      role: cdk.Fn.getAtt(cloudformationAnalyzerRole.logicalId, 'Arn').toString(),
      code: {
        s3Bucket: deploymentAssetsBucketNameParameter.valueAsString,
        s3Key: lambdaCodeZipPathParameter.valueAsString,
      },
      timeout: 300,
      environment: {
        variables: {
          WEBSITE_BUCKET_NAME: websiteBucketNameParameter.valueAsString,
        },
      },
      memorySize: 512,
    });

    // Usage Decorator Lambda
    //
    // Runs after the parallel analyzers. Reads the master capability catalogs
    // (products.json, apis.json, cfn_resources.json) from the website bucket,
    // decorates the usage data with regional availability, and writes three
    // personalized files (used-capabilities-{scope}-{filterMode}.json) back
    // to the same bucket for the UI to consume.
    const usageDecoratorLambdaName = `${prefix}UsageDecorator`;
    const usageDecoratorRole = new iam.CfnRole(this, `${usageDecoratorLambdaName}Role`, {
      roleName: cdk.Fn.sub(`${usageDecoratorLambdaName}Role-\${AWS::Region}`),
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
          policyName: 'S3ReadMasterCatalogs',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['s3:GetObject'],
                Resource: cdk.Fn.sub('${BucketArn}/data/json/*', {
                  BucketArn: websiteBucketArnParameter.valueAsString,
                }),
              },
            ],
          },
        },
        {
          policyName: 'S3WriteUsedFiles',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['s3:PutObject'],
                Resource: cdk.Fn.sub('${BucketArn}/data/json/used-*.json', {
                  BucketArn: websiteBucketArnParameter.valueAsString,
                }),
              },
            ],
          },
        },
      ],
    });

    const usageDecoratorLambda = new lambda.CfnFunction(this, usageDecoratorLambdaName, {
      functionName: usageDecoratorLambdaName,
      runtime: 'nodejs24.x',
      handler: 'usage-decorator.handler',
      role: cdk.Fn.getAtt(usageDecoratorRole.logicalId, 'Arn').toString(),
      code: {
        s3Bucket: deploymentAssetsBucketNameParameter.valueAsString,
        s3Key: lambdaCodeZipPathParameter.valueAsString,
      },
      timeout: 120,
      environment: {
        variables: {
          WEBSITE_BUCKET_NAME: websiteBucketNameParameter.valueAsString,
          // Keep all features under each kept service in the personalized view.
          // Set to "false" via stack override to narrow features to only those
          // directly observed in usage data.
          INCLUDE_ALL_FEATURES_PER_SERVICE: 'true',
        },
      },
      memorySize: 512,
    });

    // Step Functions State Machine for Analysis
    const stateMachineRole = new iam.Role(this, `${prefix}AnalysisStateMachineRole`, {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      inlinePolicies: {
        InvokeLambda: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['lambda:InvokeFunction'],
              resources: [
                cdk.Fn.getAtt(cloudtrailAnalyzerLambda.logicalId, 'Arn').toString(),
                cdk.Fn.getAtt(cloudformationAnalyzerLambda.logicalId, 'Arn').toString(),
                cdk.Fn.getAtt(usageDecoratorLambda.logicalId, 'Arn').toString(),
              ],
            }),
          ],
        }),
      },
    });

    // Step Functions State Machine definition
    //
    // Error handling strategy:
    // - Retry: each analyzer task retries up to 3 times on transient Lambda
    //   errors (throttling, service exceptions) with exponential backoff.
    // - Catch: if a task still fails, the error is captured in the branch
    //   output as { analyzer, status: 'failed', error } rather than failing
    //   the entire parallel execution. Other analyzers continue to run.
    //
    // Failures are observable via:
    // - Lambda CloudWatch Logs (structured logs from the logger utility)
    // - Step Functions execution history (full retry attempts and error details)
    // - The /analysis GET endpoint response (returns the captured error)
    //
    // Proactive alerting (CloudWatch alarms, SNS notifications) is intentionally
    // not included here — it's a deployment concern that should be configured
    // per environment based on the consumer's operational requirements.
    const stateMachineDefinition = {
      Comment: 'Analysis workflow: parallel analyzers → merge usage into personalized files',
      StartAt: 'ParallelAnalyzers',
      States: {
        ParallelAnalyzers: {
          Type: 'Parallel',
          // Preserve the original input so DecorateUsage still has websiteBucket, etc.
          // Branch outputs are collected under $.parallelResults.
          ResultPath: '$.parallelResults',
          Next: 'DecorateUsage',
          Branches: [
            {
              StartAt: 'CloudTrailAnalyzer',
              States: {
                CloudTrailAnalyzer: {
                  Type: 'Task',
                  Resource: cdk.Fn.getAtt(cloudtrailAnalyzerLambda.logicalId, 'Arn').toString(),
                  // Match Lambda timeout so Step Functions fails fast if the
                  // task hangs. Kept in sync with the Lambda's timeout property.
                  TimeoutSeconds: cloudtrailAnalyzerLambda.timeout,
                  Retry: [
                    {
                      ErrorEquals: [
                        'Lambda.ServiceException',
                        'Lambda.AWSLambdaException',
                        'Lambda.SdkClientException',
                        'Lambda.TooManyRequestsException',
                      ],
                      IntervalSeconds: 2,
                      MaxAttempts: 3,
                      BackoffRate: 2,
                    },
                  ],
                  Catch: [
                    {
                      ErrorEquals: ['States.ALL'],
                      Next: 'CloudTrailFailed',
                      ResultPath: '$.error',
                    },
                  ],
                  End: true,
                },
                CloudTrailFailed: {
                  Type: 'Pass',
                  Parameters: { analyzer: 'cloudtrail', status: 'failed', 'error.$': '$.error' },
                  End: true,
                },
              },
            },
            {
              StartAt: 'CloudFormationAnalyzer',
              States: {
                CloudFormationAnalyzer: {
                  Type: 'Task',
                  Resource: cdk.Fn.getAtt(cloudformationAnalyzerLambda.logicalId, 'Arn').toString(),
                  // Match Lambda timeout so Step Functions fails fast if the
                  // task hangs. Kept in sync with the Lambda's timeout property.
                  TimeoutSeconds: cloudformationAnalyzerLambda.timeout,
                  Retry: [
                    {
                      ErrorEquals: [
                        'Lambda.ServiceException',
                        'Lambda.AWSLambdaException',
                        'Lambda.SdkClientException',
                        'Lambda.TooManyRequestsException',
                      ],
                      IntervalSeconds: 2,
                      MaxAttempts: 3,
                      BackoffRate: 2,
                    },
                  ],
                  Catch: [
                    {
                      ErrorEquals: ['States.ALL'],
                      Next: 'CloudFormationFailed',
                      ResultPath: '$.error',
                    },
                  ],
                  End: true,
                },
                CloudFormationFailed: {
                  Type: 'Pass',
                  Parameters: { analyzer: 'cloudformation', status: 'failed', 'error.$': '$.error' },
                  End: true,
                },
              },
            },
          ],
        },
        // Takes the parallel analyzer outputs plus the original input and
        // writes personalized used-capabilities-{scope}-{filterMode}.json
        // files to the website bucket, decorated with regional availability.
        DecorateUsage: {
          Type: 'Task',
          Resource: cdk.Fn.getAtt(usageDecoratorLambda.logicalId, 'Arn').toString(),
          TimeoutSeconds: usageDecoratorLambda.timeout,
          Retry: [
            {
              ErrorEquals: [
                'Lambda.ServiceException',
                'Lambda.AWSLambdaException',
                'Lambda.SdkClientException',
                'Lambda.TooManyRequestsException',
              ],
              IntervalSeconds: 2,
              MaxAttempts: 3,
              BackoffRate: 2,
            },
          ],
          Catch: [
            {
              ErrorEquals: ['States.ALL'],
              Next: 'DecorateUsageFailed',
              ResultPath: '$.decorateError',
            },
          ],
          End: true,
        },
        DecorateUsageFailed: {
          Type: 'Pass',
          Parameters: { step: 'decorate', status: 'failed', 'error.$': '$.decorateError' },
          End: true,
        },
      },
    };

    const stateMachine = new cdk.aws_stepfunctions.CfnStateMachine(this, `${prefix}AnalysisStateMachine`, {
      stateMachineName: `${prefix}AnalysisStateMachine`,
      roleArn: stateMachineRole.roleArn,
      definitionString: JSON.stringify(stateMachineDefinition),
    });

    // Scheduled rule to trigger the analysis state machine daily.
    //
    // Ensures account owners get refreshed personalized data without needing
    // to call POST /analysis manually. Mirrors the existing DataFetch schedule
    // pattern in the insights stack. Only wires a rule when a CloudTrail bucket
    // is configured, since cloudtrail is a required analyzer; if the bucket is
    // absent, scheduled runs would just fail at the analyzer step.
    const hasCloudTrailBucket = new cdk.CfnCondition(this, `${prefix}HasCloudTrailBucket`, {
      expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(cloudTrailBucketNameParameter.valueAsString, '')),
    });

    // Dedicated role so the rule can call states:StartExecution.
    //
    // Trust is scoped to EventBridge in *this* account only (SourceAccount),
    // and to a rule under this stack's events namespace (SourceArn). The
    // wildcard on the rule name avoids a circular CFN reference between the
    // role and rule; it's tight enough because (a) SourceAccount restricts
    // the assumer to our own account and (b) the role's policy below only
    // permits starting *this* state machine.
    const analysisScheduleRole = new iam.CfnRole(this, `${prefix}AnalysisScheduleRole`, {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'events.amazonaws.com' },
            Action: 'sts:AssumeRole',
            Condition: {
              StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
              ArnLike: {
                'aws:SourceArn': cdk.Fn.sub('arn:${AWS::Partition}:events:${AWS::Region}:${AWS::AccountId}:rule/*'),
              },
            },
          },
        ],
      },
      policies: [
        {
          policyName: 'InvokeStateMachine',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['states:StartExecution'],
                Resource: cdk.Fn.ref(stateMachine.logicalId),
              },
            ],
          },
        },
      ],
    });
    analysisScheduleRole.cfnOptions.condition = hasCloudTrailBucket;

    // Mirrors the POST /analysis input shape.
    const baseInput = JSON.stringify({
      scope: 'account',
      accounts: ['__ACCOUNTS__'],
      analyzers: ['cloudtrail', 'cloudformation'],
      cloudTrailBucket: '__BUCKET__',
      cloudTrailPrefix: 'AWSLogs/',
      daysToScan: '__DAYS__',
      websiteBucket: '__WEBSITE__',
      cloudtrailAnalyzerLambda: '__CT_LAMBDA__',
      cloudformationAnalyzerLambda: '__CF_LAMBDA__',
      resourceExplorerAnalyzerLambda: '',
    });
    const scheduledAnalysisInputTemplate = baseInput
      .replace('"__ACCOUNTS__"', '"${AccountId}"')
      .replace('"__BUCKET__"', '"${CloudTrailBucket}"')
      // Unquoted on both sides so the substituted value is a JSON number.
      .replace('"__DAYS__"', '${DaysToScan}')
      .replace('"__WEBSITE__"', '"${WebsiteBucket}"')
      .replace('"__CT_LAMBDA__"', '"${CloudTrailAnalyzerLambda}"')
      .replace('"__CF_LAMBDA__"', '"${CloudFormationAnalyzerLambda}"');

    const analysisScheduleRule = new events.CfnRule(this, `${prefix}AnalysisScheduleRule`, {
      description: `Daily trigger for ${prefix}AnalysisStateMachine.`,
      scheduleExpression: analysisScheduleParameter.valueAsString,
      state: 'ENABLED',
      targets: [
        {
          arn: cdk.Fn.ref(stateMachine.logicalId),
          id: 'AnalysisStateMachineTarget',
          roleArn: cdk.Fn.getAtt(analysisScheduleRole.logicalId, 'Arn').toString(),
          input: cdk.Fn.sub(scheduledAnalysisInputTemplate, {
            AccountId: cdk.Aws.ACCOUNT_ID,
            CloudTrailBucket: cloudTrailBucketNameParameter.valueAsString,
            DaysToScan: daysToScanParameter.valueAsString,
            WebsiteBucket: websiteBucketNameParameter.valueAsString,
            CloudTrailAnalyzerLambda: cloudtrailAnalyzerLambdaName,
            CloudFormationAnalyzerLambda: cloudformationAnalyzerLambdaName,
          }),
        },
      ],
    });
    analysisScheduleRule.cfnOptions.condition = hasCloudTrailBucket;

    // Outputs for cross-stack references
    new cdk.CfnOutput(this, UsageAnalysisStackOutputs.CloudTrailAnalyzerLambdaName, {
      value: cloudtrailAnalyzerLambdaName,
    });
    new cdk.CfnOutput(this, UsageAnalysisStackOutputs.CloudFormationAnalyzerLambdaName, {
      value: cloudformationAnalyzerLambdaName,
    });
    new cdk.CfnOutput(this, UsageAnalysisStackOutputs.UsageDecoratorLambdaName, {
      value: usageDecoratorLambdaName,
    });
    new cdk.CfnOutput(this, UsageAnalysisStackOutputs.AnalysisStateMachineArn, {
      value: cdk.Fn.ref(stateMachine.logicalId),
    });
    // Surfaced for the integration test runner so it can self-discover
    // which CloudTrail bucket the analyzers will read from. Construct id
    // can't reuse `CloudTrailBucketName` (already taken by the parameter).
    new cdk.CfnOutput(this, UsageAnalysisStackOutputs.ConfiguredCloudTrailBucketName, {
      value: cloudTrailBucketNameParameter.valueAsString,
    });
  }
}
