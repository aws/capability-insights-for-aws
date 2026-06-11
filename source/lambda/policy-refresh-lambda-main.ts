import type { Context } from 'aws-lambda';
import { EnvironmentKey, getEnv } from './constants/environment';
import { CatalogKey } from './constants/data-paths';
import { S3BucketClient } from './services/s3-client';
import { PolicyConfigStore } from './services/policy-enforcer/policy-config-store';
import { IamPolicyApplier } from './services/policy-enforcer/iam-policy-applier';
import { refreshAllPolicies, type BulkRefreshSummary } from './services/policy-enforcer/policy-refresher';
import { logger } from './util/logger';
import type { ApiService } from '@capability-insights/shared/types/capability/api';

/**
 * Bulk policy-refresh Lambda.
 *
 * Recomputes every Policy_Configuration in this account against the current
 * catalog and re-applies the resulting IAM/SCP documents. Triggered two ways:
 *   1. `POST /policies/refresh-all` (API Lambda invokes this async)
 *   2. A weekly EventBridge schedule
 *
 * Runs in-VPC (same as the API Lambda) so it can reach DynamoDB and S3 via
 * gateway endpoints, and invokes the out-of-VPC IAM helper for IAM mutations.
 *
 * Tolerant of per-policy failures — one bad policy is recorded as ERROR and
 * does not abort the batch. Returns a summary for CloudWatch visibility.
 */
export async function handler(_event: unknown, context: Context): Promise<BulkRefreshSummary> {
  const accountId = resolveAccountId(context);
  const tableName = getEnv(EnvironmentKey.POLICY_TABLE_NAME);
  const websiteBucket = getEnv(EnvironmentKey.WEBSITE_BUCKET_NAME);

  const store = new PolicyConfigStore(tableName, accountId);
  const applier = new IamPolicyApplier();
  const loadCatalog = async (): Promise<ApiService[]> => {
    const raw = await new S3BucketClient(websiteBucket).getObject(CatalogKey.APIS);
    return JSON.parse(raw) as ApiService[];
  };

  logger.info('Bulk policy refresh starting', { accountId });
  const summary = await refreshAllPolicies(store, applier, loadCatalog);
  logger.info('Bulk policy refresh complete', {
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
  });

  return summary;
}

/**
 * Resolves the account ID from the Lambda invocation context with no network
 * call. `context.invokedFunctionArn` has the form
 * `arn:aws:lambda:<region>:<accountId>:function:<name>`, so the account ID is
 * the 5th colon-delimited segment.
 *
 * This deliberately avoids STS GetCallerIdentity: the bulk refresh Lambda runs
 * in the VPC, which has no STS interface endpoint, so an STS call would hang
 * until timeout. The ARN is always present for both API-triggered (async
 * Invoke) and EventBridge-scheduled invocations.
 */
function resolveAccountId(context: Context): string {
  const arn = context.invokedFunctionArn;
  if (!arn) {
    throw new Error('invokedFunctionArn is missing from the Lambda context');
  }
  // arn:<partition>:lambda:<region>:<accountId>:function:<name>[:<version>]
  const parts = arn.split(':');
  const accountId = parts[4];
  if (parts.length < 7 || !/^\d{12}$/.test(accountId ?? '')) {
    throw new Error(`Unexpected Lambda ARN format; cannot resolve a 12-digit account ID: ${arn}`);
  }
  return accountId;
}
