import type { APIGatewayProxyResult } from 'aws-lambda';
import { SFNClient, ListExecutionsCommand } from '@aws-sdk/client-sfn';
import { corsHeaders } from '../types/api';
import { StatusCode } from '../constants/status-codes';
import { EnvironmentKey, getOptionalEnv } from '../constants/environment';
import { USED_CAPABILITIES_PROBE_KEY } from '../constants/data-paths';
import { S3BucketClient } from '../services/s3-client';
import { logger, errorFields } from '../util/logger';
import type {
  FeatureFlags,
  UsageAnalysisFeatureFlag,
  PolicyEnforcerFeatureFlag,
  ExecutionStatusValue,
} from '@capability-insights/shared/types/feature-flags';

/**
 * In-memory cache for the response. Page navigation triggers redundant
 * GET /features calls; caching avoids hitting Step Functions on every page
 * load. TTL is short enough that a fresh deploy or analysis run shows up
 * within a minute, and can be overridden via FEATURES_CACHE_TTL_MS.
 */
const DEFAULT_CACHE_TTL_MS = 60_000;

function getCacheTtlMs(): number {
  const raw = getOptionalEnv(EnvironmentKey.FEATURES_CACHE_TTL_MS);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CACHE_TTL_MS;
}

let cachedResponse: { value: FeatureFlags; expiresAt: number } | null = null;

const sfnClient = new SFNClient({});

/**
 * GET /features — returns the deploy-time state of every opt-in feature in
 * one fetch.
 *
 * The frontend uses this to decide whether to surface feature controls
 * (e.g. the My Stuff toggle, Policy Enforcer nav link) and what state to
 * render them in. A feature is "enabled" when its CloudFormation stack is
 * deployed — detected by the presence of stack-output env vars on the
 * API Lambda.
 */
export async function getFeaturesRoute(): Promise<APIGatewayProxyResult> {
  const cached = readCache();
  if (cached) {
    return ok(cached);
  }

  const [usageAnalysis, policyEnforcer] = await Promise.all([loadUsageAnalysisFlag(), loadPolicyEnforcerFlag()]);

  const flags: FeatureFlags = { usageAnalysis, policyEnforcer };
  writeCache(flags);
  return ok(flags);
}

function ok(flags: FeatureFlags): APIGatewayProxyResult {
  return {
    statusCode: StatusCode.OK,
    headers: corsHeaders,
    body: JSON.stringify(flags),
  };
}

function readCache(): FeatureFlags | null {
  if (cachedResponse && Date.now() < cachedResponse.expiresAt) {
    return cachedResponse.value;
  }
  return null;
}

function writeCache(value: FeatureFlags): void {
  cachedResponse = { value, expiresAt: Date.now() + getCacheTtlMs() };
}

/**
 * Resets the in-memory cache. Used by tests to ensure a deterministic state
 * across runs; not exported from the route bundle in production.
 */
export function _resetFeaturesCacheForTests(): void {
  cachedResponse = null;
}

async function loadUsageAnalysisFlag(): Promise<UsageAnalysisFeatureFlag> {
  const stateMachineArn = getOptionalEnv(EnvironmentKey.ANALYSIS_STATE_MACHINE_ARN);
  if (!stateMachineArn) {
    return { enabled: false };
  }

  const flag: UsageAnalysisFeatureFlag = { enabled: true };

  // Last execution metadata. Tolerate failures here: if SFN is unreachable
  // we still want to report the feature as enabled rather than failing the
  // entire response. The UI can recover by polling status separately.
  try {
    const executions = await sfnClient.send(
      new ListExecutionsCommand({
        stateMachineArn,
        maxResults: 1,
      }),
    );
    const latest = executions.executions?.[0];
    if (latest) {
      flag.lastExecutionStatus = latest.status as ExecutionStatusValue | undefined;
      flag.lastExecutionTime = (latest.stopDate ?? latest.startDate)?.toISOString();
    }
  } catch (e) {
    logger.warn('Failed to list state machine executions', errorFields(e));
  }

  // Probe for personalized data. A successful execution should produce the
  // combined file; absence means either no successful run yet or a partial
  // failure where the decorator never wrote.
  flag.hasResults = await probeUsedCapabilitiesFile();

  return flag;
}

async function probeUsedCapabilitiesFile(): Promise<boolean> {
  const websiteBucket = getOptionalEnv(EnvironmentKey.WEBSITE_BUCKET_NAME);
  if (!websiteBucket) return false;
  try {
    const s3 = new S3BucketClient(websiteBucket);
    await s3.getObject(USED_CAPABILITIES_PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

async function loadPolicyEnforcerFlag(): Promise<PolicyEnforcerFeatureFlag> {
  // The Policy Enforcer feature wires three env vars from its stack output;
  // the table name is the canonical "deployed" signal.
  const policyTableName = getOptionalEnv(EnvironmentKey.POLICY_TABLE_NAME);
  return { enabled: Boolean(policyTableName) };
}
