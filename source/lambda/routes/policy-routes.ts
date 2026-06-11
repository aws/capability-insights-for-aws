import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { corsHeaders } from '../types/api';
import { StatusCode } from '../constants/status-codes';
import { ErrorResponse } from '../constants/errors';
import { EnvironmentKey, getEnv, getOptionalEnv } from '../constants/environment';
import { CatalogKey } from '../constants/data-paths';
import { PolicyStatus, RefreshOutcome } from '@capability-insights/shared/types/policy-enforcer/policy-enums';
import { logger } from '../util/logger';
import { S3BucketClient } from '../services/s3-client';
import {
  PolicyConfigStore,
  PolicyNameConflictError,
  PolicyNotFoundError,
} from '../services/policy-enforcer/policy-config-store';
import { computeAllowList } from '../policy-enforcer/allow-list-engine';
import { generatePolicyDocument } from '../policy-enforcer/policy-document-generator';
import { validatePolicyConfiguration, validatePolicyUpdate } from '../policy-enforcer/validation';
import { IamPolicyApplier } from '../services/policy-enforcer/iam-policy-applier';
import { refreshPolicy, PolicyTooLargeError } from '../services/policy-enforcer/policy-refresher';
import { LambdaFunctionClient } from '../services/lambda-client';
import type {
  CreatePolicyRequest,
  UpdatePolicyRequest,
  ListPoliciesQuery,
  PreviewResponse,
} from '@capability-insights/shared/types/policy-enforcer/policy-api';
import type { PolicyConfiguration } from '@capability-insights/shared/types/policy-enforcer/policy-configuration';
import type { ApiService } from '@capability-insights/shared/types/capability/api';

/**
 * Lazy initialization helper so test code can set env vars after import.
 *
 * Each route invocation reuses these singletons within the warm Lambda; the
 * SDK clients underneath maintain their own connection pools.
 */
let cachedStore: PolicyConfigStore | null = null;
let cachedApplier: IamPolicyApplier | null = null;

function getStore(accountId: string): PolicyConfigStore {
  if (!cachedStore) {
    cachedStore = new PolicyConfigStore(getEnv(EnvironmentKey.POLICY_TABLE_NAME), accountId);
  }
  return cachedStore;
}

function getApplier(): IamPolicyApplier {
  if (!cachedApplier) cachedApplier = new IamPolicyApplier();
  return cachedApplier;
}

async function loadCatalog(): Promise<ApiService[]> {
  const bucket = new S3BucketClient(getEnv(EnvironmentKey.WEBSITE_BUCKET_NAME));
  const raw = await bucket.getObject(CatalogKey.APIS);
  return JSON.parse(raw) as ApiService[];
}

function parseBody<T>(event: APIGatewayProxyEvent): T | null {
  if (!event.body) return null;
  try {
    return JSON.parse(event.body) as T;
  } catch {
    return null;
  }
}

function ok(body: unknown, status: number = StatusCode.OK): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: corsHeaders,
    body: JSON.stringify(body),
  };
}

// =====================================================================
// Route handlers
// =====================================================================

/** POST /policies — create + run inline refresh */
export async function createPolicyRoute(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = parseBody<CreatePolicyRequest>(event);
  if (!body) return ErrorResponse.badRequest('Request body is required');

  const validation = validatePolicyConfiguration(body);
  if (!validation.valid) {
    return ErrorResponse.badRequest(validation.errors.join('; '));
  }

  const accountId = event.requestContext.accountId;
  const store = getStore(accountId);

  let policy: PolicyConfiguration;
  try {
    policy = await store.createPolicy(body);
  } catch (error: unknown) {
    if (error instanceof PolicyNameConflictError) {
      return ErrorResponse.conflict(error.message);
    }
    throw error;
  }

  // Inline refresh so the new policy is immediately usable.
  let catalogData: ApiService[];
  try {
    catalogData = await loadCatalog();
  } catch (error: unknown) {
    logger.warn('Catalog unavailable during create; policy stored as pending', {
      policyName: policy.policyName,
      error: String(error),
    });
    return ok({ policy }, StatusCode.CREATED);
  }

  try {
    const refresh = await refreshPolicy(policy, catalogData, getApplier());
    const updated = await store.updatePolicy(policy.policyName, {
      status: PolicyStatus.ACTIVE,
      policyArn: refresh.policyArn,
      additionalPolicyArns: refresh.additionalPolicyArns,
      lastRefreshTime: new Date().toISOString(),
      lastRefreshOutcome: RefreshOutcome.SUCCESS,
      lastActionCount: refresh.actionCount,
    });
    return ok({ policy: updated, refresh }, StatusCode.CREATED);
  } catch (error: unknown) {
    if (error instanceof PolicyTooLargeError) {
      // The row never reached ACTIVE — there's nothing to preserve. Delete
      // it so the user can retry with the same name (or a smaller scope)
      // without hitting a 409.
      try {
        await store.deletePolicy(policy.policyName);
      } catch (deleteError: unknown) {
        logger.warn('Failed to clean up oversized policy row; user may need to retry with a different name', {
          policyName: policy.policyName,
          error: String(deleteError),
        });
      }
      return ErrorResponse.badRequest(error.message);
    }
    logger.error('Inline refresh failed during create', {
      policyName: policy.policyName,
      error: String(error),
    });
    await store.updatePolicy(policy.policyName, {
      status: PolicyStatus.ERROR,
      lastRefreshOutcome: RefreshOutcome.ERROR,
      lastRefreshTime: new Date().toISOString(),
    });
    return ErrorResponse.internalServerError(`Failed to create policy: ${error}`);
  }
}

