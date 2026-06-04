import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type {
  CfnResource,
  EnrichedCfnResource,
  EnrichedCfnResourceType,
} from '@capability-insights/shared/types/capability/cfn';
import type { Product } from '@capability-insights/shared/types/capability/product';
import type { UsedCapabilities } from '@capability-insights/shared/types/used-capabilities';
import { CLOUDTRAIL_SERVICE_ALIASES } from './constants/cloudtrail-service-aliases';
import { EnvironmentKey, getOptionalEnv } from './constants/environment';
import { Scope } from '@capability-insights/shared/types/scope';
import { UsageFilter, VALID_USAGE_FILTERS } from '@capability-insights/shared/types/usage-filter';
import { S3BucketClient } from './services/s3-client';
import type { CloudFormationUsage, CloudTrailUsage } from './types/usage';
import { logger } from './util/logger';

type ParallelAnalyzerOutput = Array<unknown>;

interface DecoratorEvent {
  websiteBucket?: string;
  scope?: Scope;
  parallelResults?: ParallelAnalyzerOutput;
}

/**
 * Decorates analyzer usage data with regional availability from the master
 * capability catalogs, producing pre-computed "used-capabilities" files —
 * one per (scope, filterMode) pair.
 *
 * Six possible outputs:
 *   data/json/used-capabilities-{account|organization}-{deployed|active_usage|combined}.json
 *
 * Each file has the shape:
 *   { products, apis, cfnResources, lastAnalyzedAt }
 *
 * The API Lambda reads one file per /capabilities request based on the
 * requested scope + usageFilter, avoiding per-request computation.
 */
export const handler = async (event: DecoratorEvent): Promise<Record<UsageFilter, number>> => {
  const websiteBucket = event.websiteBucket;
  if (!websiteBucket) {
    throw new Error('websiteBucket is required');
  }

  const scope: Scope = event.scope === Scope.ORGANIZATION ? Scope.ORGANIZATION : Scope.ACCOUNT;
  const [cloudTrailResult, cloudFormationResult] = event.parallelResults ?? [];
  const cloudTrailUsage = isCloudTrailUsage(cloudTrailResult) ? cloudTrailResult : {};
  const cloudFormationUsage = isCloudFormationUsage(cloudFormationResult) ? cloudFormationResult : null;

  // When true (default), each service kept in the personalized view keeps
  // all its childProducts (features) from the master catalog, even those
  // not individually observed in usage data. When false, childProducts are
  // narrowed to only the features directly observed.
  const includeAllFeaturesPerService =
    getOptionalEnv(EnvironmentKey.INCLUDE_ALL_FEATURES_PER_SERVICE, 'true').toLowerCase() !== 'false';

  logger.info('Starting usage decorator', {
    scope,
    hasCloudTrail: Object.keys(cloudTrailUsage).length > 0,
    hasCloudFormation: cloudFormationUsage !== null,
    includeAllFeaturesPerService,
  });

  const s3 = new S3BucketClient(websiteBucket);

  // Load master catalogs
  const [productsRaw, apisRaw, cfnResourcesRaw] = await Promise.all([
    s3.getObject('data/json/products.json'),
    s3.getObject('data/json/apis.json'),
    s3.getObject('data/json/cfn_resources.json'),
  ]);
  const products = JSON.parse(productsRaw) as Product[];
  const apis = JSON.parse(apisRaw) as ApiService[];
  const cfnResources = JSON.parse(cfnResourcesRaw) as CfnResource[];

  // Build lookup maps used across filter modes
  const sdkToProductId = buildSdkToProductIdMap(apis);

  const lastAnalyzedAt = new Date().toISOString();

  // Compute each filter mode's view
  const views: Record<UsageFilter, UsedCapabilities> = {
    [UsageFilter.DEPLOYED]: buildView(UsageFilter.DEPLOYED, {
      cloudTrailUsage,
      cloudFormationUsage,
      products,
      apis,
      cfnResources,
      sdkToProductId,
      lastAnalyzedAt,
      includeAllFeaturesPerService,
    }),
    [UsageFilter.ACTIVE_USAGE]: buildView(UsageFilter.ACTIVE_USAGE, {
      cloudTrailUsage,
      cloudFormationUsage,
      products,
      apis,
      cfnResources,
      sdkToProductId,
      lastAnalyzedAt,
      includeAllFeaturesPerService,
    }),
    [UsageFilter.COMBINED]: buildView(UsageFilter.COMBINED, {
      cloudTrailUsage,
      cloudFormationUsage,
      products,
      apis,
      cfnResources,
      sdkToProductId,
      lastAnalyzedAt,
      includeAllFeaturesPerService,
    }),
  };

  // Write all files in parallel
  await Promise.all(
    VALID_USAGE_FILTERS.map(mode => {
      const key = `data/json/used-capabilities-${scope}-${mode}.json`;
      return s3.putObject(key, JSON.stringify(views[mode]), 'application/json');
    }),
  );

  const counts: Record<UsageFilter, number> = {
    [UsageFilter.DEPLOYED]: views[UsageFilter.DEPLOYED].products.length,
    [UsageFilter.ACTIVE_USAGE]: views[UsageFilter.ACTIVE_USAGE].products.length,
    [UsageFilter.COMBINED]: views[UsageFilter.COMBINED].products.length,
  };

  logger.info('Decoration complete', { scope, counts });
  return counts;
};

