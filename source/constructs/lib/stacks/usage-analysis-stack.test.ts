import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { afterAll, describe, expect, test } from 'vitest';
import { UsageAnalysisStack } from './usage-analysis-stack';

let snapshotFailed = false;

function makeStack(overrides: Partial<ConstructorParameters<typeof UsageAnalysisStack>[2]> = {}) {
  const app = new App();
  return new UsageAnalysisStack(app, 'TestUsageAnalysisStack', {
    websiteBucketName: 'test-website-bucket',
    websiteBucketArn: 'arn:aws:s3:::test-website-bucket',
    deploymentAssetsBucketName: 'test-deployment-bucket',
    lambdaCodeZipPath: 'lambdaAssets.zip',
    cloudTrailBucketName: 'test-trail-bucket',
    ...overrides,
  });
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

describe('usage decorator Lambda', () => {
  const stack = makeStack();
  const template = Template.fromStack(stack);

  test('sets INCLUDE_ALL_FEATURES_PER_SERVICE=true by default', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'CapabilityInsightsUsageDecorator',
      Environment: {
        Variables: Match.objectLike({
          INCLUDE_ALL_FEATURES_PER_SERVICE: 'true',
        }),
      },
    });
  });
});

describe('analysis state machine schedule', () => {
  const stack = makeStack();
  const template = Template.fromStack(stack);

  test('creates an EventBridge rule that triggers the state machine on the configured schedule', () => {
    // Conditional rule: only provisioned when a CloudTrail bucket is configured.
    // The test fixture above passes a non-empty bucket name so the rule is present.
    // Schedule expression is wired to the AnalysisSchedule CFN parameter so it
    // can be overridden per deploy without code changes.
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: { Ref: 'AnalysisSchedule' },
      State: 'ENABLED',
    });
  });

  test('exposes AnalysisSchedule parameter with rate(1 day) default', () => {
    template.hasParameter('AnalysisSchedule', {
      Type: 'String',
      Default: 'rate(1 day)',
    });
  });

  test('rule targets the analysis state machine with the schedule role', () => {
    template.hasResource('AWS::Events::Rule', {
      Properties: Match.objectLike({
        Targets: Match.arrayWith([
          Match.objectLike({
            Id: 'AnalysisStateMachineTarget',
            // RoleArn must point at the analysis schedule role specifically
            // (not, say, the lambda exec role). Tightens against a refactor
            // accidentally re-pointing the target.
            RoleArn: {
              'Fn::GetAtt': [Match.stringLikeRegexp('.*AnalysisScheduleRole.*'), 'Arn'],
            },
            Input: Match.anyValue(),
          }),
        ]),
      }),
    });
  });

  test('schedule role has states:StartExecution on the state machine', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'events.amazonaws.com' },
          }),
        ]),
      }),
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyName: 'InvokeStateMachine',
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Effect: 'Allow',
                Action: ['states:StartExecution'],
              }),
            ]),
          }),
        }),
      ]),
    });
  });

  test('schedule role trust policy is scoped to this account and an EventBridge rule', () => {
    // Locks in the SourceAccount + SourceArn conditions on the events
    // service-principal trust. Without this assertion, those conditions
    // could be silently removed in a future refactor and the looser
    // "events.amazonaws.com can assume this from any account" trust would
    // pass the other test above.
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Principal: { Service: 'events.amazonaws.com' },
            Condition: Match.objectLike({
              StringEquals: Match.objectLike({
                'aws:SourceAccount': Match.anyValue(),
              }),
              ArnLike: Match.objectLike({
                'aws:SourceArn': Match.anyValue(),
              }),
            }),
          }),
        ]),
      }),
    });
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