/** GET /policies — list with optional filters */
export async function listPoliciesRoute(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const params = event.queryStringParameters ?? {};
  const query: ListPoliciesQuery = {
    tagKey: params.tagKey,
    tagValue: params.tagValue,
    status: params.status as PolicyStatus | undefined,
    search: params.search,
  };

  const policies = await getStore(event.requestContext.accountId).listPolicies(query);
  return ok({ policies });
}

/** GET /policies/:policyName */
export async function getPolicyRoute(
  event: APIGatewayProxyEvent,
  params: Record<string, string>,
): Promise<APIGatewayProxyResult> {
  const policy = await getStore(event.requestContext.accountId).getPolicy(params.policyName);
  if (!policy) return ErrorResponse.notFound(`Policy ${params.policyName} not found`);
  return ok({ policy });
}

/** PUT /policies/:policyName — update + run inline refresh */
export async function updatePolicyRoute(
  event: APIGatewayProxyEvent,
  params: Record<string, string>,
): Promise<APIGatewayProxyResult> {
  const body = parseBody<UpdatePolicyRequest>(event);
  if (!body) return ErrorResponse.badRequest('Request body is required');

  const validation = validatePolicyUpdate(body);
  if (!validation.valid) {
    return ErrorResponse.badRequest(validation.errors.join('; '));
  }

  const store = getStore(event.requestContext.accountId);

  let updated: PolicyConfiguration;
  try {
    updated = await store.updatePolicy(params.policyName, body);
  } catch (error: unknown) {
    if (error instanceof PolicyNotFoundError) {
      return ErrorResponse.notFound(error.message);
    }
    throw error;
  }

  // Refresh inline against the new config.
  let catalogData: ApiService[];
  try {
    catalogData = await loadCatalog();
  } catch (error: unknown) {
    logger.warn('Catalog unavailable during update; existing policy retained', {
      policyName: updated.policyName,
      error: String(error),
    });
    return ok({ policy: updated });
  }

  try {
    const refresh = await refreshPolicy(updated, catalogData, getApplier());
    const persisted = await store.updatePolicy(updated.policyName, {
      status: PolicyStatus.ACTIVE,
      policyArn: refresh.policyArn,
      additionalPolicyArns: refresh.additionalPolicyArns,
      lastRefreshTime: new Date().toISOString(),
      lastRefreshOutcome: RefreshOutcome.SUCCESS,
      lastActionCount: refresh.actionCount,
    });
    return ok({ policy: persisted, refresh });
  } catch (error: unknown) {
    if (error instanceof PolicyTooLargeError) {
      await store.updatePolicy(updated.policyName, {
        status: PolicyStatus.ERROR,
        lastRefreshOutcome: RefreshOutcome.ERROR,
        lastRefreshTime: new Date().toISOString(),
      });
      return ErrorResponse.badRequest(error.message);
    }
    logger.error('Inline refresh failed during update', { policyName: updated.policyName, error: String(error) });
    return ErrorResponse.internalServerError(`Failed to refresh policy: ${error}`);
  }
}

/** DELETE /policies/:policyName — removes IAM resources + DynamoDB record */
export async function deletePolicyRoute(
  event: APIGatewayProxyEvent,
  params: Record<string, string>,
): Promise<APIGatewayProxyResult> {
  const store = getStore(event.requestContext.accountId);
  const policy = await store.getPolicy(params.policyName);
  if (!policy) return ErrorResponse.notFound(`Policy ${params.policyName} not found`);

  const arns = [policy.policyArn, ...(policy.additionalPolicyArns ?? [])].filter((a): a is string => Boolean(a));
  if (arns.length > 0) {
    try {
      await getApplier().deleteAll(arns);
    } catch (error: unknown) {
      logger.warn('Failed to delete some IAM policies; proceeding to remove DDB record', {
        policyName: params.policyName,
        error: String(error),
      });
    }
  }

  try {
    await store.deletePolicy(params.policyName);
  } catch (error: unknown) {
    if (error instanceof PolicyNotFoundError) {
      return ErrorResponse.notFound(error.message);
    }
    throw error;
  }

  return ok({ message: `Policy ${params.policyName} deleted` });
}

