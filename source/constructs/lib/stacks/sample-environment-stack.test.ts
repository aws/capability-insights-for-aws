import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { afterAll, describe, expect, test } from 'vitest';
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

describe('SSH security group', () => {
  const groupName = 'CapabilityInsightsSampleEnvironmentVpcSSHSG';

  test('has no inbound rules when sshAllowedCidr is not set', () => {
    const stack = new CapabilityInsightsSampleEnvironmentStack(new App(), 'TestStack');
    Template.fromStack(stack).hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupName: groupName,
      SecurityGroupIngress: Match.absent(),
    });
  });

  test('only allows SSH from sshAllowedCidr', () => {
    const stack = new CapabilityInsightsSampleEnvironmentStack(new App(), 'TestStack', {
      sshAllowedCidr: '203.0.113.10/32',
    });
    Template.fromStack(stack).hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupName: groupName,
      SecurityGroupIngress: [{ IpProtocol: 'tcp', CidrIp: '203.0.113.10/32', FromPort: 22, ToPort: 22 }],
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
