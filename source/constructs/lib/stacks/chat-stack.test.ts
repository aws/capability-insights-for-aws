import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { afterAll, describe, expect, test } from 'vitest';
import { ChatStack } from './chat-stack';

let snapshotFailed = false;

function makeStack(overrides: Partial<ConstructorParameters<typeof ChatStack>[2]> = {}) {
  const app = new App();
  return new ChatStack(app, 'TestChatStack', { ...overrides });
}

test('CloudFormation template matches snapshot', () => {
  const stack = makeStack();
  try {
    expect(Template.fromStack(stack).toJSON()).toMatchSnapshot();
  } catch (e) {
    snapshotFailed = true;
    throw e;
  }
});

describe('Chat Lambda', () => {
  const stack = makeStack();
  const template = Template.fromStack(stack);

  test('is out-of-VPC (no VpcConfig — Bedrock has no VPC endpoint)', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    const chat = Object.values(fns).find(f => f.Properties?.Handler === 'chat-lambda-main.handler');
    expect(chat).toBeDefined();
    expect(chat?.Properties?.VpcConfig).toBeUndefined();
  });

  test('passes the Bedrock model id and website bucket as env vars', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'chat-lambda-main.handler',
      Environment: {
        Variables: Match.objectLike({
          BEDROCK_MODEL_ID: Match.anyValue(),
          WEBSITE_BUCKET_NAME: Match.anyValue(),
        }),
      },
    });
  });
});

describe('Chat Lambda role', () => {
  const stack = makeStack();
  const template = Template.fromStack(stack);

  test('grants bedrock invoke scoped to foundation models + inference profiles', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyName: 'ChatBedrockInvoke',
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Effect: 'Allow',
                Action: Match.arrayWith(['bedrock:InvokeModel', 'bedrock:Converse']),
              }),
            ]),
          },
        }),
      ]),
    });
  });

  test('grants NO write/mutation permissions (read-only s3, no dynamodb write, no iam)', () => {
    const roles = template.findResources('AWS::IAM::Role');
    const json = JSON.stringify(roles);
    expect(json).not.toContain('dynamodb:PutItem');
    expect(json).not.toContain('dynamodb:UpdateItem');
    expect(json).not.toContain('dynamodb:DeleteItem');
    expect(json).not.toContain('iam:CreatePolicy');
    expect(json).not.toContain('s3:PutObject');
  });
});

describe('preview_policy DynamoDB read is conditional', () => {
  test('the policy-table read policy is gated by the HasPolicyTable condition', () => {
    const stack = makeStack();
    const template = Template.fromStack(stack);
    const policies = template.findResources('AWS::IAM::Policy');
    const readPolicy = Object.values(policies).find(
      p => p.Properties?.PolicyName === 'CapabilityInsightsChatPolicyTableRead',
    );
    expect(readPolicy).toBeDefined();
    expect(readPolicy?.Condition).toBe('HasPolicyTable');
  });
});

describe('outputs', () => {
  const stack = makeStack();
  const template = Template.fromStack(stack);

  test('exports the Chat Lambda name', () => {
    template.hasOutput('ChatLambdaName', {});
  });
});

afterAll(() => {
  if (snapshotFailed) {
    console.error(
      '\n📸 Snapshot mismatch! If this change is intentional, update with:\n' +
        '   npm run test:update-snapshot --workspace=source/constructs\n',
    );
  }
});
