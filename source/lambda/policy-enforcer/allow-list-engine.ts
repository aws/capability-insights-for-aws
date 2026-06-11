import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type { PolicyConfiguration } from '@capability-insights/shared/types/policy-enforcer/policy-configuration';
import { PolicyMode } from '@capability-insights/shared/types/policy-enforcer/policy-enums';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import { toIamAction } from './iam-action-mapping';

export interface AllowListInput {
  catalogData: ApiService[];
  configuration: PolicyConfiguration;
}

export interface AllowListResult {
  /** Sorted list of IAM actions (e.g. `s3:GetObject`). */
  actions: string[];
  actionCount: number;
  /** Number of capabilities excluded by the availability filter. */
  excludedCount: number;
  /** Number of distinct exception actions added that weren't already in the set. */
  exceptionCount: number;
}

/**
 * Pure function: computes the Allow_List from catalog data and configuration.
 * No side effects, deterministic for identical inputs.
 *
 * Mode semantics:
 *   - intersection: include only if Available in ALL selected regions
 *   - union: include if Available in AT LEAST ONE selected region
 *
 * Missing availability data for a region is treated as "Not Available",
 * which excludes the capability from intersection and may exclude it from
 * union (depending on other regions).
 *
 * Exceptions are always included regardless of availability.
 *
 * Output is sorted alphabetically and deduplicated.
 */
export function computeAllowList(input: AllowListInput): AllowListResult {
  const { catalogData, configuration } = input;
  const { regions, mode, exceptions } = configuration;

  const allowSet = new Set<string>();
  let excludedCount = 0;

  for (const service of catalogData) {
    for (const operation of service.apis) {
      const iamAction = toIamAction(service.sdkServiceName, operation.apiAction, operation.homepage);
      const included =
        mode === PolicyMode.INTERSECTION
          ? regions.every(region => operation.regionalAvailability[region] === AvailabilityStatus.AVAILABLE)
          : regions.some(region => operation.regionalAvailability[region] === AvailabilityStatus.AVAILABLE);

      if (included) {
        allowSet.add(iamAction);
      } else {
        excludedCount++;
      }
    }
  }

  // Add exceptions regardless of availability. Count the distinct ones that
  // weren't already added by the availability filter.
  let exceptionCount = 0;
  for (const exception of exceptions) {
    if (!allowSet.has(exception.action)) {
      exceptionCount++;
    }
    allowSet.add(exception.action);
  }

  const actions = Array.from(allowSet).sort();

  return {
    actions,
    actionCount: actions.length,
    excludedCount,
    exceptionCount,
  };
}
