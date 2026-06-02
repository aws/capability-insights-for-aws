import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { AWS_RESOURCE_TYPE_PREFIX } from './constants/cloudformation';
import { listActiveStacks, getProcessedTemplate } from './services/cloudformation-client';
import { S3BucketClient } from './services/s3-client';
import type { CloudFormationUsage, CloudFormationUsageRecord } from './types/usage';
import { logger } from './util/logger';

/**
 * Lambda handler for CloudFormation usage analysis.
 *
 * Lists active CloudFormation stacks, fetches processed templates, extracts
 * resource types and properties, maps to service names, and writes results
 * to S3. Invoked by the Step Functions analysis state machine.
 *
 * Data handling:
 * - Reads: every active stack's processed template via GetTemplate
 * - Extracts: resource types (e.g., AWS::Lambda::Function) and scalar property
 *   values (strings, numbers, booleans) keyed by resource type
 * - Ignores: nested objects, arrays, and non-AWS resource types (Custom::*)
 * - Writes: aggregated results to the website bucket's usage/ prefix
 *
 * Templates may contain sensitive configuration (ARNs, IDs, KMS references).
 * Output is written only to the VPC-restricted website bucket.
 */
export const handler = async (event: {
  accountId?: string;
  accounts?: string[];
  websiteBucket?: string;
  analyzers?: string[];
}): Promise<CloudFormationUsage> => {
  // Skip if this analyzer wasn't requested
  if (event.analyzers && !event.analyzers.includes('cloudformation')) {
    logger.info('CloudFormation analyzer not requested, skipping');
    return { accountId: '', region: '', records: [] };
  }

  const cfn = new CloudFormationClient({});
  const websiteBucket = event.websiteBucket;
  const accountId = event.accountId || event.accounts?.[0] || '';
  const region = process.env.AWS_REGION || '';

  logger.info('Starting CloudFormation analysis', { accountId, region });

  const stacks = await listActiveStacks(cfn);
  logger.info(`Found ${stacks.length} active stacks`);

  // Per-stack aggregation: stack → resourceType → { properties }
  // Keyed this way so one stack with multiple resources of the same type
  // produces a single record with merged property values.
  const aggregated: Record<string, Record<string, Record<string, Set<string>>>> = {};

  // Process stacks in batches to avoid exceeding the Lambda timeout
  // when accounts have hundreds of stacks. Tuned for GetTemplate's
  // rate limits (~10 req/s) with headroom for retries.
  const STACK_FETCH_CONCURRENCY = 5;
  const stackNames = stacks.map(s => s.StackName).filter((name): name is string => !!name);

  for (let i = 0; i < stackNames.length; i += STACK_FETCH_CONCURRENCY) {
    const batch = stackNames.slice(i, i + STACK_FETCH_CONCURRENCY);
    const templates = await Promise.allSettled(batch.map(name => getProcessedTemplate(cfn, name)));

    for (let j = 0; j < batch.length; j++) {
      const result = templates[j];
      if (result.status === 'fulfilled' && result.value) {
        processTemplate(result.value, batch[j], aggregated);
      }
    }
  }

  const records = buildRecords(aggregated);
  const usage: CloudFormationUsage = { accountId, region, records };

  logger.info('CloudFormation analysis complete', {
    accountId,
    region,
    totalRecords: records.length,
    stacks: Object.keys(aggregated).length,
  });

  if (websiteBucket) {
    const s3Client = new S3BucketClient(websiteBucket);
    const timestamp = new Date().toISOString();
    const key = `usage/cloudformation-usage-${timestamp}.json`;
    await s3Client.putObject(key, JSON.stringify(usage), 'application/json');
    logger.info(`Saved CloudFormation usage to ${key}`);
  }

  return usage;
};

/**
 * Extracts AWS resource types from a template's Resources section and
 * aggregates them into the per-stack accumulator.
 */
function processTemplate(
  template: Record<string, unknown>,
  stackName: string,
  aggregated: Record<string, Record<string, Record<string, Set<string>>>>,
): void {
  const resources = template.Resources as
    | Record<string, { Type?: string; Properties?: Record<string, unknown> }>
    | undefined;
  if (!resources) return;

  for (const resource of Object.values(resources)) {
    const resourceType = resource.Type;
    if (!resourceType || !resourceType.startsWith(AWS_RESOURCE_TYPE_PREFIX)) continue;

    const [serviceName, resourceTypeName] = parseResourceType(resourceType);
    if (!serviceName || !resourceTypeName) continue;

    const fqn = `${serviceName}::${resourceTypeName}`;
    if (!aggregated[stackName]) aggregated[stackName] = {};
    if (!aggregated[stackName][fqn]) aggregated[stackName][fqn] = {};

    if (resource.Properties) {
      extractProperties(resource.Properties, aggregated[stackName][fqn]);
    }
  }
}

/**
 * Parses a CloudFormation resource type string into [serviceName, resourceTypeName].
 * Example: "AWS::Lambda::Function" → ["Lambda", "Function"].
 */
function parseResourceType(resourceType: string): [string, string] {
  const parts = resourceType.split('::');
  if (parts.length < 3) return ['', ''];
  return [parts[1], parts.slice(2).join('::')];
}

/**
 * Collects scalar property values into string-array sets for deduplication.
 * Non-scalar properties (objects, arrays) are skipped intentionally:
 * - Nested objects (e.g., Environment.Variables, VpcConfig) can contain
 *   sensitive values and bloat the output without adding capability signal.
 * - Arrays have no stable flattening rule across resource types.
 * - The downstream use case is capability matching by resource type, which
 *   doesn't require nested property values.
 *
 * If a future use case needs nested data, consider flattening specific known
 * keys rather than recursing generically.
 */
function extractProperties(properties: Record<string, unknown>, accumulator: Record<string, Set<string>>): void {
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      if (!accumulator[key]) accumulator[key] = new Set();
      accumulator[key].add(String(value));
    }
  }
}

/** Flattens the per-stack accumulator into an array of records. */
function buildRecords(
  aggregated: Record<string, Record<string, Record<string, Set<string>>>>,
): CloudFormationUsageRecord[] {
  const records: CloudFormationUsageRecord[] = [];

  for (const [stackName, resourceTypes] of Object.entries(aggregated)) {
    for (const [fqn, propertySets] of Object.entries(resourceTypes)) {
      const [serviceName, resourceTypeName] = fqn.split('::');
      const properties: Record<string, string[]> = {};
      for (const [key, values] of Object.entries(propertySets)) {
        properties[key] = Array.from(values);
      }
      records.push({ stackName, serviceName, resourceTypeName, properties });
    }
  }

  return records;
}
