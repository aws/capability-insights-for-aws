import type { RegionCode } from '../capability/region';
import type { PolicyMode, PolicyStatus, PolicyType, RefreshOutcome } from './policy-enums';

/**
 * The persisted domain entity for a Policy_Configuration plus its supporting
 * value types. Enums live in `policy-enums.ts`; HTTP request/response shapes
 * live in `policy-api.ts`.
 */

/**
 * Key-value tag attached to a Policy_Configuration. Used for organizing
 * policies by team, environment, application, etc. Propagated to AWS resource
 * tags on the generated managed policy.
 */
export interface PolicyTag {
  key: string;
  value: string;
}

/**
 * A capability the user opts to include in the Allow_List regardless of
 * regional availability. Format: `service:Action` or `service:*`.
 */
export interface ExceptionEntry {
  /** Format: `^[a-zA-Z0-9-]+:(([A-Z][a-zA-Z0-9]*)|(\*))$` */
  action: string;
  /** Optional rationale captured at exception-add time. */
  reason?: string;
  /** ISO 8601 timestamp of when the exception was added. */
  addedAt: string;
}

/**
 * The persisted user inputs that drive policy generation, plus cached output
 * state from the most recent refresh.
 *
 * The composite key `(accountId, policyName)` is the policy's stable
 * identifier — there is no separate UUID. `policyName` is therefore
 * **immutable**; renames require a delete + create cycle.
 *
 * Inputs (must be stored to allow recompute against tomorrow's catalog):
 *   policyName, description, tags, regions, mode, policyType,
 *   exceptions, createdAt, updatedAt
 *
 * Cached output (derived; could be re-derived from iam:GetPolicy):
 *   status, policyArn, additionalPolicyArns, lastRefreshTime,
 *   lastRefreshOutcome, lastActionCount
 */
export interface PolicyConfiguration {
  /**
   * User-friendly unique name. Required to be unique within an account.
   * Used as the canonical identifier in URLs and as the DynamoDB sort key.
   * Also drives the IAM/SCP resource name (sanitized + `PolicyEnforcer-`
   * prefix). Renaming after creation is not supported.
   */
  policyName: string;
  description?: string;
  tags: PolicyTag[];
  regions: RegionCode[];
  mode: PolicyMode;
  policyType: PolicyType;
  exceptions: ExceptionEntry[];
  status: PolicyStatus;
  /** ARN of the primary generated managed policy (set after first refresh). */
  policyArn?: string;
  /** Additional ARNs when the policy had to be split across documents (IAM only). */
  additionalPolicyArns?: string[];
  lastRefreshTime?: string;
  lastRefreshOutcome?: RefreshOutcome;
  lastActionCount?: number;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}