interface BuildViewContext {
  cloudTrailUsage: CloudTrailUsage;
  cloudFormationUsage: CloudFormationUsage | null;
  products: Product[];
  apis: ApiService[];
  cfnResources: CfnResource[];
  sdkToProductId: Map<string, string>;
  lastAnalyzedAt: string;
  includeAllFeaturesPerService: boolean;
}

/**
 * Computes the used-capabilities view for a single filter mode.
 *
 * Filter semantics:
 * - deployed: CloudFormation is the authority. products from CFN matches;
 *   apis empty; cfnResources from CFN with usage enrichment.
 * - active_usage: CloudTrail is the authority. products from CloudTrail
 *   matches; apis scoped to called APIs; cfnResources empty.
 * - combined: union of both sources for products; apis from CloudTrail;
 *   cfnResources from CloudFormation with enrichment.
 */
function buildView(mode: UsageFilter, ctx: BuildViewContext): UsedCapabilities {
  const {
    cloudTrailUsage,
    cloudFormationUsage,
    products,
    apis,
    cfnResources,
    sdkToProductId,
    lastAnalyzedAt,
    includeAllFeaturesPerService,
  } = ctx;

  // CloudTrail-detected productIds + the set of called API names per service
  const ctProductIds = new Set<string>();
  const calledApisBySdkService = new Map<string, Set<string>>();
  for (const services of Object.values(cloudTrailUsage)) {
    for (const [eventSource, data] of Object.entries(services)) {
      const cleaned = eventSource.replace('.amazonaws.com', '').toLowerCase();
      // Try the cleaned slug first. If that misses, fall back to the
      // alias map (bridges CloudTrail-style names to SDK names).
      const resolvedSdkName = sdkToProductId.has(cleaned) ? cleaned : CLOUDTRAIL_SERVICE_ALIASES[cleaned];
      const pid = resolvedSdkName ? sdkToProductId.get(resolvedSdkName) : undefined;
      if (!pid || !resolvedSdkName) continue;
      ctProductIds.add(pid);

      // Track which API names were called, keyed by the resolved SDK name
      // so filterApisScopedToCalled can match against apis.json entries.
      if (!calledApisBySdkService.has(resolvedSdkName)) {
        calledApisBySdkService.set(resolvedSdkName, new Set());
      }
      const apiSet = calledApisBySdkService.get(resolvedSdkName)!;
      for (const api of data.apis) apiSet.add(api);
    }
  }

  // CloudFormation-detected productIds + per-resource-type usage
  const cfProductIds = new Set<string>();
  // Per-resource-type aggregation. `properties` tracks which stacks
  // contributed each (property, value) pair, so the UI can filter leaf
  // configurations by stack ("show only t3.medium from test-assets-*,
  // not t3.micro from the sample env").
  const cfUsageByFqn = new Map<string, { stacks: Set<string>; properties: Record<string, Map<string, Set<string>>> }>();
  if (cloudFormationUsage) {
    for (const record of cloudFormationUsage.records) {
      const pid = sdkToProductId.get(record.serviceName.toLowerCase());
      if (pid) cfProductIds.add(pid);

      const fqn = `${record.serviceName}::${record.resourceTypeName}`;
      if (!cfUsageByFqn.has(fqn)) {
        cfUsageByFqn.set(fqn, { stacks: new Set(), properties: {} });
      }
      const agg = cfUsageByFqn.get(fqn)!;
      agg.stacks.add(record.stackName);
      for (const [key, values] of Object.entries(record.properties ?? {})) {
        if (!agg.properties[key]) agg.properties[key] = new Map();
        const valueStacks = agg.properties[key];
        for (const v of values) {
          if (!valueStacks.has(v)) valueStacks.set(v, new Set());
          valueStacks.get(v)!.add(record.stackName);
        }
      }
    }
  }

  // Select which productIds count as "used" for this mode
  let usedProductIds: Set<string>;
  if (mode === UsageFilter.DEPLOYED) {
    usedProductIds = cfProductIds;
  } else if (mode === UsageFilter.ACTIVE_USAGE) {
    usedProductIds = ctProductIds;
  } else {
    usedProductIds = new Set([...ctProductIds, ...cfProductIds]);
  }

  const filteredProducts = filterProducts(products, usedProductIds, includeAllFeaturesPerService);

  const filteredApis = mode === UsageFilter.DEPLOYED ? [] : filterApisScopedToCalled(apis, calledApisBySdkService);

  const filteredCfnResources =
    mode === UsageFilter.ACTIVE_USAGE ? [] : enrichAndFilterCfnResources(cfnResources, cfUsageByFqn);

  return {
    products: filteredProducts,
    apis: filteredApis,
    cfnResources: filteredCfnResources,
    lastAnalyzedAt,
  };
}

