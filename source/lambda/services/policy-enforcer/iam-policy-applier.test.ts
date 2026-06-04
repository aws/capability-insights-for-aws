import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { IamPolicyApplier, buildPolicyName, sanitizePolicyName, POLICY_NAME_PREFIX } from './iam-policy-applier';
import type { GeneratedPolicy } from './policy-document-generator';

const lambdaMock = mockClient(LambdaClient);

const HELPER = 'CapabilityInsightsPolicyEnforcerIamHelper';

beforeEach(() => {
  lambdaMock.reset();
  vi.stubEnv('IAM_HELPER_LAMBDA_NAME', HELPER);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function helperResponse(payload: Record<string, unknown>) {
  return {
    Payload: Buffer.from(JSON.stringify(payload)),
  };
}

function emptyDoc(): GeneratedPolicy['documents'][number] {
  return { Version: '2012-10-17', Statement: [] };
}

function generated(docCount: number): GeneratedPolicy {
  return {
    documents: Array.from({ length: docCount }, () => emptyDoc()),
    totalSize: docCount * 100,
    splitRequired: docCount > 1,
    blanketDenyServiceCount: 0,
    fullyAvailableServiceCount: 0,
    partiallyAvailableServiceCount: 0,
    partialDenyActionCount: 0,
  };
}

describe('sanitizePolicyName', () => {
  it('replaces disallowed characters with hyphen and collapses runs', () => {
    expect(sanitizePolicyName('My Policy / Name!')).toBe('My-Policy-Name');
    expect(sanitizePolicyName('---weird---')).toBe('weird');
    expect(sanitizePolicyName('Already_Valid.Name@-1')).toBe('Already_Valid.Name@-1');
  });
});

describe('buildPolicyName', () => {
  it('omits part suffix for single-document policies', () => {
    expect(buildPolicyName('Test')).toBe(`${POLICY_NAME_PREFIX}Test`);
  });

  it('includes part suffix for split policies', () => {
    expect(buildPolicyName('Test', 1)).toBe(`${POLICY_NAME_PREFIX}Test-Part1`);
    expect(buildPolicyName('Test', 4)).toBe(`${POLICY_NAME_PREFIX}Test-Part4`);
  });

  it('sanitizes the configuration name', () => {
    expect(buildPolicyName('My Policy!')).toBe(`${POLICY_NAME_PREFIX}My-Policy`);
  });
});

describe('apply', () => {
  it('creates a single policy when no existing ARNs and one document', async () => {
    lambdaMock.on(InvokeCommand).resolves(
      helperResponse({
        success: true,
        policyArn: 'arn:aws:iam::123456789012:policy/PolicyEnforcer-Test',
      }),
    );

    const applier = new IamPolicyApplier();
    const result = await applier.apply('Test', 'desc', generated(1), []);

    expect(result.policyArn).toBe('arn:aws:iam::123456789012:policy/PolicyEnforcer-Test');
    expect(result.additionalPolicyArns).toEqual([]);

    const calls = lambdaMock.commandCalls(InvokeCommand);
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(Buffer.from(calls[0].args[0].input.Payload as Uint8Array).toString());
    expect(payload).toMatchObject({
      action: 'create',
      policyName: `${POLICY_NAME_PREFIX}Test`,
      description: 'desc',
    });
    expect(calls[0].args[0].input.FunctionName).toBe(HELPER);
  });

  it('creates Part1..PartN names when splitting across multiple documents', async () => {
    lambdaMock
      .on(InvokeCommand)
      .resolvesOnce(helperResponse({ success: true, policyArn: 'arn:aws:iam::1:policy/Part1' }))
      .resolvesOnce(helperResponse({ success: true, policyArn: 'arn:aws:iam::1:policy/Part2' }))
      .resolvesOnce(helperResponse({ success: true, policyArn: 'arn:aws:iam::1:policy/Part3' }));

    const applier = new IamPolicyApplier();
    const result = await applier.apply('Test', undefined, generated(3), []);

    expect(result.policyArn).toBe('arn:aws:iam::1:policy/Part1');
    expect(result.additionalPolicyArns).toEqual(['arn:aws:iam::1:policy/Part2', 'arn:aws:iam::1:policy/Part3']);

    const policyNames = lambdaMock
      .commandCalls(InvokeCommand)
      .map(c => JSON.parse(Buffer.from(c.args[0].input.Payload as Uint8Array).toString()).policyName);
    expect(policyNames).toEqual([
      `${POLICY_NAME_PREFIX}Test-Part1`,
      `${POLICY_NAME_PREFIX}Test-Part2`,
      `${POLICY_NAME_PREFIX}Test-Part3`,
    ]);
  });

  it('updates existing ARNs in place when refreshing without split-count change', async () => {
    lambdaMock.on(InvokeCommand).resolves(helperResponse({ success: true }));

    const existing = ['arn:aws:iam::1:policy/Existing'];
    const applier = new IamPolicyApplier();
    const result = await applier.apply('Test', undefined, generated(1), existing);

    expect(result.policyArn).toBe('arn:aws:iam::1:policy/Existing');
    expect(result.additionalPolicyArns).toEqual([]);

    const payload = JSON.parse(
      Buffer.from(lambdaMock.commandCalls(InvokeCommand)[0].args[0].input.Payload as Uint8Array).toString(),
    );
    expect(payload.action).toBe('update');
    expect(payload.policyArn).toBe('arn:aws:iam::1:policy/Existing');
  });

  it('deletes orphan parts when refresh produces fewer documents than before', async () => {
    lambdaMock.on(InvokeCommand).resolves(helperResponse({ success: true }));

    const existing = ['arn:aws:iam::1:policy/Part1', 'arn:aws:iam::1:policy/Part2', 'arn:aws:iam::1:policy/Part3'];
    const applier = new IamPolicyApplier();
    await applier.apply('Test', undefined, generated(1), existing);

    const actions = lambdaMock
      .commandCalls(InvokeCommand)
      .map(c => JSON.parse(Buffer.from(c.args[0].input.Payload as Uint8Array).toString()));

    // 1 update on the kept ARN + 2 deletes on the orphans.
    expect(actions).toHaveLength(3);
    expect(actions[0]).toMatchObject({ action: 'update', policyArn: 'arn:aws:iam::1:policy/Part1' });
    expect(
      actions
        .filter(a => a.action === 'delete')
        .map(a => a.policyArn)
        .sort(),
    ).toEqual(['arn:aws:iam::1:policy/Part2', 'arn:aws:iam::1:policy/Part3']);
  });

  it('throws when the helper fails to create a policy', async () => {
    lambdaMock.on(InvokeCommand).resolves(helperResponse({ success: false, error: 'LimitExceeded' }));

    const applier = new IamPolicyApplier();
    await expect(applier.apply('Test', undefined, generated(1), [])).rejects.toThrow(/LimitExceeded/);
  });

  it('surfaces Lambda FunctionError as a failed helper response', async () => {
    lambdaMock.on(InvokeCommand).resolves({
      FunctionError: 'Unhandled',
      Payload: Buffer.from(''),
    });

    const applier = new IamPolicyApplier();
    await expect(applier.apply('Test', undefined, generated(1), [])).rejects.toThrow(/Helper Lambda function error/);
  });
});

describe('deleteAll', () => {
  it('invokes the helper with delete for every ARN', async () => {
    lambdaMock.on(InvokeCommand).resolves(helperResponse({ success: true }));

    const applier = new IamPolicyApplier();
    await applier.deleteAll(['arn:aws:iam::1:policy/A', 'arn:aws:iam::1:policy/B']);

    const calls = lambdaMock.commandCalls(InvokeCommand);
    expect(calls).toHaveLength(2);
    const payloads = calls.map(c => JSON.parse(Buffer.from(c.args[0].input.Payload as Uint8Array).toString()));
    expect(payloads.every(p => p.action === 'delete')).toBe(true);
    expect(payloads.map(p => p.policyArn).sort()).toEqual(['arn:aws:iam::1:policy/A', 'arn:aws:iam::1:policy/B']);
  });

  it('does not throw when an individual delete fails (logged + swallowed)', async () => {
    lambdaMock
      .on(InvokeCommand)
      .resolvesOnce(helperResponse({ success: true }))
      .resolvesOnce(helperResponse({ success: false, error: 'NoSuchEntity' }));

    const applier = new IamPolicyApplier();
    await expect(applier.deleteAll(['arn:aws:iam::1:policy/A', 'arn:aws:iam::1:policy/B'])).resolves.toBeUndefined();
  });
});
