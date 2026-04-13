import type { RegionCode } from './region';
import type { AvailabilityStatus } from '../availability/availability-status';

export interface CfnResourceConfiguration {
  resourceConfigurationName: string;
  regionalAvailability: Record<RegionCode, AvailabilityStatus>;
}

export interface CfnResourceProperty {
  resourcePropertyName: string;
  resourceConfigurations: CfnResourceConfiguration[];
}

export interface CfnResourceType {
  resourceTypeName: string;
  resourceTypeHomepage: string;
  regionalAvailability: Record<RegionCode, AvailabilityStatus>;
  resourceProperties?: CfnResourceProperty[];
}

export interface CfnResource {
  serviceName: string;
  resourceTypes: CfnResourceType[];
}
