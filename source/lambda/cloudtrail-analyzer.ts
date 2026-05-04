import { AthenaClient } from '@aws-sdk/client-athena';
import { AthenaDefaults } from './constants/athena';
import { queryCloudTrailUsage } from './services/athena-client';
import { S3BucketClient } from './services/s3-client';
import { logger } from './util/logger';

/**
 * CloudTrail usage data keyed by account ID, then service name.
 * Produced by the CloudTrail Analyzer Lambda via Athena queries.
 */
interface CloudTrailUsage {
  [accountId: string]: {
    [serviceName: string]: {
      apis: string[];
      regionApis: { [region: string]: string[] };
    };
  };
}

/**
 * Lambda handler for CloudTrail usage analysis.
 *
 * Uses Athena to query CloudTrail logs, extracts distinct service/API/region
 * combinations per account, and writes results to S3. Invoked by the
 * Step Functions analysis state machine.
 */
export const handler = async (event: {
  cloudTrailBucket: string;
  cloudTrailPrefix: string;
  athenaDatabase?: string;
  athenaResultsLocation?: string;
  daysToScan?: number;
  websiteBucket?: string;
}): Promise<CloudTrailUsage> => {
  const athena = new AthenaClient({});
  const websiteBucket = event.websiteBucket;
  const database = event.athenaDatabase || AthenaDefaults.DATABASE;
  const tableName = AthenaDefaults.TABLE_NAME;
  const resultsLocation = event.athenaResultsLocation || `s3://${websiteBucket}/athena-results/`;
  const daysToScan = event.daysToScan || 30;

  logger.info('Starting CloudTrail analysis', {
    database,
    daysToScan,
  });

  const results = await queryCloudTrailUsage(athena, database, tableName, resultsLocation, daysToScan);

  logger.info(`Retrieved ${results.length} CloudTrail events`);

  const usage: CloudTrailUsage = {};
  const apiSets: Record<string, Record<string, Set<string>>> = {};
  const regionApiSets: Record<string, Record<string, Record<string, Set<string>>>> = {};

  for (const [eventsource, eventname, awsregion, accountid] of results) {
    const service = (eventsource || '').replace('.amazonaws.com', '');
    const account = accountid || '';
    const api = eventname || '';
    const region = awsregion || '';

    // Skip rows with missing essential fields
    if (!service || !account || !api) continue;

    if (!apiSets[account]) apiSets[account] = {};
    if (!regionApiSets[account]) regionApiSets[account] = {};

    if (!apiSets[account][service]) apiSets[account][service] = new Set();
    if (!regionApiSets[account][service]) regionApiSets[account][service] = {};
    if (!regionApiSets[account][service][region]) regionApiSets[account][service][region] = new Set();

    apiSets[account][service].add(api);
    if (region) {
      regionApiSets[account][service][region].add(api);
    }
  }

  // Convert Sets to arrays for the output
  for (const [account, services] of Object.entries(apiSets)) {
    usage[account] = {};
    for (const [service, apis] of Object.entries(services)) {
      const regionApis: Record<string, string[]> = {};
      for (const [region, regionSet] of Object.entries(regionApiSets[account][service])) {
        regionApis[region] = Array.from(regionSet);
      }
      usage[account][service] = {
        apis: Array.from(apis),
        regionApis,
      };
    }
  }

  logger.info('CloudTrail analysis complete', {
    accounts: Object.keys(usage).length,
    services: Object.values(usage).reduce((sum, acct) => sum + Object.keys(acct).length, 0),
  });

  // Save usage file to S3
  if (websiteBucket) {
    const s3Client = new S3BucketClient(websiteBucket);
    const timestamp = new Date().toISOString();
    const key = `usage/cloudtrail-usage-${timestamp}.json`;
    await s3Client.putObject(key, JSON.stringify(usage), 'application/json');
    logger.info(`Saved CloudTrail usage to ${key}`);
  }

  return usage;
};
