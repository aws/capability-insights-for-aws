import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { PolicyConfigStore, PolicyNameConflictError, PolicyNotFoundError } from './policy-config-store';

const ddbMock = mockClient(DynamoDBDocumentClient);

const ACCOUNT_ID = '123456789012';
const TABLE = 'CapabilityInsightsPolicyConfiguration';

const makeStore = () => new PolicyConfigStore(TABLE, ACCOUNT_ID);

beforeEach(() => {
  ddbMock.reset();
});

describe('createPolicy', () => {
  it('writes a single item with a conditional name-uniqueness check', async () => {
    ddbMock.on(PutCommand).resolves({});

    const store = makeStore();
    const policy = await store.createPolicy({
      policyName: 'Payments',
      regions: ['us-east-1'],
      mode: 'intersection',
      policyType: 'IAM',
    });

    expect(policy.policyName).toBe('Payments');
    expect(policy.status).toBe('pending');

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.TableName).toBe(TABLE);
    expect(input.ConditionExpression).toBe('attribute_not_exists(policyName)');
    expect(input.Item).toMatchObject({
      accountId: ACCOUNT_ID,
      policyName: 'Payments',
      status: 'pending',
    });
  });

  it('throws PolicyNameConflictError when the name is already taken', async () => {
    ddbMock.on(PutCommand).rejects({ name: 'ConditionalCheckFailedException' });

    const store = makeStore();
    await expect(
      store.createPolicy({
        policyName: 'Payments',
        regions: ['us-east-1'],
        mode: 'intersection',
        policyType: 'IAM',
      }),
    ).rejects.toBeInstanceOf(PolicyNameConflictError);
  });
});

describe('getPolicy', () => {
  it('returns null when the item is missing', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(await makeStore().getPolicy('missing')).toBeNull();
  });

  it('keys on (accountId, policyName)', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        accountId: ACCOUNT_ID,
        policyName: 'Payments',
        tags: [],
        regions: ['us-east-1'],
        mode: 'intersection',
        policyType: 'IAM',
        exceptions: [],
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    });

    const result = await makeStore().getPolicy('Payments');

    expect(result?.policyName).toBe('Payments');
    expect(ddbMock.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({
      accountId: ACCOUNT_ID,
      policyName: 'Payments',
    });
  });
});

describe('listPolicies', () => {
  const samplePolicy = (overrides: Record<string, unknown> = {}) => ({
    accountId: ACCOUNT_ID,
    policyName: 'Payments',
    tags: [{ key: 'team', value: 'core' }],
    regions: ['us-east-1'],
    mode: 'intersection',
    policyType: 'IAM',
    exceptions: [],
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  });

  it('queries the primary key partitioned by accountId', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [samplePolicy(), samplePolicy({ policyName: 'Analytics', status: 'pending' })],
    });

    const results = await makeStore().listPolicies();

    expect(results).toHaveLength(2);

    const queryCall = ddbMock.commandCalls(QueryCommand)[0];
    // No GSI — primary-key Query on accountId.
    expect(queryCall.args[0].input.IndexName).toBeUndefined();
    expect(queryCall.args[0].input.KeyConditionExpression).toBe('accountId = :a');
    expect(queryCall.args[0].input.ExpressionAttributeValues).toEqual({ ':a': ACCOUNT_ID });
  });

  it('filters by status', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [samplePolicy({ status: 'active' }), samplePolicy({ policyName: 'Analytics', status: 'pending' })],
    });
    const results = await makeStore().listPolicies({ status: 'pending' });
    expect(results.map(p => p.policyName)).toEqual(['Analytics']);
  });

  it('filters by tagKey + tagValue', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        samplePolicy({ tags: [{ key: 'team', value: 'core' }] }),
        samplePolicy({ policyName: 'Analytics', tags: [{ key: 'team', value: 'data' }] }),
      ],
    });
    const results = await makeStore().listPolicies({ tagKey: 'team', tagValue: 'data' });
    expect(results.map(p => p.policyName)).toEqual(['Analytics']);
  });

  it('runs case-insensitive search across name and description', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        samplePolicy({ policyName: 'PaymentsService' }),
        samplePolicy({ policyName: 'Analytics', description: 'PAYMENTS pipeline' }),
      ],
    });
    const results = await makeStore().listPolicies({ search: 'payments' });
    expect(results.map(p => p.policyName).sort()).toEqual(['Analytics', 'PaymentsService']);
  });

  it('paginates through LastEvaluatedKey', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [samplePolicy({ policyName: 'A' })],
        LastEvaluatedKey: { policyName: 'A' },
      })
      .resolvesOnce({
        Items: [samplePolicy({ policyName: 'B' })],
      });

    const results = await makeStore().listPolicies();
    expect(results).toHaveLength(2);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(2);
  });
});

describe('updatePolicy', () => {
  it('builds a SET expression that excludes immutable fields', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: {
        accountId: ACCOUNT_ID,
        policyName: 'Payments',
        description: 'updated',
        tags: [],
        regions: ['us-east-1'],
        mode: 'intersection',
        policyType: 'IAM',
        exceptions: [],
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-06-04T16:00:00Z',
      },
    });

    const updated = await makeStore().updatePolicy('Payments', {
      description: 'updated',
      // These should all be silently stripped:
      policyName: 'NewName',
      createdAt: 'should-be-ignored',
      accountId: 'should-be-ignored',
    } as Record<string, unknown>);

    expect(updated.description).toBe('updated');

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual({ accountId: ACCOUNT_ID, policyName: 'Payments' });
    expect(input.UpdateExpression).toMatch(/^SET .*#a\d+ = :v\d+.* #updated = :now/);
    // description is the only mutable update we passed
    expect(Object.values(input.ExpressionAttributeNames!)).toContain('description');
    expect(Object.values(input.ExpressionAttributeNames!)).toContain('updatedAt');
    // Immutable fields must NOT have been mapped into the expression
    expect(Object.values(input.ExpressionAttributeNames!)).not.toContain('policyName');
    expect(Object.values(input.ExpressionAttributeNames!)).not.toContain('createdAt');
    expect(Object.values(input.ExpressionAttributeNames!)).not.toContain('accountId');
  });

  it('throws PolicyNotFoundError on ConditionalCheckFailed', async () => {
    ddbMock.on(UpdateCommand).rejects({ name: 'ConditionalCheckFailedException' });
    await expect(makeStore().updatePolicy('missing', { description: 'x' })).rejects.toBeInstanceOf(PolicyNotFoundError);
  });
});

describe('deletePolicy', () => {
  it('issues a single DeleteItem with a conditional check', async () => {
    ddbMock.on(DeleteCommand).resolves({});

    await makeStore().deletePolicy('Payments');

    const input = ddbMock.commandCalls(DeleteCommand)[0].args[0].input;
    expect(input.Key).toEqual({ accountId: ACCOUNT_ID, policyName: 'Payments' });
    expect(input.ConditionExpression).toBe('attribute_exists(policyName)');
  });

  it('throws PolicyNotFoundError when the policy does not exist', async () => {
    ddbMock.on(DeleteCommand).rejects({ name: 'ConditionalCheckFailedException' });
    await expect(makeStore().deletePolicy('missing')).rejects.toBeInstanceOf(PolicyNotFoundError);
  });
});
