import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

export interface ChatStackProps extends cdk.StackProps {
  /** S3 bucket containing the Lambda code zip. */
  deploymentAssetsBucketName?: string;
  /** Path within the deployment assets bucket to the Lambda code zip. */
  lambdaCodeZipPath?: string;
  /** Website bucket the Chat Lambda reads the catalog + sync metadata from. */
  websiteBucketName?: string;
  /** Policy Enforcer DynamoDB table name, if Policy Enforcer is also deployed (enables preview_policy). */
  policyTableName?: string;
  /**
   * Bedrock model id (or cross-region inference profile id, e.g.
   * `us.anthropic.claude-haiku-4-5-20251001-v1:0`) the agent invokes.
   * Models reach end-of-life over time; override via --bedrock-model-id when
   * the default is retired.
   */
  bedrockModelId?: string;
}

export enum ChatStackOutputs {
  ChatLambdaName = 'ChatLambdaName',
  BedrockModelId = 'BedrockModelId',
}

/**
 * Optional Chat stack — the conversational capability-insights assistant.
 *
 * Owns a single out-of-VPC Chat Lambda that runs the Bedrock agent loop.
 * It is OUT of the VPC because Bedrock has no VPC endpoint in this app's
 * topology (the in-VPC API Lambda would time out calling Bedrock — the same
 * constraint that puts the Policy Enforcer IAM helper out-of-VPC). The in-VPC
 * API Lambda's `POST /chat` route invokes this Lambda synchronously.
 *
 * The Lambda's role is narrowly scoped: Bedrock invoke on the configured model
 * + inference profile, read-only S3 on the website bucket (catalog/sync), and
 * — only when Policy Enforcer is also deployed — read access to the policy
 * table for the `preview_policy` dry run. It has NO write/mutation permissions:
 * the agent can only PROPOSE writes, which the browser confirms against the
 * existing gated Policy Enforcer routes.
 *
 * Wiring to the API Lambda (env var `CHAT_LAMBDA_NAME` + permission to invoke
 * this Lambda) is added on the main stack when `--enable-chat` is set.
 *
 * NOTE: Bedrock + Anthropic Claude must be available in the deploy region.
 * In GovCloud / sovereign / ADC / isolated partitions this is unavailable;
 * leave the feature off there (the API Lambda's /chat returns 503 and the UI
 * hides the assistant — graceful degradation, no hard failure).
 */
export class ChatStack extends cdk.Stack {
  public readonly chatLambdaName: string;
  public readonly bedrockModelId: string;

  constructor(app: cdk.App, id: string, props?: ChatStackProps) {
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

    const websiteBucketNameParameter = new cdk.CfnParameter(this, 'WebsiteBucketName', {
      type: 'String',
      description:
        'Website bucket the Chat Lambda reads the catalog (regions/products/apis/cfn) and sync metadata from.',
      default: props?.websiteBucketName,
    });

    const policyTableNameParameter = new cdk.CfnParameter(this, 'PolicyTableName', {
      type: 'String',
      description:
        'Policy Enforcer DynamoDB table name. Leave empty if Policy Enforcer is not deployed; preview_policy is then unavailable.',
      default: props?.policyTableName ?? '',
    });

    const bedrockModelIdParameter = new cdk.CfnParameter(this, 'BedrockModelId', {
      type: 'String',
      description:
        'Bedrock model id or cross-region inference profile id the agent invokes (e.g. us.anthropic.claude-haiku-4-5-20251001-v1:0).',
      default: props?.bedrockModelId ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    });

    const hasPolicyTable = new cdk.CfnCondition(this, 'HasPolicyTable', {
      expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(policyTableNameParameter.valueAsString, '')),
    });

    const chatLambdaName = `${prefix}Chat`;
    this.chatLambdaName = chatLambdaName;
    this.bedrockModelId = bedrockModelIdParameter.valueAsString;

