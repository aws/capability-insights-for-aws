import * as cdk from 'aws-cdk-lib';
import * as api from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';

export interface CapabilityInsightsStackProps extends cdk.StackProps {
  privateVpcId?: string;
  backendSubnetId?: string;
  apiAccessSubnetId?: string;
  deploymentAssetsBucketName?: string;
  sourceAccessPointArn?: string;
  sourceFolders?: string;
}

export class CapabilityInsightsStack extends cdk.Stack {
  constructor(app: cdk.App, id: string, props?: CapabilityInsightsStackProps) {
    super(app, id, props);

    const prefix = 'CapabilityInsights';

    const vpcIdParameter = new cdk.CfnParameter(this, 'PrivateVpcId', {
      type: 'AWS::EC2::VPC::Id',
      description:
        'ID of VPC from where the Capability Insights website (hosted on S3 bucket) will be accessible from.',
      default: props?.privateVpcId,
    });
    const privateSubnetIdParameter = new cdk.CfnParameter(this, 'BackendSubnetId', {
      type: 'AWS::EC2::Subnet::Id',
      description: 'ID of subnet (ideally a private subnet) where the Lambda function will be running.',
      default: props?.backendSubnetId,
    });
    const publicSubnetIdParameter = new cdk.CfnParameter(this, 'ApiAccessSubnetId', {
      type: 'AWS::EC2::Subnet::Id',
      description:
        'ID of Subnet where users will browse Capability Insights website from, calls to back-end API will come from here. A VPC Endpoint to API Gateway will be created in this subnet to enable this.',
      default: props?.apiAccessSubnetId,
    });
    const deploymentAssetsBucketNameParameter = new cdk.CfnParameter(this, 'DeploymentAssetsBucketName', {
      type: 'String',
      description: 'Name of S3 bucket where Capability Insights deployment assets will be located.',
      default: props?.deploymentAssetsBucketName,
    });
    const deploymentAssetsBucketApiLambdaFunctionCodeZipPathParameter = new cdk.CfnParameter(
      this,
      'DeploymentAssetsBucketApiLambdaFunctionCodeZipPath',
      {
        type: 'String',
        description:
          "Path in the CapabilityInsights deployment assets bucket where Capability Insights's API Lambda function code zip is located.",
        default: 'lambdaAssets.zip',
      },
    );
    const sourceAccessPointArnParameter = new cdk.CfnParameter(this, 'SourceAccessPointArn', {
      type: 'String',
      description: 'ARN of the S3 access point that provides the capability data source.',
      default: props?.sourceAccessPointArn,
    });
    const sourceFoldersParameter = new cdk.CfnParameter(this, 'SourceFolders', {
      type: 'String',
      description: 'Comma-separated list of folder names in the S3 access point to fetch data from.',
      default: props?.sourceFolders ?? 'public',
      allowedPattern: '^[a-zA-Z0-9_-]+(,[a-zA-Z0-9_-]+)*$',
      constraintDescription:
        'Must be a comma-separated list of folder names (letters, numbers, hyphens, underscores). No spaces or trailing commas.',
    });

    // Website bucket name: "capability-insights-website-{account}-{region}"
    // Also referenced in: deployment/deploy.sh, deployment/dev.sh, README.md
    const websiteBucketResourceName = `capability-insights-website`;
    const websiteBucketNameFn = cdk.Fn.sub('capability-insights-website-${AWS::AccountId}-${AWS::Region}');
    const websiteBucket = new s3.CfnBucket(this, websiteBucketResourceName, {
      bucketName: websiteBucketNameFn,
      publicAccessBlockConfiguration: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      websiteConfiguration: {
        indexDocument: 'index.html',
        errorDocument: 'index.html',
      },
      bucketEncryption: {
        serverSideEncryptionConfiguration: [
          {
            serverSideEncryptionByDefault: {
              sseAlgorithm: 'AES256',
            },
          },
        ],
      },
    });
    new s3.CfnBucketPolicy(this, `${websiteBucketResourceName}-Policy`, {
      bucket: websiteBucket.ref,
      policyDocument: {
        Statement: [
          {
            Sid: 'AllowVPCEndpointAccess',
            Effect: 'Allow',
            Principal: '*',
            Action: 's3:GetObject',
            Resource: [
              cdk.Fn.getAtt(websiteBucket.logicalId, 'Arn').toString(),
              cdk.Fn.sub('${BucketArn}/*', {
                BucketArn: cdk.Fn.getAtt(websiteBucket.logicalId, 'Arn').toString(),
              }),
            ],
            Condition: {
              StringEquals: {
                'aws:SourceVpc': vpcIdParameter.valueAsString,
              },
            },
          },
        ],
      },
    });

    // API Gateway
    const apigwName = `${prefix}ApiGw`;
    const apigwSecurityGroup = new ec2.CfnSecurityGroup(this, `${prefix}ApiGwSecurityGroup`, {
      groupName: `${prefix}ApiGwSecurityGroup`,
      groupDescription: `Security Group for ${prefix} API Gateway`,
      vpcId: vpcIdParameter.valueAsString,
      securityGroupIngress: [
        {
          ipProtocol: 'tcp',
          fromPort: 443,
          toPort: 443,
          cidrIp: '0.0.0.0/0',
        },
      ],
    });

    const vpcApigwEndpoint = new ec2.CfnVPCEndpoint(this, `${prefix}ApiGwVpcEndpoint`, {
      vpcId: vpcIdParameter.valueAsString,
      vpcEndpointType: 'Interface',
      serviceName: cdk.Fn.sub('com.amazonaws.${AWS::Region}.execute-api'),
      privateDnsEnabled: true,
      subnetIds: [publicSubnetIdParameter.valueAsString],
      securityGroupIds: [apigwSecurityGroup.ref],
      tags: [{ key: 'Name', value: `${prefix}ApiGwVpcEndpoint` }],
    });

    // Allows the API Lambda (in the private subnet) to invoke other Lambda functions
    // via the AWS Lambda service API without needing internet access.
    new ec2.CfnVPCEndpoint(this, `${prefix}LambdaVpcEndpoint`, {
      vpcId: vpcIdParameter.valueAsString,
      vpcEndpointType: 'Interface',
      serviceName: cdk.Fn.sub('com.amazonaws.${AWS::Region}.lambda'),
      privateDnsEnabled: true,
      subnetIds: [privateSubnetIdParameter.valueAsString],
      securityGroupIds: [apigwSecurityGroup.ref],
      tags: [{ key: 'Name', value: `${prefix}LambdaVpcEndpoint` }],
    });

    const apigw = new api.CfnRestApi(this, apigwName, {
      name: apigwName,
      description: 'Private REST API for Capability Insights',
      endpointConfiguration: {
        types: ['PRIVATE'],
        vpcEndpointIds: [vpcApigwEndpoint.ref],
      },
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: '*',
            Action: 'execute-api:Invoke',
            Resource: '*',
            Condition: {
              StringEquals: {
                'aws:SourceVpce': vpcApigwEndpoint.ref,
              },
            },
          },
        ],
      },
    });

    // Data Fetch Lambda
    const dataFetchLambdaName = `${prefix}DataFetchLambda`;
    const dataFetchLambdaRoleName = `${prefix}DataFetchLambdaRole`;
    const dataFetchLambdaRoleNameFn = cdk.Fn.sub(`${dataFetchLambdaRoleName}-\${AWS::Region}`);
    const dataFetchLambdaRole = new iam.CfnRole(this, dataFetchLambdaRoleName, {
      roleName: dataFetchLambdaRoleNameFn,
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: 'lambda.amazonaws.com',
            },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      managedPolicyArns: [cdk.Fn.sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')],
      policies: [
        {
          policyName: 'S3ReadWritePolicy',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['s3:GetObject'],
                Resource: '*',
                Condition: {
                  StringEquals: {
                    's3:DataAccessPointAccount': cdk.Fn.select(
                      4,
                      cdk.Fn.split(':', sourceAccessPointArnParameter.valueAsString),
                    ),
                  },
                },
              },
              {
                Effect: 'Allow',
                Action: ['s3:PutObject'],
                Resource: cdk.Fn.sub('${BucketArn}/data/*', {
                  BucketArn: cdk.Fn.getAtt(websiteBucket.logicalId, 'Arn').toString(),
                }),
              },
            ],
          },
        },
      ],
    });
    const dataFetchLambdaFunction = new lambda.CfnFunction(this, dataFetchLambdaName, {
      functionName: dataFetchLambdaName,
      runtime: 'nodejs24.x',
      role: cdk.Fn.getAtt(dataFetchLambdaRole.logicalId, 'Arn').toString(),
      handler: 'data-fetch-lambda-main.handler',
      memorySize: 2048,
      timeout: 120,
      code: {
        s3Bucket: deploymentAssetsBucketNameParameter.valueAsString,
        s3Key: deploymentAssetsBucketApiLambdaFunctionCodeZipPathParameter.valueAsString,
      },
      environment: {
        variables: {
          DATA_BUCKET_NAME: cdk.Fn.ref(websiteBucket.logicalId),
          DATA_BUCKET_PATH: 'data',
          SOURCE_ACCESS_POINT_ARN: sourceAccessPointArnParameter.valueAsString,
          SOURCE_FOLDERS: sourceFoldersParameter.valueAsString,
        },
      },
    });
    const dataFetchLambdaScheduleRule = new events.CfnRule(this, `${prefix}DataFetchLambdaScheduleRule`, {
      description: `Daily trigger for ${dataFetchLambdaName} lambda function.`,
      scheduleExpression: 'rate(1 day)',
      state: 'ENABLED',
      targets: [
        {
          arn: cdk.Fn.getAtt(dataFetchLambdaFunction.logicalId, 'Arn').toString(),
          id: 'ScheduledLambdaTarget',
        },
      ],
    });
    new lambda.CfnPermission(this, `${prefix}DataFetchLambdaInvokePermission`, {
      functionName: cdk.Fn.ref(dataFetchLambdaFunction.logicalId),
      action: 'lambda:InvokeFunction',
      principal: 'events.amazonaws.com',
      sourceArn: cdk.Fn.getAtt(dataFetchLambdaScheduleRule.logicalId, 'Arn').toString(),
    });

    // API Lambda
    const apiLambdaName = `${prefix}ApiLambda`;
    const apiLambdaSecurityGroup = new ec2.CfnSecurityGroup(this, `${prefix}ApiLambdaSecurityGroup`, {
      groupDescription: `Security group for ${prefix} API Lambda`,
      vpcId: vpcIdParameter.valueAsString,
      securityGroupEgress: [
        {
          ipProtocol: '-1',
          cidrIp: '0.0.0.0/0',
        },
      ],
    });
    const apiLambdaRoleName = `${prefix}ApiLambdaRole`;
    const apiLambdaRoleNameFn = cdk.Fn.sub(`${apiLambdaRoleName}-\${AWS::Region}`);
    const apiLambdaRole = new iam.CfnRole(this, apiLambdaRoleName, {
      roleName: apiLambdaRoleNameFn,
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: 'lambda.amazonaws.com',
            },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      managedPolicyArns: [
        cdk.Fn.sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
      policies: [
        {
          policyName: 'LambdaLogging',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                Resource: cdk.Fn.sub(
                  'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/${FunctionName}:*',
                  { FunctionName: apiLambdaName },
                ),
              },
            ],
          },
        },
        {
          policyName: 'InvokeDataFetchLambda',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: 'lambda:InvokeFunction',
                Resource: cdk.Fn.sub(
                  'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:${FunctionName}',
                  { FunctionName: dataFetchLambdaName },
                ),
              },
            ],
          },
        },
      ],
    });
    const apiLambdaFunction = new lambda.CfnFunction(this, apiLambdaName, {
      functionName: apiLambdaName,
      runtime: 'nodejs24.x',
      handler: 'api-lambda-main.handler',
      role: cdk.Fn.getAtt(apiLambdaRole.logicalId, 'Arn').toString(),
      code: {
        s3Bucket: deploymentAssetsBucketNameParameter.valueAsString,
        s3Key: deploymentAssetsBucketApiLambdaFunctionCodeZipPathParameter.valueAsString,
      },
      vpcConfig: {
        securityGroupIds: [apiLambdaSecurityGroup.ref],
        subnetIds: [privateSubnetIdParameter.valueAsString],
      },
      timeout: 60, // 1 min
      environment: {
        variables: {
          WEBSITE_BUCKET_NAME: cdk.Fn.ref(websiteBucket.logicalId),
          DATA_FETCH_LAMBDA_NAME: dataFetchLambdaName,
        },
      },
    });
    new lambda.CfnPermission(this, `${prefix}ApiLambdaInvokePermission`, {
      functionName: apiLambdaFunction.ref,
      action: 'lambda:InvokeFunction',
      principal: 'apigateway.amazonaws.com',
      sourceArn: cdk.Fn.sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*', {
        ApiId: apigw.attrRestApiId,
      }),
    });

    // API Gateway proxy resource — routes all requests to Lambda
    const apigwProxyResource = new api.CfnResource(this, `${prefix}ApiGwProxyResource`, {
      restApiId: apigw.ref,
      parentId: cdk.Fn.getAtt(apigw.logicalId, 'RootResourceId').toString(),
      pathPart: '{proxy+}',
    });
    const apigwProxyMethod = new api.CfnMethod(this, `${prefix}ApiGwProxyMethod`, {
      restApiId: apigw.attrRestApiId,
      resourceId: apigwProxyResource.ref,
      httpMethod: 'ANY',
      authorizationType: 'NONE',
      integration: {
        type: 'AWS_PROXY',
        integrationHttpMethod: 'POST',
        uri: cdk.Fn.sub(
          'arn:${AWS::Partition}:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${LambdaArn}/invocations',
          {
            LambdaArn: cdk.Fn.getAtt(apiLambdaFunction.logicalId, 'Arn').toString(),
          },
        ),
      },
    });
    const apigwProxyOptionsMethod = new api.CfnMethod(this, `${prefix}ApiGwProxyOptionsMethod`, {
      restApiId: apigw.attrRestApiId,
      resourceId: apigwProxyResource.ref,
      httpMethod: 'OPTIONS',
      authorizationType: 'NONE',
      integration: {
        type: 'MOCK',
        requestTemplates: {
          'application/json': '{"statusCode": 200}',
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseParameters: {
              'method.response.header.Access-Control-Allow-Headers':
                "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
              'method.response.header.Access-Control-Allow-Methods': "'GET,POST,PUT,DELETE,OPTIONS'",
              'method.response.header.Access-Control-Allow-Origin': "'*'",
            },
            responseTemplates: {
              'application/json': '',
            },
          },
        ],
      },
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Headers': true,
            'method.response.header.Access-Control-Allow-Methods': true,
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
      ],
    });
    const apiDeployment = new api.CfnDeployment(this, `${prefix}ApiGwDeployment`, {
      restApiId: apigw.attrRestApiId,
      description: `Deployment for ${prefix} API Gateway`,
    });
    apiDeployment.addDependency(apigwProxyMethod);
    apiDeployment.addDependency(apigwProxyOptionsMethod);

    // API Gateway Logging
    // Only need one of these per account to enable API gateway logging
    const apiGwCloudWatchLogsRoleNameFn = cdk.Fn.sub(`${prefix}ApiGwCloudWatchLogsRole-\${AWS::Region}`);
    const apiGwCloudWatchLogsRole = new iam.CfnRole(this, `${prefix}ApiGwCloudWatchLogsRole`, {
      roleName: apiGwCloudWatchLogsRoleNameFn,
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: 'apigateway.amazonaws.com',
            },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      managedPolicyArns: [
        cdk.Fn.sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs'),
      ],
    });
    const apiGwAccount = new api.CfnAccount(this, `${prefix}ApiGwAccount`, {
      cloudWatchRoleArn: cdk.Fn.getAtt(apiGwCloudWatchLogsRole.logicalId, 'Arn').toString(),
    });
    apiGwAccount.addDependency(apiGwCloudWatchLogsRole);
    const apiAccessLogGroup = new logs.CfnLogGroup(this, `${prefix}ApiGwAccessLogGroup`, {
      logGroupName: cdk.Fn.sub('/aws/apigateway/${ApiId}/access-logs', {
        ApiId: apigw.attrRestApiId,
      }),
      retentionInDays: 30,
    });
    // CloudWatch Log Group for API Execution Logs
    new cdk.aws_logs.CfnLogGroup(this, `${prefix}ApiGwExecutionLogGroup`, {
      logGroupName: cdk.Fn.sub('API-Gateway-Execution-Logs_${ApiId}/prod', {
        ApiId: apigw.attrRestApiId,
      }),
      retentionInDays: 30,
    });
    // API Stage with CloudWatch Logging
    const apiStage = new api.CfnStage(this, `${prefix}ApiGwStage`, {
      restApiId: apigw.attrRestApiId,
      deploymentId: apiDeployment.attrDeploymentId,
      stageName: 'prod',
      description: 'Production stage with CloudWatch logging',
      methodSettings: [
        {
          resourcePath: '/*',
          httpMethod: '*',
          loggingLevel: 'INFO',
          dataTraceEnabled: false,
          metricsEnabled: true,
        },
      ],
      accessLogSetting: {
        destinationArn: cdk.Fn.getAtt(apiAccessLogGroup.logicalId, 'Arn').toString(),
        format:
          '$context.requestId $context.extendedRequestId $context.identity.sourceIp $context.requestTime $context.routeKey $context.status',
      },
    });
    apiStage.addDependency(apiGwAccount);

    // Write Config Lambda — writes the API Gateway URL to S3 as api-config.json
    const writeConfigLambdaName = `${prefix}WriteConfigLambda`;
    const writeConfigLambdaRoleName = `${prefix}WriteConfigLambdaRole`;
    const writeConfigLambdaRoleNameFn = cdk.Fn.sub(`${writeConfigLambdaRoleName}-\${AWS::Region}`);
    const writeConfigLambdaRole = new iam.CfnRole(this, writeConfigLambdaRoleName, {
      roleName: writeConfigLambdaRoleNameFn,
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: 'lambda.amazonaws.com',
            },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      managedPolicyArns: [cdk.Fn.sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')],
      policies: [
        {
          policyName: 'S3WriteAccess',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['s3:PutObject'],
                Resource: cdk.Fn.sub(
                  'arn:${AWS::Partition}:s3:::capability-insights-website-${AWS::AccountId}-${AWS::Region}/*',
                ),
              },
            ],
          },
        },
      ],
    });

    const writeConfigLambdaFunction = new cdk.aws_lambda.CfnFunction(this, writeConfigLambdaName, {
      functionName: writeConfigLambdaName,
      runtime: 'python3.11',
      handler: 'index.lambda_handler',
      role: cdk.Fn.getAtt(writeConfigLambdaRole.logicalId, 'Arn').toString(),
      code: {
        zipFile: `import json
import boto3
import cfnresponse

s3 = boto3.client('s3')

def lambda_handler(event, context):
    try:
        if event['RequestType'] == 'Delete':
            cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
            return
        
        bucket = event['ResourceProperties']['Bucket']
        api_url = event['ResourceProperties']['ApiUrl']
        
        config = {
            'apiBaseUrl': api_url
        }
        
        s3.put_object(
            Bucket=bucket,
            Key='api-config.json',
            Body=json.dumps(config),
            ContentType='application/json'
        )
        
        cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
    except Exception as e:
        print(f"Error: {str(e)}")
        cfnresponse.send(event, context, cfnresponse.FAILED, {})`,
      },
      timeout: 30, // 30 seconds
    });
    // Custom Resource to invoke the Lambda function
    const writeConfigCustomResource = new cdk.CfnCustomResource(this, `${prefix}WriteConfigLambdaCustomResource`, {
      serviceToken: cdk.Fn.getAtt(writeConfigLambdaFunction.logicalId, 'Arn').toString(),
    });
    writeConfigCustomResource.addPropertyOverride('Bucket', websiteBucketNameFn);
    writeConfigCustomResource.addPropertyOverride(
      'ApiUrl',
      cdk.Fn.sub('https://${ApiId}.execute-api.${AWS::Region}.amazonaws.com/prod', {
        ApiId: apigw.attrRestApiId,
      }),
    );
  }
}
