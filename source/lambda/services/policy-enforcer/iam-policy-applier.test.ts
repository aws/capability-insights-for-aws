import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { IamPolicyApplier } from './iam-policy-applier';
import type { GeneratedPolicy, PolicyDocument } from '../../policy-enforcer/policy-document-generator';

/**
 * The applier wraps the out-of-VPC IAM helper Lambda. These tests mock the
 * Lambda invoke and assert the multi-part create/update/rollback contract.
 */

const lambdaMock = mockClient(LambdaClient);

const HELPER = 'PolicyEnforcerIamHelper';

const doc = (sid: string): PolicyDocument => ({
  Version: '2012-10-17',
  Statement: [{ Sid: sid, Effect: 'Deny', NotAction: ['s3:*'], Resource: '*' }],
});

const generated = (count: number): GeneratedPolicy => ({
  documents: Array.from({ length: count }, (_, i) => doc(`Sid${i + 1}`)),
  totalSize: 0,
  splitRequired: count > 1,
  blanketDenyServiceCount: 0,
  fullyAvailableServiceCount: 0,
  partiallyAvailableServiceCount: 0,
  partialDenyActionCount: 0,
});

/**
 * Stage scripted helper-Lambda responses against the InvokeCommand mock.
 * Each entry is consumed in order — one entry per expected helper invocation.
 */
function scriptResponses(responses: Array<{ success: boolean; policyArn?: string; error?: string }>): void {
  let i = 0;
  lambdaMock.on(InvokeCommand).callsFake(() => {
    const body = responses[i++] ?? { success: false, error: 'unscripted invocation' };
    return Promise.resolve({
      StatusCode: 200,
      Payload: Buffer.from(JSON.stringify(body)),
    });
  });
}

beforeEach(() => {
  lambdaMock.reset();
});

describe('IamPolicyApplier.apply', () => {
  it('creates each part and returns the primary + additional ARNs', async () => {
    scriptResponses([
      { success: true, policyArn: 'arn:p1' },
      { success: true, policyArn: 'arn:p2' },
    ]);

    const applier = new IamPolicyApplier(HELPER);
    const result = await applier.apply('test', undefined, generated(2), []);

    expect(result.policyArn).toBe('arn:p1');
    expect(result.additionalPolicyArns).toEqual(['arn:p2']);
    // Two creates, no deletes.
    const calls = lambdaMock.commandCalls(InvokeCommand);
    expect(calls).toHaveLength(2);
    const actions = calls.map(c => JSON.parse(Buffer.from(c.args[0].input.Payload as Uint8Array).toString()).action);
    expect(actions).toEqual(['create', 'create']);
  });

  it('rolls back already-created parts when a later part fails to create', async () => {
    // Part 1 + 2 succeed; part 3 fails. Applier should delete Parts 1 + 2
    // before re-raising — leaving IAM clean for the next retry.
    scriptResponses([
      { success: true, policyArn: 'arn:p1' },
      { success: true, policyArn: 'arn:p2' },
      { success: false, error: 'AccessDenied' }, // Part 3 create fails
      { success: true }, // rollback delete arn:p1
      { success: true }, // rollback delete arn:p2
    ]);

    const applier = new IamPolicyApplier(HELPER);
    await expect(applier.apply('test', undefined, generated(3), [])).rejects.toThrow(
      /IAM helper failed to create.*Part3/,
    );

    const calls = lambdaMock.commandCalls(InvokeCommand);
    const payloads = calls.map(c => JSON.parse(Buffer.from(c.args[0].input.Payload as Uint8Array).toString()));
    expect(payloads.map(p => p.action)).toEqual(['create', 'create', 'create', 'delete', 'delete']);
    // The two deletes target the ARNs we successfully created (in order).
    expect(payloads[3].policyArn).toBe('arn:p1');
    expect(payloads[4].policyArn).toBe('arn:p2');
  });

  it('does not roll back updates to pre-existing parts when a later part fails', async () => {
    // Existing Part 1 (update succeeds), Part 2 create fails. Update on a
    // pre-existing ARN must NOT be rolled back — that policy was already
    // owned by the user before this invocation.
    scriptResponses([
      { success: true }, // update existing arn:existing-p1 — succeeds
      { success: false, error: 'LimitExceeded' }, // create Part 2 — fails
      // No rollback delete should follow because nothing was CREATED here.
    ]);

    const applier = new IamPolicyApplier(HELPER);
    await expect(applier.apply('test', undefined, generated(2), ['arn:existing-p1'])).rejects.toThrow(
      /IAM helper failed to create.*Part2/,
    );

    const calls = lambdaMock.commandCalls(InvokeCommand);
    const actions = calls.map(c => JSON.parse(Buffer.from(c.args[0].input.Payload as Uint8Array).toString()).action);
    expect(actions).toEqual(['update', 'create']);
  });

  it('swallows rollback delete failures and still surfaces the original error', async () => {
    scriptResponses([
      { success: true, policyArn: 'arn:p1' },
      { success: false, error: 'OriginalCreateFailure' },
      { success: false, error: 'RollbackDeleteFailure' }, // even rollback delete fails
    ]);

    const applier = new IamPolicyApplier(HELPER);
    // The error the caller sees must be the original create failure, not
    // the rollback failure (which is logged but swallowed).
    await expect(applier.apply('test', undefined, generated(2), [])).rejects.toThrow(/OriginalCreateFailure/);
  });
});
