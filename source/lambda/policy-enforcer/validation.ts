import type {
  CreatePolicyRequest,
  UpdatePolicyRequest,
} from '@capability-insights/shared/types/policy-enforcer/policy-api';
import {
  PolicyMode,
  PolicyType,
  VALID_POLICY_MODES,
  VALID_POLICY_TYPES,
} from '@capability-insights/shared/types/policy-enforcer/policy-enums';

/**
 * Format for a single `ExceptionEntry.action`:
 *   - service prefix: lowercase letters, digits, or hyphens (e.g. `s3`,
 *     `elasticloadbalancing`, `rds-data`)
 *   - colon
 *   - either a PascalCase action name (e.g. `GetObject`) or a wildcard `*`
 */
const EXCEPTION_ENTRY_PATTERN = /^[a-zA-Z0-9-]+:(([A-Z][a-zA-Z0-9]*)|(\*))$/;

/**
 * Returns true iff `action` matches the canonical `service:Action` or
 * `service:*` shape.
 */
export function validateExceptionEntry(action: string): boolean {
  return EXCEPTION_ENTRY_PATTERN.test(action);
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a `CreatePolicyRequest` against the rules in Requirement 1, 2, 5,
 * and the validation pieces of 6 and 7. Returns all violations found.
 */
export function validatePolicyConfiguration(req: CreatePolicyRequest): ValidationResult {
  const errors: string[] = [];

  if (!req.policyName || req.policyName.trim().length === 0) {
    errors.push('policyName is required');
  }

  if (!Array.isArray(req.regions) || req.regions.length === 0) {
    errors.push('regions must be a non-empty array');
  }

  if (!VALID_POLICY_MODES.includes(req.mode as PolicyMode)) {
    errors.push(`mode must be one of: ${VALID_POLICY_MODES.join(', ')}`);
  }

  if (!VALID_POLICY_TYPES.includes(req.policyType as PolicyType)) {
    errors.push(`policyType must be one of: ${VALID_POLICY_TYPES.join(', ')}`);
  }

  if (req.exceptions) {
    for (const exception of req.exceptions) {
      if (!validateExceptionEntry(exception.action)) {
        errors.push(`Invalid exception action format: "${exception.action}"`);
      }
    }
  }

  if (req.tags) {
    for (const tag of req.tags) {
      if (!tag.key || tag.key.trim().length === 0) {
        errors.push('Tag keys must be non-empty');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates fields of an `UpdatePolicyRequest` that are present. Allows
 * partial updates: any field that is omitted is not validated.
 *
 * Note that `UpdatePolicyRequest` deliberately omits `policyName` from its
 * shape (the type system rejects it at compile time). At runtime any extra
 * `policyName` key that sneaks in via JSON is silently ignored by both the
 * route handler and the store's update method.
 */
export function validatePolicyUpdate(req: UpdatePolicyRequest): ValidationResult {
  const errors: string[] = [];

  if (req.regions !== undefined && (!Array.isArray(req.regions) || req.regions.length === 0)) {
    errors.push('regions must be a non-empty array when provided');
  }

  if (req.mode !== undefined && !VALID_POLICY_MODES.includes(req.mode as PolicyMode)) {
    errors.push(`mode must be one of: ${VALID_POLICY_MODES.join(', ')}`);
  }

  if (req.policyType !== undefined && !VALID_POLICY_TYPES.includes(req.policyType as PolicyType)) {
    errors.push(`policyType must be one of: ${VALID_POLICY_TYPES.join(', ')}`);
  }

  if (req.exceptions) {
    for (const exception of req.exceptions) {
      if (!validateExceptionEntry(exception.action)) {
        errors.push(`Invalid exception action format: "${exception.action}"`);
      }
    }
  }

  if (req.tags) {
    for (const tag of req.tags) {
      if (!tag.key || tag.key.trim().length === 0) {
        errors.push('Tag keys must be non-empty');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
