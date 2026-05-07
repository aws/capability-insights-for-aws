import * as cdk from 'aws-cdk-lib';
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
}

export enum UsageAnalysisStackOutputs {
  CloudTrailAnalyzerLambdaName = 'CloudTrailAnalyzerLambdaName',
  CloudFormationAnalyzerLambdaName = 'CloudFormationAnalyzerLambdaName',
  AnalysisStateMachineArn = 'AnalysisStateMachineArn',
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
      Comment: 'Analysis workflow for CloudTrail, Resource Explorer, and CloudFormation',
      StartAt: 'ParallelAnalyzers',
      States: {
        ParallelAnalyzers: {
          Type: 'Parallel',
          End: true,
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
      },
    };

    const stateMachine = new cdk.aws_stepfunctions.CfnStateMachine(this, `${prefix}AnalysisStateMachine`, {
      stateMachineName: `${prefix}AnalysisStateMachine`,
      roleArn: stateMachineRole.roleArn,
      definitionString: JSON.stringify(stateMachineDefinition),
    });

    // Outputs for cross-stack references
    new cdk.CfnOutput(this, UsageAnalysisStackOutputs.CloudTrailAnalyzerLambdaName, {
      value: cloudtrailAnalyzerLambdaName,
    });
    new cdk.CfnOutput(this, UsageAnalysisStackOutputs.CloudFormationAnalyzerLambdaName, {
      value: cloudformationAnalyzerLambdaName,
    });
    new cdk.CfnOutput(this, UsageAnalysisStackOutputs.AnalysisStateMachineArn, {
      value: cdk.Fn.ref(stateMachine.logicalId),
    });
  }
}
