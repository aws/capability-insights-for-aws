import type { ProductId } from './product';
import type { RegionCode } from './region';

export interface ApiOperation {
  apiName: string;
  apiAction: string;
  homepage: string;
  availableInRegions: RegionCode[];
}

export interface ApiService {
  sdkServiceName: string;
  sdkServiceFullName: string;
  productID: ProductId;
  productName: string;
  apis: ApiOperation[];
}
