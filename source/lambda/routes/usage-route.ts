import { S3BucketClient } from '../services/s3-client';
import { EnvironmentKey, getEnv } from '../constants/environment';
import { UsageFilter, VALID_USAGE_FILTERS } from '../constants/usage-filter';
import { getUsedProducts, getUsedApis } from '../services/service-matcher';
import { logger } from '../util/logger';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

export const getUsedCapabilities = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const usageFilter = (event.queryStringParameters?.usageFilter || UsageFilter.COMBINED) as UsageFilter;
    const scope = (event.queryStringParameters?.scope || 'account') as 'account' | 'organization';
    const accountIdsParam = event.queryStringParameters?.accountIds;
    const accountIds = accountIdsParam ? accountIdsParam.split(',').map(id => id.trim()) : undefined;

    if (!VALID_USAGE_FILTERS.includes(usageFilter)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Invalid usageFilter. Must be: ${VALID_USAGE_FILTERS.join(', ')}`,
        }),
      };
    }

    const s3 = new S3BucketClient(getEnv(EnvironmentKey.WEBSITE_BUCKET_NAME));

    // Load capability data
    const productsData = await s3.getObject('data/json/products.json');
    const products = JSON.parse(productsData);

    // Find latest usage file based on scope
    const usageFiles = await s3.listObjects('usage/');
    const prefix = scope === 'organization' ? 'organization-usage-' : 'account-usage-';
    const scopedFiles = usageFiles
      .filter(f => f.includes(prefix) && f.endsWith('.json'))
      .sort()
      .reverse();

    if (scopedFiles.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: `No usage data found. Run POST /analyze with scope=${scope} first.`,
        }),
      };
    }

    const latestUsageFile = scopedFiles[0];
    logger.info(`Using latest usage file: ${latestUsageFile}`);

    const usageData = await s3.getObject(latestUsageFile);
    const usage = JSON.parse(usageData);

    // Usage data is keyed by analyzer, each containing flat account-level data:
    //   usage.cloudtrail:      { [accountId]: { [serviceName]: { apis: string[], regionApis: { [region]: string[] } } } }
    //   usage.resourceExplorer: { [accountId]: { [serviceName]: ... } }
    //   usage.cloudformation:   { [accountId]: { [serviceName]: ... } }

    const cloudTrailUsage = filterByAccountIds(usage.cloudtrail || {}, accountIds);
    const resourceExplorerUsage = filterByAccountIds(usage.resourceExplorer || {}, accountIds);
    const cloudFormationUsage = filterByAccountIds(usage.cloudformation || {}, accountIds);

    // Apply filter mode
    let usedProducts;
    let usedApis: string[] = [];

    switch (usageFilter) {
      case UsageFilter.DEPLOYED:
        // Only CloudFormation + Resource Explorer
        usedProducts = getUsedProducts(products, undefined, resourceExplorerUsage, cloudFormationUsage);
        break;

      case UsageFilter.ACTIVE_USAGE:
        // Only CloudTrail
        usedProducts = getUsedProducts(products, cloudTrailUsage);
        usedApis = getUsedApis(cloudTrailUsage);
        break;

      case UsageFilter.COMBINED:
      default:
        // Union of all three
        usedProducts = getUsedProducts(products, cloudTrailUsage, resourceExplorerUsage, cloudFormationUsage);
        usedApis = getUsedApis(cloudTrailUsage);
        break;
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        services: usedProducts,
        apis: usedApis,
      }),
    };
  } catch (error) {
    logger.error('Failed to get used capabilities', { error: String(error) });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(error) }),
    };
  }
};

/**
 * Filters a flat account-keyed object by account IDs.
 */
function filterByAccountIds<T extends Record<string, unknown>>(data: T, accountIds?: string[]): T {
  if (!accountIds) return data;
  const result = {} as T;
  for (const [accountId, value] of Object.entries(data)) {
    if (accountIds.includes(accountId)) {
      (result as Record<string, unknown>)[accountId] = value;
    }
  }
  return result;
}