    const chatRole = new iam.Role(this, `${chatLambdaName}Role`, {
      // Logical ID pinned below so the hardcoded physical name stays stable.
      roleName: cdk.Fn.sub(`${chatLambdaName}Role-\${AWS::Region}`),
      description:
        'Execution role for the Capability Insights Chat Lambda. Bedrock invoke + read-only catalog/policy access.',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      inlinePolicies: {
        ChatBedrockInvoke: new iam.PolicyDocument({
          statements: [
            // Invoke the configured model + the cross-region inference profile
            // (and the underlying foundation models the profile routes to).
            new iam.PolicyStatement({
              actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
                'bedrock:Converse',
                'bedrock:ConverseStream',
              ],
              resources: [
                cdk.Fn.sub('arn:${AWS::Partition}:bedrock:*::foundation-model/*'),
                cdk.Fn.sub('arn:${AWS::Partition}:bedrock:${AWS::Region}:${AWS::AccountId}:inference-profile/*'),
              ],
            }),
            // Read-only catalog + sync metadata from the website bucket.
            new iam.PolicyStatement({
              actions: ['s3:GetObject'],
              resources: [
                cdk.Fn.sub('arn:${AWS::Partition}:s3:::${WebsiteBucket}/*', {
                  WebsiteBucket: websiteBucketNameParameter.valueAsString,
                }),
              ],
            }),
          ],
        }),
      },
    });
    (chatRole.node.defaultChild as cdk.CfnElement).overrideLogicalId(`${chatLambdaName}Role`);

    // Read-only access to the policy table for preview_policy — only when
    // Policy Enforcer is deployed. Attached conditionally so the role grants
    // nothing extra in chat-only deployments.
    const policyReadPolicy = new iam.CfnPolicy(this, `${chatLambdaName}PolicyTableRead`, {
      policyName: `${chatLambdaName}PolicyTableRead`,
      roles: [chatRole.roleName],
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['dynamodb:GetItem', 'dynamodb:Query'],
            Resource: cdk.Fn.sub('arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${TableName}', {
              TableName: policyTableNameParameter.valueAsString,
            }),
          },
        ],
      },
    });
    policyReadPolicy.cfnOptions.condition = hasPolicyTable;

    new lambda.CfnFunction(this, chatLambdaName, {
      functionName: chatLambdaName,
      runtime: 'nodejs24.x',
      handler: 'chat-lambda-main.handler',
      role: chatRole.roleArn,
      code: {
        s3Bucket: deploymentAssetsBucketNameParameter.valueAsString,
        s3Key: lambdaCodeZipPathParameter.valueAsString,
      },
      memorySize: 512,
      // The synchronous call chain is browser -> REST API Gateway -> in-VPC API
      // Lambda (invokeSync) -> this Lambda. REST API Gateway caps integration at
      // 29s, so a turn that runs longer returns a 504 to the browser regardless
      // of this value. Cap the Lambda at 29s too so it dies WITH the gateway
      // rather than burning compute up to 60s on a request the client already
      // abandoned. The agent's MAX_TURNS bounds the common case well under this;
      // the timeout is the hard backstop for a pathologically slow turn. Watch
      // the ChatLatency / MaxTurnsHit EMF metrics to tune MAX_TURNS if needed.
      timeout: 29,
      environment: {
        variables: {
          WEBSITE_BUCKET_NAME: websiteBucketNameParameter.valueAsString,
          BEDROCK_MODEL_ID: bedrockModelIdParameter.valueAsString,
          POLICY_TABLE_NAME: policyTableNameParameter.valueAsString,
        },
      },
    });

    new cdk.CfnOutput(this, ChatStackOutputs.ChatLambdaName, {
      value: chatLambdaName,
      description: 'Name of the out-of-VPC Chat Lambda the API Lambda invokes for POST /chat.',
      exportName: `${prefix}ChatLambdaName`,
    });

    new cdk.CfnOutput(this, `${ChatStackOutputs.BedrockModelId}Output`, {
      value: bedrockModelIdParameter.valueAsString,
      description: 'Bedrock model/inference-profile id the Chat Lambda invokes.',
      exportName: `${prefix}BedrockModelId`,
    });
  }
}
