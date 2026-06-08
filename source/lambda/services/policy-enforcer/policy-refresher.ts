import { logger, errorFields } from '../../util/logger';
import { computeAllowList } from '../../policy-enforcer/allow-list-engine';
import { generatePolicyDocument } from '../../policy-enforcer/policy-document-generator';
import { PolicyConfigStore } from './policy-config-store';
import { IamPolicyApplier } from './iam-policy-applier';
import { PolicyStatus, RefreshOutcome } from '@capability-insights/shared/types/policy-enforcer/policy-enums';
import type { PolicyConfiguration } from '@capability-insights/shared/types/policy-enforcer/policy-configuration';
import type { RefreshResponse } from '@capability-insights/shared/types/policy-enforcer/policy-api';
import type { ApiService } from '@capability-insights/shared/types/capability/api';

/**
 * Raised when the generated policy document exceeds AWS size limits and
 * cannot be split (SCP) or otherwise applied. Surfaced as a 400 by HTTP
 * callers; recorded as a per-policy ERROR by the bulk refresher.
 */
export class PolicyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyTooLargeError';
  }
}

/**
 * Recomputes the Allow_List for a single policy against the supplied catalog
 * and applies the resulting document(s) to IAM. Pure orchestration — no
 * persistence. Callers persist the returned state.
 *
 * Shared by the per-policy API route and the bulk refresher so "refresh one"
 * and "refresh all" can never drift apart.
 */
export async function refreshPolicy(
  policy: PolicyConfiguration,
  catalogData: ApiService[],
  applier: IamPolicyApplier,
): Promise<RefreshResponse> {
  const allowList = computeAllowList({ catalogData, configuration: policy });
  const generated = generatePolicyDocument({
    catalogData,
    configuration: policy,
    policyName: policy.policyName,
    generationTimestamp: new Date().toISOString(),
  });

  if (generated.error) {
    throw new PolicyTooLargeError(generated.error);
  }

  const existingArns = [policy.policyArn, ...(policy.additionalPolicyArns ?? [])].filter((a): a is string =>
    Boolean(a),
  );

  const applied = await applier.apply(
    policy.policyName,
    policy.description ?? `Managed by Capability Insights Policy Enforcer: ${policy.policyName}`,
    generated,
    existingArns,
  );

  return {
    message: 'Policy refreshed',
    policyArn: applied.policyArn,
    additionalPolicyArns: applied.additionalPolicyArns.length > 0 ? applied.additionalPolicyArns : undefined,
    actionCount: allowList.actionCount,
    splitRequired: generated.splitRequired,
    totalSize: generated.totalSize,
  };
}

/** Per-policy outcome from a bulk refresh. */
export interface BulkRefreshItemResult {
  policyName: string;
  outcome: RefreshOutcome;
  actionCount?: number;
  error?: string;
}

export interface BulkRefreshSummary {
  total: number;
  succeeded: number;
  failed: number;
  results: BulkRefreshItemResult[];
}

/**
 * Refreshes every policy in the account, persisting each policy's new state
 * as it goes. Tolerant of per-policy failures: one failing policy is recorded
 * as an ERROR and does not abort the batch.
 *
 * Used by both the bulk-refresh Lambda (EventBridge weekly schedule) and the
 * `POST /policies/refresh-all` route.
 */
export async function refreshAllPolicies(
  store: PolicyConfigStore,
  applier: IamPolicyApplier,
  loadCatalog: () => Promise<ApiService[]>,
): Promise<BulkRefreshSummary> {
  const policies = await store.listPolicies();
  const results: BulkRefreshItemResult[] = [];

  if (policies.length === 0) {
    return { total: 0, succeeded: 0, failed: 0, results };
  }

  // Load the catalog once and reuse it for every policy — it does not change
  // between policies within a single run, and it is the most expensive read.
  const catalogData = await loadCatalog();

  for (const policy of policies) {
    try {
      const refresh = await refreshPolicy(policy, catalogData, applier);
      await store.updatePolicy(policy.policyName, {
        status: PolicyStatus.ACTIVE,
        policyArn: refresh.policyArn,
        additionalPolicyArns: refresh.additionalPolicyArns,
        lastRefreshTime: new Date().toISOString(),
        lastRefreshOutcome: RefreshOutcome.SUCCESS,
        lastActionCount: refresh.actionCount,
      });
      results.push({
        policyName: policy.policyName,
        outcome: RefreshOutcome.SUCCESS,
        actionCount: refresh.actionCount,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error('Bulk refresh: policy failed', { policyName: policy.policyName, ...errorFields(e) });
      // Best-effort status update; don't let a persistence failure mask the
      // original error or abort the remaining policies.
      try {
        await store.updatePolicy(policy.policyName, {
          status: PolicyStatus.ERROR,
          lastRefreshOutcome: RefreshOutcome.ERROR,
          lastRefreshTime: new Date().toISOString(),
        });
      } catch (updateError) {
        logger.warn('Bulk refresh: failed to record ERROR status', {
          policyName: policy.policyName,
          ...errorFields(updateError),
        });
      }
      results.push({ policyName: policy.policyName, outcome: RefreshOutcome.ERROR, error: message });
    }
  }

  const succeeded = results.filter(r => r.outcome === RefreshOutcome.SUCCESS).length;
  return {
    total: policies.length,
    succeeded,
    failed: policies.length - succeeded,
    results,
  };
}