/** POST /policies/:policyName/refresh — manual trigger */
export async function refreshPolicyRoute(
  event: APIGatewayProxyEvent,
  params: Record<string, string>,
): Promise<APIGatewayProxyResult> {
  const store = getStore(event.requestContext.accountId);
  const policy = await store.getPolicy(params.policyName);
  if (!policy) return ErrorResponse.notFound(`Policy ${params.policyName} not found`);

  let catalogData: ApiService[];
  try {
    catalogData = await loadCatalog();
  } catch (error: unknown) {
    logger.error('Catalog unavailable during refresh', { policyName: params.policyName, error: String(error) });
    return ErrorResponse.serviceUnavailable('Catalog data is temporarily unavailable');
  }

  try {
    const refresh = await refreshPolicy(policy, catalogData, getApplier());
    const persisted = await store.updatePolicy(policy.policyName, {
      status: PolicyStatus.ACTIVE,
      policyArn: refresh.policyArn,
      additionalPolicyArns: refresh.additionalPolicyArns,
      lastRefreshTime: new Date().toISOString(),
      lastRefreshOutcome: RefreshOutcome.SUCCESS,
      lastActionCount: refresh.actionCount,
    });
    return ok({ policy: persisted, refresh });
  } catch (error: unknown) {
    if (error instanceof PolicyTooLargeError) {
      await store.updatePolicy(policy.policyName, {
        status: PolicyStatus.ERROR,
        lastRefreshOutcome: RefreshOutcome.ERROR,
        lastRefreshTime: new Date().toISOString(),
      });
      return ErrorResponse.badRequest(error.message);
    }
    logger.error('Refresh failed', { policyName: policy.policyName, error: String(error) });
    await store.updatePolicy(policy.policyName, {
      status: PolicyStatus.ERROR,
      lastRefreshOutcome: RefreshOutcome.ERROR,
      lastRefreshTime: new Date().toISOString(),
    });
    return ErrorResponse.internalServerError(`Failed to refresh policy: ${error}`);
  }
}

/** GET /policies/:policyName/preview — compute Allow_List without applying */
export async function previewPolicyRoute(
  event: APIGatewayProxyEvent,
  params: Record<string, string>,
): Promise<APIGatewayProxyResult> {
  const store = getStore(event.requestContext.accountId);
  const policy = await store.getPolicy(params.policyName);
  if (!policy) return ErrorResponse.notFound(`Policy ${params.policyName} not found`);

  let catalogData: ApiService[];
  try {
    catalogData = await loadCatalog();
  } catch (error: unknown) {
    logger.error('Catalog unavailable during preview', { policyName: params.policyName, error: String(error) });
    return ErrorResponse.serviceUnavailable('Catalog data is temporarily unavailable');
  }

  const allowList = computeAllowList({ catalogData, configuration: policy });
  const generated = generatePolicyDocument({
    catalogData,
    configuration: policy,
    policyName: policy.policyName,
    generationTimestamp: new Date().toISOString(),
  });

  const preview: PreviewResponse = {
    actions: allowList.actions,
    actionCount: allowList.actionCount,
    excludedCount: allowList.excludedCount,
    exceptionCount: allowList.exceptionCount,
    estimatedPolicySize: generated.totalSize,
    splitRequired: generated.splitRequired,
  };

  return ok(preview);
}

/**
 * POST /policies/refresh-all — fire-and-forget bulk refresh.
 *
 * Refreshing every policy can exceed API Gateway's 30s timeout (each policy
 * is an IAM round-trip via the helper Lambda), so this invokes the dedicated
 * bulk-refresh Lambda asynchronously and returns 202 immediately. The same
 * Lambda is also driven by a weekly EventBridge schedule.
 */
export async function refreshAllPoliciesRoute(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // Feature must be deployed — the env var is only present when the Policy
  // Enforcer stack is enabled.
  const bulkLambdaName = getOptionalEnv(EnvironmentKey.POLICY_REFRESH_LAMBDA_NAME);
  if (!bulkLambdaName) {
    return {
      statusCode: StatusCode.SERVICE_UNAVAILABLE,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'Policy Enforcer is not enabled',
        message: 'The Policy Enforcer stack is not deployed. Re-run deploy with --enable-policy-enforcer.',
      }),
    };
  }

  const store = getStore(event.requestContext.accountId);
  const policies = await store.listPolicies();
  if (policies.length === 0) {
    return ok({ message: 'No policies to refresh', total: 0 }, StatusCode.OK);
  }

  await new LambdaFunctionClient(bulkLambdaName).invokeAsync();
  return ok(
    {
      message: `Refresh started for ${policies.length} ${policies.length === 1 ? 'policy' : 'policies'}`,
      total: policies.length,
    },
    StatusCode.ACCEPTED,
  );
}

// Reset cached singletons (used by tests).
export function _resetForTests(): void {
  cachedStore = null;
  cachedApplier = null;
}
