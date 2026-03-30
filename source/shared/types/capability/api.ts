import type { ProductId } from './product';
import type { RegionCode } from './region';
import type { AvailabilityStatus } from '../availability/availability-status';

export interface ApiOperation {
  apiName: string;
  apiAction: string;
  homepage: string;
  regionalAvailability: Record<RegionCode, AvailabilityStatus>;
}

export interface ApiService {
  sdkServiceName: string;
  sdkServiceFullName: string;
  productID?: ProductId;
  productName?: string;
  apis: ApiOperation[];
}
