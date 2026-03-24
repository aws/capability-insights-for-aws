import type { RegionCode } from './region';

export interface CfnResourceConfiguration {
  resourceConfigurationName: string;
  availableInRegions: RegionCode[];
}

export interface CfnResourceProperty {
  resourcePropertyName: string;
  resourceConfigurations: CfnResourceConfiguration[];
}

export interface CfnResourceType {
  resourceTypeName: string;
  resourceTypeHomepage: string;
  availableInRegions: RegionCode[];
  notAvailableInRegions: RegionCode[];
  resourceProperties?: CfnResourceProperty[];
}

export interface CfnResource {
  serviceName: string;
  resourceTypes: CfnResourceType[];
}