function buildSdkToProductIdMap(apis: ApiService[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const svc of apis) {
    if (!svc.sdkServiceName || !svc.productID) continue;
    const lower = svc.sdkServiceName.toLowerCase();
    map.set(lower, svc.productID);
    // Collapsed variant (no whitespace/dashes) catches "API Gateway" → "apigateway",
    // "ACM PCA" → "acmpca", etc.
    map.set(lower.replace(/[\s-]+/g, ''), svc.productID);
  }
  return map;
}

function filterProducts(
  products: Product[],
  usedProductIds: Set<string>,
  includeAllFeaturesPerService: boolean,
): Product[] {
  return products
    .filter(product => usedProductIds.has(product.productId))
    .map(product => ({
      ...product,
      childProducts: includeAllFeaturesPerService
        ? (product.childProducts ?? [])
        : (product.childProducts ?? []).filter(child => usedProductIds.has(child.productId)),
    }));
}

/**
 * Filters apis.json to services whose APIs CloudTrail observed being called,
 * and further scopes each service's apis[] array to only the called API names.
 * Services with no called APIs are dropped entirely.
 */
function filterApisScopedToCalled(apis: ApiService[], calledApisBySdkService: Map<string, Set<string>>): ApiService[] {
  const result: ApiService[] = [];
  for (const svc of apis) {
    const key = svc.sdkServiceName?.toLowerCase() ?? '';
    const keyCollapsed = key.replace(/[\s-]+/g, '');
    const calledApis = calledApisBySdkService.get(key) ?? calledApisBySdkService.get(keyCollapsed);
    if (!calledApis || calledApis.size === 0) continue;

    const scopedApis = svc.apis.filter(api => calledApis.has(api.apiAction));
    if (scopedApis.length === 0) continue;

    result.push({ ...svc, apis: scopedApis });
  }
  return result;
}

/**
 * Filters cfn_resources.json to resource types that CloudFormation observed
 * in active stacks, enriching each kept resource type with a `usage` subfield
 * ({ stacks, properties, count }).
 *
 * Each kept resource type has its `resourceProperties[]` filtered so that each
 * property only lists the `resourceConfigurations` the user actually deployed.
 * For example, if an EC2 Instance has InstanceType `t3.medium`, the output
 * InstanceType property will contain just the `t3.medium` configuration,
 * not all 1000+ possible values from the master catalog.
 */
function enrichAndFilterCfnResources(
  cfnResources: CfnResource[],
  cfUsageByFqn: Map<string, { stacks: Set<string>; properties: Record<string, Map<string, Set<string>>> }>,
): EnrichedCfnResource[] {
  const result: EnrichedCfnResource[] = [];
  for (const entry of cfnResources) {
    const enrichedTypes: EnrichedCfnResourceType[] = [];
    for (const rt of entry.resourceTypes) {
      const fqn = `${entry.serviceName}::${rt.resourceTypeName}`;
      const usage = cfUsageByFqn.get(fqn);
      if (!usage) continue;

      // Flat view of observed properties (propName → observed values[]) for
      // the `usage.properties` summary field. Stacks per value live on each
      // kept `resourceConfigurations` entry below.
      const properties: Record<string, string[]> = {};
      for (const [k, valueStacks] of Object.entries(usage.properties)) {
        properties[k] = Array.from(valueStacks.keys());
      }

      // Narrow the master's resourceProperties to just the configurations the
      // user deployed, and annotate each with the stacks it came from. This
      // enables per-configuration stack filtering in the UI (e.g., show only
      // t3.medium configs that came from stack X).
      const narrowedProperties = (rt.resourceProperties ?? [])
        .map(prop => {
          const deployedValues = usage.properties[prop.resourcePropertyName];
          if (!deployedValues || deployedValues.size === 0) return null;
          const keptConfigs = prop.resourceConfigurations
            .filter(cfg => deployedValues.has(cfg.resourceConfigurationName))
            .map(cfg => ({
              ...cfg,
              stacks: Array.from(deployedValues.get(cfg.resourceConfigurationName) ?? []),
            }));
          if (keptConfigs.length === 0) return null;
          return { ...prop, resourceConfigurations: keptConfigs };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);

      enrichedTypes.push({
        ...rt,
        resourceProperties: narrowedProperties,
        usage: {
          stacks: Array.from(usage.stacks),
          properties,
          count: usage.stacks.size,
        },
      });
    }
    if (enrichedTypes.length === 0) continue;
    result.push({ serviceName: entry.serviceName, resourceTypes: enrichedTypes });
  }
  return result;
}

// Type guards — Step Functions may pass error objects when a branch fails.
function isCloudTrailUsage(value: unknown): value is CloudTrailUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return !('status' in value && 'analyzer' in value);
}

function isCloudFormationUsage(value: unknown): value is CloudFormationUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return 'accountId' in value && 'records' in value;
}
