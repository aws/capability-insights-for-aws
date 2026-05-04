import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type { Product } from '@capability-insights/shared/types/capability/product';

/**
 * CloudTrail usage data shape as produced by the CloudTrail Analyzer.
 * Keyed by account ID → service name → API list and regional breakdown.
 */
export interface CloudTrailUsage {
  [accountId: string]: {
    [serviceName: string]: {
      apis: string[];
      regionApis: { [region: string]: string[] };
    };
  };
}

export interface UsageMatch {
  eventSource: string;
  service?: ApiService;
  product?: Product;
  features: Product[];
  apis: string[];
  callCount: number;
}

/** Matches CloudTrail event sources to capability catalog products and API services. */
export function matchCloudTrailToCapabilities(
  cloudTrailUsage: CloudTrailUsage,
  apiServices: ApiService[],
  products: Product[],
): Record<string, UsageMatch[]> {
  const matchesByAccount: Record<string, UsageMatch[]> = {};

  for (const [accountId, services] of Object.entries(cloudTrailUsage)) {
    matchesByAccount[accountId] = [];

    for (const [eventSource, data] of Object.entries(services)) {
      const cleaned = eventSource.replace('.amazonaws.com', '').toLowerCase();

      // Match to ApiService
      const apiService = apiServices.find(s => s.sdkServiceName.toLowerCase() === cleaned);

      // Match to Product
      const product = products.find(
        p => p.productId.toLowerCase() === cleaned || p.productName.toLowerCase().includes(cleaned),
      );

      // Extract features
      const features = product?.childProducts || [];

      matchesByAccount[accountId].push({
        eventSource,
        service: apiService,
        product,
        features,
        apis: data.apis,
        callCount: data.apis.length,
      });
    }
  }

  return matchesByAccount;
}

export function filterUsedServices(allServices: ApiService[], cloudTrailUsage: CloudTrailUsage): ApiService[] {
  const usedServiceNames = new Set<string>();

  for (const services of Object.values(cloudTrailUsage)) {
    for (const eventSource of Object.keys(services)) {
      const cleaned = eventSource.replace('.amazonaws.com', '').toLowerCase();
      usedServiceNames.add(cleaned);
    }
  }

  return allServices.filter(s => usedServiceNames.has(s.sdkServiceName.toLowerCase()));
}

export function filterUsedProducts(allProducts: Product[], cloudTrailUsage: CloudTrailUsage): Product[] {
  const usedServiceNames = new Set<string>();

  for (const services of Object.values(cloudTrailUsage)) {
    for (const eventSource of Object.keys(services)) {
      const cleaned = eventSource.replace('.amazonaws.com', '').toLowerCase();
      usedServiceNames.add(cleaned);
    }
  }

  return allProducts.filter(
    p => usedServiceNames.has(p.productId.toLowerCase()) || usedServiceNames.has(p.productName.toLowerCase()),
  );
}

export function filterUsedProductsFromResourceExplorer(
  allProducts: Product[],
  resourceExplorerUsage: Record<string, Record<string, unknown>>,
): Product[] {
  const usedServiceNames = new Set<string>();

  for (const services of Object.values(resourceExplorerUsage)) {
    for (const serviceName of Object.keys(services)) {
      usedServiceNames.add(serviceName.toLowerCase());
    }
  }

  return allProducts.filter(
    p =>
      usedServiceNames.has(p.productId.toLowerCase()) ||
      p.productName
        .toLowerCase()
        .includes(Array.from(usedServiceNames).find(s => p.productName.toLowerCase().includes(s)) || ''),
  );
}

/**
 * Returns products matching usage from any combination of CloudTrail,
 * Resource Explorer, and CloudFormation data. Filters child products
 * to only include those that match usage.
 */
export function getUsedProducts(
  allProducts: Product[],
  cloudTrailUsage?: CloudTrailUsage,
  resourceExplorerUsage?: Record<string, Record<string, unknown>>,
  cloudFormationUsage?: Record<string, Record<string, unknown>>,
): Product[] {
  const productSet = new Map<string, Product>();
  const usedServiceNames = new Set<string>();

  // Collect from CloudTrail
  if (cloudTrailUsage) {
    for (const services of Object.values(cloudTrailUsage)) {
      for (const eventSource of Object.keys(services)) {
        const cleaned = eventSource.replace('.amazonaws.com', '').toLowerCase();
        usedServiceNames.add(cleaned);
      }
    }
  }

  // Collect from Resource Explorer
  if (resourceExplorerUsage) {
    for (const services of Object.values(resourceExplorerUsage)) {
      for (const serviceName of Object.keys(services)) {
        usedServiceNames.add(serviceName.toLowerCase());
      }
    }
  }

  // Collect from CloudFormation
  if (cloudFormationUsage) {
    for (const services of Object.values(cloudFormationUsage)) {
      for (const serviceName of Object.keys(services)) {
        usedServiceNames.add(serviceName.toLowerCase());
      }
    }
  }

  // Filter products and their childProducts
  const usedServiceNamesArray = Array.from(usedServiceNames);
  for (const product of allProducts) {
    const isUsed =
      usedServiceNames.has(product.productId.toLowerCase()) ||
      usedServiceNamesArray.some(s => product.productName.toLowerCase().includes(s));

    if (isUsed) {
      // Filter childProducts to only include used ones
      const filteredProduct = {
        ...product,
        childProducts:
          product.childProducts?.filter(
            child =>
              usedServiceNames.has(child.productId.toLowerCase()) ||
              usedServiceNamesArray.some(s => child.productName.toLowerCase().includes(s)),
          ) || [],
      };
      productSet.set(product.productId, filteredProduct);
    }
  }

  return Array.from(productSet.values());
}

/** Returns API services matching usage from any combination of data sources. */
export function getUsedServices(
  allServices: ApiService[],
  cloudTrailUsage?: CloudTrailUsage,
  resourceExplorerUsage?: Record<string, Record<string, unknown>>,
  cloudFormationUsage?: Record<string, Record<string, unknown>>,
): ApiService[] {
  const usedServiceNames = new Set<string>();

  // Collect from CloudTrail
  if (cloudTrailUsage) {
    for (const services of Object.values(cloudTrailUsage)) {
      for (const eventSource of Object.keys(services)) {
        const cleaned = eventSource.replace('.amazonaws.com', '').toLowerCase();
        usedServiceNames.add(cleaned);
      }
    }
  }

  // Collect from Resource Explorer
  if (resourceExplorerUsage) {
    for (const services of Object.values(resourceExplorerUsage)) {
      for (const serviceName of Object.keys(services)) {
        usedServiceNames.add(serviceName.toLowerCase());
      }
    }
  }

  // Collect from CloudFormation
  if (cloudFormationUsage) {
    for (const services of Object.values(cloudFormationUsage)) {
      for (const serviceName of Object.keys(services)) {
        usedServiceNames.add(serviceName.toLowerCase());
      }
    }
  }

  return allServices.filter(s => usedServiceNames.has(s.sdkServiceName.toLowerCase()));
}

/** Extracts service:apiName pairs from CloudTrail usage data. */
export function getUsedApis(cloudTrailUsage?: CloudTrailUsage): string[] {
  const apis = new Set<string>();

  if (cloudTrailUsage) {
    for (const services of Object.values(cloudTrailUsage)) {
      for (const [eventSource, data] of Object.entries(services)) {
        const serviceName = eventSource.replace('.amazonaws.com', '').toLowerCase();
        for (const apiName of data.apis) {
          apis.add(`${serviceName}:${apiName}`);
        }
      }
    }
  }

  return Array.from(apis);
}
