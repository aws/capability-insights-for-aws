import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { afterAll, describe, expect, test } from 'vitest';
import { CapabilityInsightsStack } from './capability-insights-stack';

let snapshotFailed = false;

test('CloudFormation template matches snapshot', () => {
  const app = new App();
  const stack = new CapabilityInsightsStack(app, 'TestStack');
  try {
    expect(Template.fromStack(stack).toJSON()).toMatchSnapshot();
  } catch (e) {
    snapshotFailed = true;
    throw e;
  }
});

describe('API Lambda role', () => {
  const app = new App();
  const stack = new CapabilityInsightsStack(app, 'TestStack-IAM');
  const template = Template.fromStack(stack);

  test('has Organizations read access policy', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyName: 'OrganizationsReadAccess',
          PolicyDocument: {
            Statement: [
              {
                Effect: 'Allow',
                Action: ['organizations:ListAccounts', 'organizations:DescribeOrganization'],
                Resource: '*',
              },
            ],
          },
        }),
      ]),
    });
  });

  test('has Step Functions access policy', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyName: 'StepFunctionsAccess',
          PolicyDocument: {
            Statement: [
              {
                Effect: 'Allow',
                Action: ['states:StartExecution', 'states:DescribeExecution'],
              },
            ],
          },
        }),
      ]),
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
