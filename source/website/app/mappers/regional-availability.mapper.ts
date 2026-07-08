import { ProductType, type Product } from '@capability-insights/shared/types/capability/product';
import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type { CfnResource, EnrichedCfnResourceType } from '@capability-insights/shared/types/capability/cfn';
import type {
  ProductAvailability,
  ApiAvailability,
  CfnAvailability,
} from '@capability-insights/shared/types/availability/regional-availability';
import { RegionalAvailabilityType } from '@capability-insights/shared/types/availability/regional-availability';

/**
 * Maps raw Product data to ProductAvailability rows.
 *
 * Flattens the nested childProducts structure into a flat array
 * using id/parentId references.
 *
 * The table only ever shows two levels (parent and child). Child products of
 * type SERVICE can have their own children, so they are emitted twice: once as
 * a leaf child under their parent (for context, with a synthetic id to keep
 * row ids unique), and once as a root row with their own children underneath.
 *
 * @param products - Raw product data from the client
 * @returns Flat array of rows with availability status per region
 */
export function fromProducts(products: Product[]): ProductAvailability[] {
  const rows: ProductAvailability[] = [];

  const toRow = (product: Product, parentId: string | null, id?: string): ProductAvailability => ({
    id: id ?? product.productId,
    parentId,
    name: product.productName,
    productType: product.productType,
    regionalAvailabilityType:
      product.productType === ProductType.SERVICE ? RegionalAvailabilityType.SERVICE : RegionalAvailabilityType.FEATURE,
    homepageUrl: product.homepage,
    regionDates: product.launchDates,
    regionalAvailability: product.regionalAvailability,
  });

  const emitTwoLevels = (parent: Product): void => {
    rows.push(toRow(parent, null));
    for (const child of parent.childProducts ?? []) {
      if (child.productType === ProductType.SERVICE) {
        // Leaf child row for context under its parent; the synthetic id keeps
        // it distinct from the root row emitted below.
        rows.push(toRow(child, parent.productId, `${parent.productId}:${child.productId}`));
        // Root row for the child service, with its own children underneath.
        emitTwoLevels(child);
      } else {
        rows.push(toRow(child, parent.productId));
      }
    }
  };

  for (const p of products) {
    emitTwoLevels(p);
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
 * @returns Flat array of rows with availability status per region
 */
export function fromApiServices(apis: ApiService[]): ApiAvailability[] {
  const rows: ApiAvailability[] = [];
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
        homepageUrl: op.homepage,
        regionalAvailability: op.regionalAvailability,
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
 * @returns Flat array of rows with availability status per region
 */
export function fromCfnResources(cfnResources: CfnResource[]): CfnAvailability[] {
  const rows: CfnAvailability[] = [];
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
      const rtStacks = (rt as EnrichedCfnResourceType).usage?.stacks;
      rows.push({
        id: rtId,
        parentId: svcId,
        name: rt.resourceTypeName,
        regionalAvailabilityType: RegionalAvailabilityType.RESOURCE_TYPE,
        homepageUrl: rt.resourceTypeHomepage,
        regionalAvailability: rt.regionalAvailability,
        stacks: rtStacks,
      });
      for (const prop of rt.resourceProperties ?? []) {
        const propId = `${rtId}-${prop.resourcePropertyName}`;
        rows.push({
          id: propId,
          parentId: rtId,
          name: prop.resourcePropertyName,
          regionalAvailabilityType: RegionalAvailabilityType.PROPERTY,
        });
        for (const config of prop.resourceConfigurations) {
          const configStacks = config.stacks;
          rows.push({
            id: `${propId}-${config.resourceConfigurationName}`,
            parentId: propId,
            name: config.resourceConfigurationName,
            regionalAvailabilityType: RegionalAvailabilityType.CONFIGURATION,
            regionalAvailability: config.regionalAvailability,
            stacks: configStacks,
          });
        }
      }
    }
  }
  return rows;
}
