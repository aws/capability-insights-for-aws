import { describe, it, expect, vi, beforeEach } from 'vitest';
import { refreshAllPolicies, refreshPolicy } from './policy-refresher';
import { PolicyConfigStore } from './policy-config-store';
import { IamPolicyApplier } from './iam-policy-applier';
import {
  PolicyMode,
  PolicyType,
  PolicyStatus,
  RefreshOutcome,
} from '@capability-insights/shared/types/policy-enforcer/policy-enums';
import type { PolicyConfiguration } from '@capability-insights/shared/types/policy-enforcer/policy-configuration';
import type { ApiService } from '@capability-insights/shared/types/capability/api';

// Minimal catalog: one service, one API available in us-east-1.
const catalog: ApiService[] = [
  {
    sdkServiceName: 'S3',
    sdkServiceFullName: 'Amazon S3',
    apis: [
      {
        apiName: 'S3+GetObject',
        apiAction: 'GetObject',
        homepage: '',
        regionalAvailability: { 'us-east-1': 'Available' },
      },
    ],
  },
] as unknown as ApiService[];

function makePolicy(name: string): PolicyConfiguration {
  return {
    policyName: name,
    tags: [],
    regions: ['us-east-1'],
    mode: PolicyMode.INTERSECTION,
    policyType: PolicyType.IAM,
    exceptions: [],
    status: PolicyStatus.ACTIVE,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A store stub exposing just what the refresher uses. */
function makeStoreStub(policies: PolicyConfiguration[]) {
  return {
    listPolicies: vi.fn().mockResolvedValue(policies),
    updatePolicy: vi.fn().mockResolvedValue(undefined),
  } as unknown as PolicyConfigStore & {
    listPolicies: ReturnType<typeof vi.fn>;
    updatePolicy: ReturnType<typeof vi.fn>;
  };
}

function makeApplierStub() {
  return {
    apply: vi
      .fn()
      .mockResolvedValue({ policyArn: 'arn:aws:iam::123:policy/PolicyEnforcer-x', additionalPolicyArns: [] }),
  } as unknown as IamPolicyApplier & { apply: ReturnType<typeof vi.fn> };
}

describe('refreshPolicy', () => {
  it('applies the generated document and returns the action count', async () => {
    const applier = makeApplierStub();
    const result = await refreshPolicy(makePolicy('p1'), catalog, applier);

    expect(applier.apply).toHaveBeenCalledOnce();
    expect(result.policyArn).toContain('PolicyEnforcer-');
    expect(result.actionCount).toBeGreaterThanOrEqual(0);
  });

  // Note: the PolicyTooLargeError path (generator returns `error`) is covered
  // by the policy-document-generator's own size-limit tests. The refresher
  // simply rethrows that error as PolicyTooLargeError, exercised indirectly
  // through the route tests.
});

describe('refreshAllPolicies', () => {
  let loadCatalog: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    loadCatalog = vi.fn().mockResolvedValue(catalog);
  });

  it('returns an empty summary and skips catalog load when there are no policies', async () => {
    const store = makeStoreStub([]);
    const applier = makeApplierStub();

    const summary = await refreshAllPolicies(store, applier, loadCatalog);

    expect(summary).toEqual({ total: 0, succeeded: 0, failed: 0, results: [] });
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(applier.apply).not.toHaveBeenCalled();
  });

  it('loads the catalog once and refreshes every policy', async () => {
    const store = makeStoreStub([makePolicy('a'), makePolicy('b'), makePolicy('c')]);
    const applier = makeApplierStub();

    const summary = await refreshAllPolicies(store, applier, loadCatalog);

    expect(loadCatalog).toHaveBeenCalledOnce();
    expect(applier.apply).toHaveBeenCalledTimes(3);
    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(0);
    // Each success persists ACTIVE + SUCCESS outcome.
    expect(store.updatePolicy).toHaveBeenCalledTimes(3);
    expect(store.updatePolicy).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ status: PolicyStatus.ACTIVE, lastRefreshOutcome: RefreshOutcome.SUCCESS }),
    );
  });

  it('continues past a failing policy and records it as ERROR', async () => {
    const store = makeStoreStub([makePolicy('ok-1'), makePolicy('bad'), makePolicy('ok-2')]);
    const applier = makeApplierStub();
    // Make the middle policy fail on apply.
    applier.apply
      .mockResolvedValueOnce({ policyArn: 'arn:...:policy/PolicyEnforcer-ok-1', additionalPolicyArns: [] })
      .mockRejectedValueOnce(new Error('IAM helper exploded'))
      .mockResolvedValueOnce({ policyArn: 'arn:...:policy/PolicyEnforcer-ok-2', additionalPolicyArns: [] });

    const summary = await refreshAllPolicies(store, applier, loadCatalog);

    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);

    const badResult = summary.results.find(r => r.policyName === 'bad');
    expect(badResult?.outcome).toBe(RefreshOutcome.ERROR);
    expect(badResult?.error).toContain('IAM helper exploded');

    // The failing policy is persisted with ERROR status.
    expect(store.updatePolicy).toHaveBeenCalledWith(
      'bad',
      expect.objectContaining({ status: PolicyStatus.ERROR, lastRefreshOutcome: RefreshOutcome.ERROR }),
    );
  });

  it('does not abort the batch if recording an ERROR status itself fails', async () => {
    const store = makeStoreStub([makePolicy('bad'), makePolicy('ok')]);
    const applier = makeApplierStub();
    applier.apply
      .mockRejectedValueOnce(new Error('apply failed'))
      .mockResolvedValueOnce({ policyArn: 'arn:...:policy/PolicyEnforcer-ok', additionalPolicyArns: [] });
    // First updatePolicy call (recording ERROR for 'bad') throws; the second
    // (recording SUCCESS for 'ok') succeeds.
    store.updatePolicy.mockRejectedValueOnce(new Error('ddb down')).mockResolvedValue(undefined);

    const summary = await refreshAllPolicies(store, applier, loadCatalog);

    expect(summary.total).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
  });
});
