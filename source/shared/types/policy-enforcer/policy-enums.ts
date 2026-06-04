/**
 * Enumerated constants used across the Policy Enforcer's domain entity, API
 * request/response shapes, and runtime engine. Kept in their own module so
 * that consumers that only need the enums (the validation utilities, the
 * Web UI's wizard) don't pull in the entity or API types.
 */

/**
 * Policy types supported by the Policy Enforcer.
 *
 * - `IAM`: AWS IAM Managed Policy. Can be split across multiple policies if a
 *   single document would exceed the 6,144-char limit.
 * - `SCP`: AWS Organizations Service Control Policy. Hard 5,120-char limit;
 *   policies that would exceed this return an error rather than splitting.
 */
export const PolicyType = {
  IAM: 'IAM',
  SCP: 'SCP',
} as const;
export type PolicyType = (typeof PolicyType)[keyof typeof PolicyType];

/**
 * Computation mode for the Allow_List.
 *
 * - `intersection` (default): a capability is allowed only if it is Available
 *   in ALL selected regions.
 * - `union`: a capability is allowed if it is Available in AT LEAST ONE
 *   selected region.
 *
 * The Web UI only emits `intersection`; `union` is retained on the engine
 * side because the design's correctness properties exercise it.
 */
export const PolicyMode = {
  INTERSECTION: 'intersection',
  UNION: 'union',
} as const;
export type PolicyMode = (typeof PolicyMode)[keyof typeof PolicyMode];

/** Lifecycle status of a Policy_Configuration. */
export const PolicyStatus = {
  PENDING: 'pending',
  ACTIVE: 'active',
  ERROR: 'error',
} as const;
export type PolicyStatus = (typeof PolicyStatus)[keyof typeof PolicyStatus];

/** Outcome of the most recent refresh attempt for a Policy_Configuration. */
export const RefreshOutcome = {
  SUCCESS: 'success',
  ERROR: 'error',
} as const;
export type RefreshOutcome = (typeof RefreshOutcome)[keyof typeof RefreshOutcome];

export const VALID_POLICY_MODES: PolicyMode[] = [PolicyMode.INTERSECTION, PolicyMode.UNION];
export const VALID_POLICY_TYPES: PolicyType[] = [PolicyType.IAM, PolicyType.SCP];
