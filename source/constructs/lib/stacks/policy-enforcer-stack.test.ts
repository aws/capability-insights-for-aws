import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { afterAll, describe, expect, test } from 'vitest';
import { PolicyEnforcerStack } from './policy-enforcer-stack';

let snapshotFailed = false;

function makeStack(overrides: Partial<ConstructorParameters<typeof PolicyEnforcerStack>[2]> = {}) {
  const app = new App();
  return new PolicyEnforcerStack(app, 'TestPolicyEnforcerStack', {
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

describe('PolicyConfiguration table', () => {
  const stack = makeStack();
  const template = Template.fromStack(stack);

  test('uses PAY_PER_REQUEST billing', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('has SSE and PITR enabled', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      SSESpecification: { SSEEnabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  test('uses (accountId, policyName) as the composite primary key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'accountId', KeyType: 'HASH' },
        { AttributeName: 'policyName', KeyType: 'RANGE' },
      ],
    });
  });

  test('does not declare any GSIs (single-table primary-key Query is sufficient)', () => {
    const props = template.findResources('AWS::DynamoDB::Table');
    const tableProps = Object.values(props)[0].Properties;
    expect(tableProps.GlobalSecondaryIndexes).toBeUndefined();
  });
});

describe('outputs', () => {
  const stack = makeStack();
  const template = Template.fromStack(stack);

  test('exports the table name', () => {
    template.hasOutput('PolicyTableName', {
      Export: { Name: 'CapabilityInsightsPolicyTableName' },
    });
  });

  test('exports the table ARN', () => {
    template.hasOutput('PolicyTableArn', {
      Export: { Name: 'CapabilityInsightsPolicyTableArn' },
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
