/**
 * Deploy-time state of opt-in features. Returned by `GET /features` so the
 * frontend can render the right UI for each feature without trial-and-error
 * probing of feature-specific endpoints.
 *
 * A feature is "enabled" when its CloudFormation stack is deployed (the API
 * Lambda has the env vars wired up). Each feature reports any extra
 * runtime state needed by the UI (e.g. last analysis run for Usage Analysis).
 *
 * Designed to be additive: adding a new feature flag does not require
 * removing anything existing. Clients should treat unknown fields as
 * absent and tolerate missing optional sub-fields.
 */
export interface FeatureFlags {
  usageAnalysis: UsageAnalysisFeatureFlag;
  policyEnforcer: PolicyEnforcerFeatureFlag;
}

/** State of an execution as reported by Step Functions ListExecutions. */
export type ExecutionStatusValue = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'ABORTED';

export interface UsageAnalysisFeatureFlag {
  /** True when the Usage Analysis stack is deployed (env vars present). */
  enabled: boolean;
  /**
   * ISO-8601 timestamp of the most recent state machine execution (any status).
   * Absent when no executions exist yet, or when `enabled` is false.
   */
  lastExecutionTime?: string;
  /**
   * Status of the most recent execution. Absent when no executions exist yet.
   * `SUCCEEDED` is the only status where `hasResults` is expected to be true.
   */
  lastExecutionStatus?: ExecutionStatusValue;
  /**
   * True when at least one personalized data file (e.g. used-capabilities-*.json)
   * is available in the website bucket. Absent when `enabled` is false.
   */
  hasResults?: boolean;
}

export interface PolicyEnforcerFeatureFlag {
  /** True when the Policy Enforcer stack is deployed (env vars present). */
  enabled: boolean;
}
