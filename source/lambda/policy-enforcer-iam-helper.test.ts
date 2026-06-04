import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  IAMClient,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  DeletePolicyCommand,
  DeletePolicyVersionCommand,
  ListPolicyVersionsCommand,
} from '@aws-sdk/client-iam';
import { handler } from './policy-enforcer-iam-helper';

const iamMock = mockClient(IAMClient);

beforeEach(() => {
  iamMock.reset();
});

describe('create', () => {
  it('returns success + ARN on a successful CreatePolicy', async () => {
    iamMock.on(CreatePolicyCommand).resolves({
      Policy: { Arn: 'arn:aws:iam::123456789012:policy/PolicyEnforcer-Test' },
    });

    const result = await handler({
      action: 'create',
      policyName: 'PolicyEnforcer-Test',
      policyDocument: '{"Version":"2012-10-17","Statement":[]}',
      description: 'desc',
    });

    expect(result.success).toBe(true);
    expect(result.policyArn).toBe('arn:aws:iam::123456789012:policy/PolicyEnforcer-Test');

    const calls = iamMock.commandCalls(CreatePolicyCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      PolicyName: 'PolicyEnforcer-Test',
      PolicyDocument: '{"Version":"2012-10-17","Statement":[]}',
      Description: 'desc',
    });
  });

  it('returns failure when CreatePolicy yields no ARN', async () => {
    iamMock.on(CreatePolicyCommand).resolves({ Policy: {} });

    const result = await handler({
      action: 'create',
      policyName: 'PolicyEnforcer-Test',
      policyDocument: '{}',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('CreatePolicy returned no ARN');
  });

  it('returns failure on CreatePolicy SDK error', async () => {
    iamMock.on(CreatePolicyCommand).rejects(new Error('LimitExceeded'));

    const result = await handler({
      action: 'create',
      policyName: 'PolicyEnforcer-Test',
      policyDocument: '{}',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('LimitExceeded');
  });
});

describe('update', () => {
  const arn = 'arn:aws:iam::123456789012:policy/PolicyEnforcer-Test';

  it('creates a new version as default without trimming when fewer than 5 versions exist', async () => {
    iamMock.on(ListPolicyVersionsCommand).resolves({
      Versions: [
        { VersionId: 'v3', IsDefaultVersion: true, CreateDate: new Date('2026-06-01') },
        { VersionId: 'v2', IsDefaultVersion: false, CreateDate: new Date('2026-05-01') },
      ],
    });
    iamMock.on(CreatePolicyVersionCommand).resolves({});

    const result = await handler({ action: 'update', policyArn: arn, policyDocument: '{}' });

    expect(result.success).toBe(true);
    expect(iamMock.commandCalls(DeletePolicyVersionCommand)).toHaveLength(0);
    const create = iamMock.commandCalls(CreatePolicyVersionCommand);
    expect(create).toHaveLength(1);
    expect(create[0].args[0].input.SetAsDefault).toBe(true);
    expect(create[0].args[0].input.PolicyArn).toBe(arn);
  });

  it('trims oldest non-default versions to leave room when at the 5-version limit', async () => {
    iamMock.on(ListPolicyVersionsCommand).resolves({
      Versions: [
        { VersionId: 'v5', IsDefaultVersion: true, CreateDate: new Date('2026-06-01') },
        { VersionId: 'v4', IsDefaultVersion: false, CreateDate: new Date('2026-05-04') },
        { VersionId: 'v3', IsDefaultVersion: false, CreateDate: new Date('2026-05-03') },
        { VersionId: 'v2', IsDefaultVersion: false, CreateDate: new Date('2026-05-02') },
        { VersionId: 'v1', IsDefaultVersion: false, CreateDate: new Date('2026-05-01') },
      ],
    });
    iamMock.on(DeletePolicyVersionCommand).resolves({});
    iamMock.on(CreatePolicyVersionCommand).resolves({});

    const result = await handler({ action: 'update', policyArn: arn, policyDocument: '{}' });

    expect(result.success).toBe(true);
    const deletes = iamMock.commandCalls(DeletePolicyVersionCommand);
    // Need to drop down to MAX_POLICY_VERSIONS - 1 = 4 to make room for the new version: 5 - 4 = 1 to delete.
    expect(deletes).toHaveLength(1);
    expect(deletes[0].args[0].input.VersionId).toBe('v1'); // oldest non-default
  });
});

describe('delete', () => {
  const arn = 'arn:aws:iam::123456789012:policy/PolicyEnforcer-Test';

  it('deletes non-default versions before the policy', async () => {
    iamMock.on(ListPolicyVersionsCommand).resolves({
      Versions: [
        { VersionId: 'v3', IsDefaultVersion: true },
        { VersionId: 'v2', IsDefaultVersion: false },
        { VersionId: 'v1', IsDefaultVersion: false },
      ],
    });
    iamMock.on(DeletePolicyVersionCommand).resolves({});
    iamMock.on(DeletePolicyCommand).resolves({});

    const result = await handler({ action: 'delete', policyArn: arn });

    expect(result.success).toBe(true);
    expect(iamMock.commandCalls(DeletePolicyVersionCommand)).toHaveLength(2);
    expect(iamMock.commandCalls(DeletePolicyCommand)).toHaveLength(1);
  });

  it('proceeds with DeletePolicy when ListPolicyVersions fails', async () => {
    iamMock.on(ListPolicyVersionsCommand).rejects(new Error('AccessDenied'));
    iamMock.on(DeletePolicyCommand).resolves({});

    const result = await handler({ action: 'delete', policyArn: arn });

    expect(result.success).toBe(true);
    expect(iamMock.commandCalls(DeletePolicyCommand)).toHaveLength(1);
  });

  it('returns failure when DeletePolicy itself fails', async () => {
    iamMock.on(ListPolicyVersionsCommand).resolves({ Versions: [] });
    iamMock.on(DeletePolicyCommand).rejects(new Error('NoSuchEntity'));

    const result = await handler({ action: 'delete', policyArn: arn });

    expect(result.success).toBe(false);
    expect(result.error).toBe('NoSuchEntity');
  });
});
