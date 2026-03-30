import type { RegionCode } from './region';
import type { AvailabilityStatus } from '../availability/availability-status';

export type ProductId = string;

export enum ProductType {
  SERVICE = 'SERVICE',
  FEATURE = 'FEATURE',
}

export interface Product {
  productId: ProductId;
  productName: string;
  productType: ProductType;
  homepage?: string;
  regionalAvailability: Record<RegionCode, AvailabilityStatus>;
  launchDates?: Record<RegionCode, string>;
  childProducts?: Product[];
}
