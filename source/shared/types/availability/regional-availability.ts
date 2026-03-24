import type { RegionCode } from '../capability/region';

export enum RegionalAvailabilityType {
  SERVICE = 'Service',
  FEATURE = 'Feature',
  SDK_SERVICE = 'SDK Service',
  OPERATION = 'Operation',
  RESOURCE_TYPE = 'Resource Type',
  PROPERTY = 'Property',
  CONFIGURATION = 'Configuration',
}

export interface RegionalAvailability {
  id: string;
  parentId: string | null;
  name: string;
  regionalAvailabilityType: RegionalAvailabilityType;
  homepageUrl?: string;
  regionDates?: Record<RegionCode, string>;
}

export interface ApiAvailability extends RegionalAvailability {
  sdkServiceName: string;
  productName: string;
}

export interface CfnAvailability extends RegionalAvailability {
  serviceName: string;
}

export interface ProductAvailability extends RegionalAvailability {
  productType: string;
}

export type RegionalAvailabilityRow<T extends RegionalAvailability> = T & Record<string, unknown>;
