import { ProductType, type Product } from '@capability-insights/shared/types/capability/product';
import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type { CfnResource } from '@capability-insights/shared/types/capability/cfn';
import type { RegionCode } from '@capability-insights/shared/types/capability/region';
import type {
  ProductAvailability,
  ApiAvailability,
  CfnAvailability,
  RegionalAvailabilityRow,
} from '@capability-insights/shared/types/availability/regional-availability';
import { RegionalAvailabilityType } from '@capability-insights/shared/types/availability/regional-availability';
import {
  fromApiOperation,
  fromCfnResourceType,
  fromCfnResourceConfiguration,
  fromProductRegionalAvailability,
} from './availability-status.mapper';

/**
 * Maps raw Product data to ProductAvailability rows.
 *
 * Flattens the nested childProducts structure into a flat array
 * using id/parentId references.
 *
 * @param products - Raw product data from the client
 * @param regionCodes - Regions to map availability status for
 * @returns Flat array of rows with availability status per region
 */
export function fromProducts(
  products: Product[],
  regionCodes: RegionCode[],
): RegionalAvailabilityRow<ProductAvailability>[] {
  const rows: RegionalAvailabilityRow<ProductAvailability>[] = [];

  const toRow = (product: Product, parentId: string | null): RegionalAvailabilityRow<ProductAvailability> => ({
    id: product.productId,
    parentId,
    name: product.productName,
    productType: product.productType,
    regionalAvailabilityType:
      product.productType === ProductType.SERVICE ? RegionalAvailabilityType.SERVICE : RegionalAvailabilityType.FEATURE,
    homepageUrl: product.homepage,
    regionDates: product.regionalAvailability.productRegionLaunchDate,
    ...Object.fromEntries(regionCodes.map(r => [r, fromProductRegionalAvailability(r, product.regionalAvailability)])),
  });

  for (const p of products) {
    rows.push(toRow(p, null));
    for (const child of p.childProducts ?? []) {
      rows.push(toRow(child, p.productId));
    }
  }

  return rows;
}

/**
 * Maps raw ApiService data to ApiAvailability rows.
 *
 * Flattens the nested apis (operations) structure into a flat array
 * using id/parentId references.
 *
 * @param apis - Raw API service data from the client
 * @param regionCodes - Regions to map availability status for
 * @returns Flat array of rows with availability status per region
 */
export function fromApiServices(
  apis: ApiService[],
  regionCodes: RegionCode[],
): RegionalAvailabilityRow<ApiAvailability>[] {
  const rows: RegionalAvailabilityRow<ApiAvailability>[] = [];
  for (const svc of apis) {
    const svcId = `svc-${svc.sdkServiceName}`;
    rows.push({
      id: svcId,
      parentId: null,
      name: svc.sdkServiceFullName,
      regionalAvailabilityType: RegionalAvailabilityType.SDK_SERVICE,
      sdkServiceName: svc.sdkServiceName,
      productName: svc.productName,
    });
    for (const op of svc.apis) {
      rows.push({
        id: op.apiName,
        parentId: svcId,
        name: op.apiAction,
        regionalAvailabilityType: RegionalAvailabilityType.OPERATION,
        sdkServiceName: svc.sdkServiceName,
        productName: svc.productName,
        homepageUrl: op.homepage,
        ...Object.fromEntries(regionCodes.map(r => [r, fromApiOperation(r, op)])),
      });
    }
  }
  return rows;
}

/**
 * Maps raw CfnResource data to CfnAvailability rows.
 *
 * Flattens the nested resourceTypes structure into a flat array
 * using id/parentId references.
 *
 * @param cfnResources - Raw CloudFormation resource data from the client
 * @param regionCodes - Regions to map availability status for
 * @returns Flat array of rows with availability status per region
 */
export function fromCfnResources(
  cfnResources: CfnResource[],
  regionCodes: RegionCode[],
): RegionalAvailabilityRow<CfnAvailability>[] {
  const rows: RegionalAvailabilityRow<CfnAvailability>[] = [];
  for (const svc of cfnResources) {
    const svcId = `cfn-${svc.serviceName}`;
    rows.push({
      id: svcId,
      parentId: null,
      name: svc.serviceName,
      regionalAvailabilityType: RegionalAvailabilityType.SERVICE,
      serviceName: svc.serviceName,
    });
    for (const rt of svc.resourceTypes) {
      const rtId = `${svcId}-${rt.resourceTypeName}`;
      rows.push({
        id: rtId,
        parentId: svcId,
        name: rt.resourceTypeName,
        regionalAvailabilityType: RegionalAvailabilityType.RESOURCE_TYPE,
        serviceName: svc.serviceName,
        homepageUrl: rt.resourceTypeHomepage,
        ...Object.fromEntries(regionCodes.map(r => [r, fromCfnResourceType(r, rt)])),
      });
      for (const prop of rt.resourceProperties ?? []) {
        const propId = `${rtId}-${prop.resourcePropertyName}`;
        rows.push({
          id: propId,
          parentId: rtId,
          name: prop.resourcePropertyName,
          regionalAvailabilityType: RegionalAvailabilityType.PROPERTY,
          serviceName: svc.serviceName,
        });
        for (const config of prop.resourceConfigurations) {
          rows.push({
            id: `${propId}-${config.resourceConfigurationName}`,
            parentId: propId,
            name: config.resourceConfigurationName,
            regionalAvailabilityType: RegionalAvailabilityType.CONFIGURATION,
            serviceName: svc.serviceName,
            ...Object.fromEntries(regionCodes.map(r => [r, fromCfnResourceConfiguration(r, config)])),
          });
        }
      }
    }
  }
  return rows;
}
