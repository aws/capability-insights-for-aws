import { AvailabilityStatus } from './availability/availability-status';
import type { RegionCode } from './capability/region';
import type { Product } from './capability/product';
import type { ApiService, ApiOperation } from './capability/api';
import type { CfnResource, CfnResourceType } from './capability/cfn';
import type { UsedCapabilities } from './used-capabilities';

/**
 * Deterministic capability-query core.
 *
 * Pure, side-effect-free functions over already-loaded catalog data
 * (the `data/json/*.json` snapshots). This is the single source of truth for
 * "is X available in region Y", region diffs, and usage gaps — shared by:
 *   - HTTP read routes the website calls (deterministic UI), and
 *   - the chat agent's tool executor (the agent ROUTES to these; it never
 *     eyeballs the JSON itself, so lookups cannot hallucinate).
 *
 * No I/O lives here: callers load the catalog (e.g. via `S3BucketClient` +
 * `CatalogKey`, exactly as `policy-routes.loadCatalog` does) and pass the
 * parsed arrays in. That keeps every function trivially unit-testable.
 *
 * Availability semantics intentionally match `policy-enforcer/allow-list-engine`:
 * an entity is "available" in a region only when its `regionalAvailability`
 * for that region is exactly {@link AvailabilityStatus.AVAILABLE}. Any other
 * status — or a missing entry — is treated as NOT available.
 */

/** The region→status map carried by every catalog entity. */
export type RegionalAvailabilityMap = Record<RegionCode, AvailabilityStatus>;

/** Minimal shape shared by Products, API operations, and CFN resource types. */
interface HasRegionalAvailability {
  regionalAvailability?: RegionalAvailabilityMap;
}

/**
 * Core predicate. True only when `availability[region]` is exactly
 * `Available`. Missing data (undefined map or missing key) is NOT available,
 * matching the allow-list engine so the agent and policy engine never
 * disagree about what "available" means.
 */
export function isAvailableIn(availability: RegionalAvailabilityMap | undefined, region: RegionCode): boolean {
  return availability?.[region] === AvailabilityStatus.AVAILABLE;
}

/** Regions (sorted) where the given availability map is `Available`. */
export function availableRegions(availability: RegionalAvailabilityMap | undefined): RegionCode[] {
  if (!availability) return [];
  return Object.keys(availability)
    .filter(region => availability[region] === AvailabilityStatus.AVAILABLE)
    .sort();
}

/**
 * Flatten a product tree into a single list including nested `childProducts`
 * (features). Catalog products nest features one or more levels deep; most
 * queries want to consider both services and their features.
 */
export function flattenProducts(products: readonly Product[]): Product[] {
  const out: Product[] = [];
  const visit = (p: Product): void => {
    out.push(p);
    p.childProducts?.forEach(visit);
  };
  products.forEach(visit);
  return out;
}

/** True when `product` is available in `region`. */
export function isProductAvailable(product: Product, region: RegionCode): boolean {
  return isAvailableIn(product.regionalAvailability, region);
}

/** True when an API operation is available in `region`. */
export function isApiOperationAvailable(operation: ApiOperation, region: RegionCode): boolean {
  return isAvailableIn(operation.regionalAvailability, region);
}

/** True when a CFN resource type is available in `region`. */
export function isCfnResourceTypeAvailable(resourceType: CfnResourceType, region: RegionCode): boolean {
  return isAvailableIn(resourceType.regionalAvailability, region);
}

/**
 * Find products by free-text `query` (the natural-language entry point).
 * Matches case-insensitively on `productName` substring or exact `productId`,
 * searching the flattened tree (services + features). Empty/blank query
 * returns no matches rather than everything.
 */
export function findProducts(products: readonly Product[], query: string): Product[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return flattenProducts(products).filter(
    p => p.productName.toLowerCase().includes(needle) || p.productId.toLowerCase() === needle,
  );
}

/** Products available in `region` (flattened to include features). */
export function productsAvailableInRegion(products: readonly Product[], region: RegionCode): Product[] {
  return flattenProducts(products).filter(p => isProductAvailable(p, region));
}

/** Products NOT available in `region` (flattened). The "what's missing here" query. */
export function productsNotAvailableInRegion(products: readonly Product[], region: RegionCode): Product[] {
  return flattenProducts(products).filter(p => !isProductAvailable(p, region));
}

/** Result of comparing entity availability across two regions. */
export interface RegionDiff<T> {
  regionA: RegionCode;
  regionB: RegionCode;
  /** Available in A but not B. */
  onlyInA: T[];
  /** Available in B but not A. */
  onlyInB: T[];
  /** Available in both. */
  inBoth: T[];
  /** In the catalog but available in neither region. */
  inNeither: T[];
}

/**
 * Partition any availability-bearing entities by how they compare across two
 * regions. Generic over Products, API operations, and CFN resource types
 * (anything with `regionalAvailability`). The "diff two regions" query.
 */
export function diffRegions<T extends HasRegionalAvailability>(
  items: readonly T[],
  regionA: RegionCode,
  regionB: RegionCode,
): RegionDiff<T> {
  const diff: RegionDiff<T> = { regionA, regionB, onlyInA: [], onlyInB: [], inBoth: [], inNeither: [] };
  for (const item of items) {
    const inA = isAvailableIn(item.regionalAvailability, regionA);
    const inB = isAvailableIn(item.regionalAvailability, regionB);
    if (inA && inB) diff.inBoth.push(item);
    else if (inA) diff.onlyInA.push(item);
    else if (inB) diff.onlyInB.push(item);
    else diff.inNeither.push(item);
  }
  return diff;
}

/** An API operation paired with its owning service (for gap reporting). */
export interface ApiOperationRef {
  service: ApiService;
  operation: ApiOperation;
}

/** A CFN resource type paired with its owning service (for gap reporting). */
export interface CfnResourceTypeRef {
  service: CfnResource;
  resourceType: CfnResourceType;
}

/**
 * The capabilities a user actually uses ("My stuff") that are NOT available
 * in a given target region. Computed per target region so the caller can
 * say "if you expand to <region>, these N things you use won't be there yet".
 */
export interface UsageGap {
  targetRegion: RegionCode;
  unavailableProducts: Product[];
  unavailableApis: ApiOperationRef[];
  unavailableCfnResourceTypes: CfnResourceTypeRef[];
}

/**
 * For each target region, compute which used products / API operations / CFN
 * resource types are not yet available there. This is the highest-value
 * planning query: "what that I depend on is missing in the regions I want to
 * expand into." Requires Usage Analysis data (the `used-capabilities-*.json`
 * file); callers must gate on the feature being enabled before invoking.
 */
export function usedButUnavailable(used: UsedCapabilities, targetRegions: readonly RegionCode[]): UsageGap[] {
  const flatProducts = flattenProducts(used.products);
  return targetRegions.map(targetRegion => {
    const unavailableProducts = flatProducts.filter(p => !isProductAvailable(p, targetRegion));

    const unavailableApis: ApiOperationRef[] = [];
    for (const service of used.apis) {
      for (const operation of service.apis) {
        if (!isApiOperationAvailable(operation, targetRegion)) {
          unavailableApis.push({ service, operation });
        }
      }
    }

    const unavailableCfnResourceTypes: CfnResourceTypeRef[] = [];
    for (const service of used.cfnResources) {
      for (const resourceType of service.resourceTypes) {
        if (!isCfnResourceTypeAvailable(resourceType, targetRegion)) {
          unavailableCfnResourceTypes.push({ service, resourceType });
        }
      }
    }

    return { targetRegion, unavailableProducts, unavailableApis, unavailableCfnResourceTypes };
  });
}
