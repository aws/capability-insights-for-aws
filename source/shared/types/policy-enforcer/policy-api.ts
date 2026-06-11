import type { RegionCode } from '../capability/region';
import type { ExceptionEntry, PolicyTag } from './policy-configuration';
import type { PolicyMode, PolicyStatus, PolicyType } from './policy-enums';

/**
 * HTTP request and response shapes for the Policy Enforcer's REST API.
 * Kept separate from the persisted domain entity so that API evolutions
 * (new fields on a request body, paginated list responses, etc.) don't
 * couple the database schema to the wire shape.
 */

/** Request body for `POST /policies`. */
export interface CreatePolicyRequest {
  policyName: string;
  description?: string;
  tags?: PolicyTag[];
  regions: RegionCode[];
  mode: PolicyMode;
  policyType: PolicyType;
  exceptions?: ExceptionEntry[];
}

/**
 * Request body for `PUT /policies/:policyName`.
 *
 * `policyName` is the stable identifier and cannot be changed via update.
 * To rename a policy, delete it and create a new one.
 */
export interface UpdatePolicyRequest {
  description?: string;
  tags?: PolicyTag[];
  regions?: RegionCode[];
  mode?: PolicyMode;
  policyType?: PolicyType;
  exceptions?: ExceptionEntry[];
}

/** Query parameters for `GET /policies`. */
export interface ListPoliciesQuery {
  /** Filter by tag key. Must be combined with `tagValue`. */
  tagKey?: string;
  /** Filter by tag value. Must be combined with `tagKey`. */
  tagValue?: string;
  /** Filter by lifecycle status. */
  status?: PolicyStatus;
  /** Case-insensitive substring search across `policyName` and `description`. */
  search?: string;
}

/** Response body for `GET /policies/:policyId/preview`. */
export interface PreviewResponse {
  /** The full sorted, deduplicated allow-list. */
  actions: string[];
  actionCount: number;
  /** Number of capabilities excluded by availability filtering. */
  excludedCount: number;
  /** Number of capabilities added via exceptions. */
  exceptionCount: number;
  /** Total character count across all generated documents. */
  estimatedPolicySize: number;
  /** True when the policy must be split across multiple managed policies (IAM only). */
  splitRequired: boolean;
}

/** Response body for `POST /policies/:policyId/refresh` (and inline-refresh fields on POST/PUT). */
export interface RefreshResponse {
  message: string;
  policyArn: string;
  additionalPolicyArns?: string[];
  actionCount: number;
  splitRequired: boolean;
  totalSize: number;
}
