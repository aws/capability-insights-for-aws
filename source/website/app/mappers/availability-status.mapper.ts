import type { RegionCode } from '@capability-insights/shared/types/capability/region';
import type { ProductRegionalAvailability } from '@capability-insights/shared/types/capability/product';
import type { ApiOperation } from '@capability-insights/shared/types/capability/api';
import type { CfnResourceType, CfnResourceConfiguration } from '@capability-insights/shared/types/capability/cfn';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';

/**
 * Maps ProductRegionalAvailability to an AvailabilityStatus for a given region.
 *
 * @param regionCode - Region to check availability for
 * @param ra - Raw product regional availability data from the client
 * @returns AvailabilityStatus if explicitly set, null if unknown
 */
export function fromProductRegionalAvailability(
  regionCode: RegionCode,
  ra: ProductRegionalAvailability,
): AvailabilityStatus | null {
  if (ra.isAvailableIn?.includes(regionCode)) return AvailabilityStatus.AVAILABLE;
  if (ra.isPlannedIn?.includes(regionCode)) return AvailabilityStatus.PLANNED;
  if (ra.isBeingPlannedIn?.includes(regionCode)) return AvailabilityStatus.BEING_PLANNED;
  if (ra.isNotExpandingIn?.includes(regionCode)) return AvailabilityStatus.NOT_EXPANDING;
  return null;
}

/**
 * Maps ApiOperation to an AvailabilityStatus for a given region.
 *
 * @param regionCode - Region to check availability for
 * @param op - Raw API operation data from the client
 * @returns AvailabilityStatus if explicitly set, null if unknown
 */
export function fromApiOperation(regionCode: RegionCode, op: ApiOperation): AvailabilityStatus | null {
  if (op.availableInRegions.includes(regionCode)) return AvailabilityStatus.AVAILABLE;
  return null;
}

/**
 * Maps CfnResourceType to an AvailabilityStatus for a given region.
 *
 * @param regionCode - Region to check availability for
 * @param rt - Raw CloudFormation resource type data from the client
 * @returns AvailabilityStatus if explicitly set, null if unknown
 */
export function fromCfnResourceType(regionCode: RegionCode, rt: CfnResourceType): AvailabilityStatus | null {
  if (rt.availableInRegions?.includes(regionCode)) return AvailabilityStatus.AVAILABLE;
  if (rt.notAvailableInRegions?.includes(regionCode)) return AvailabilityStatus.NOT_AVAILABLE;
  return AvailabilityStatus.NOT_AVAILABLE;
}

/**
 * Maps CfnResourceConfiguration to an AvailabilityStatus for a given region.
 *
 * @param regionCode - Region to check availability for
 * @param rc - Raw CloudFormation resource configuration data from the client
 * @returns AvailabilityStatus if explicitly set, null if unknown
 */
export function fromCfnResourceConfiguration(
  regionCode: RegionCode,
  rc: CfnResourceConfiguration,
): AvailabilityStatus | null {
  if (rc.availableInRegions?.includes(regionCode)) return AvailabilityStatus.AVAILABLE;
  return null;
}
