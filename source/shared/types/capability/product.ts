import type { RegionCode } from './region';

export type ProductId = string;

export enum ProductType {
  SERVICE = 'SERVICE',
  FEATURE = 'FEATURE',
}

export interface ProductRegionalAvailability {
  isAvailableIn?: RegionCode[];
  isPlannedIn?: RegionCode[];
  isBeingPlannedIn?: RegionCode[];
  isNotExpandingIn?: RegionCode[];
  productRegionLaunchDate?: Record<RegionCode, string>;
}

export interface Product {
  productId: ProductId;
  productName: string;
  productType: ProductType;
  homepage?: string;
  regionalAvailability: ProductRegionalAvailability;
  childProducts?: Product[];
}
