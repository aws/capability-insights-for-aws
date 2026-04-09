import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { afterAll, expect, test } from 'vitest';
import { CapabilityInsightsSampleEnvironmentStack } from './sample-environment-stack';

let snapshotFailed = false;

test('CloudFormation template matches snapshot', () => {
  const app = new App();
  const stack = new CapabilityInsightsSampleEnvironmentStack(app, 'TestStack');
  try {
    expect(Template.fromStack(stack).toJSON()).toMatchSnapshot();
  } catch (e) {
    snapshotFailed = true;
    throw e;
  }
});

afterAll(() => {
  if (snapshotFailed) {
    console.error(
      '\n📸 Snapshot mismatch! If this change is intentional, update with:\n' +
        '   npm run test:update-snapshot --workspace=source/constructs\n',
    );
  }
});
