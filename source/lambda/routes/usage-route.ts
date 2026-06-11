import { S3BucketClient } from '../services/s3-client';
import { EnvironmentKey, getEnv } from '../constants/environment';
import { usedCapabilitiesKey } from '../constants/data-paths';
import { Scope, VALID_SCOPES } from '@capability-insights/shared/types/scope';
import { UsageFilter, VALID_USAGE_FILTERS } from '@capability-insights/shared/types/usage-filter';
import { StatusCode } from '../constants/status-codes';
import { logger } from '../util/logger';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

/**
 * GET /capabilities?usageFilter={mode}&scope={scope}
 *
 * Returns the pre-computed used-capabilities file for the requested
 * (scope, filterMode) combination. The decorator Lambda writes these files
 * as part of the Step Functions analysis workflow, so this handler just
 * reads one S3 object and returns it verbatim.
 *
 * File layout:
 *   data/json/used-capabilities-{scope}-{filterMode}.json
 *
 * Response shape:
 *   { products: [...], apis: [...], cfnResources: [...], lastAnalyzedAt: "..." }
 */
export const getUsedCapabilities = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const usageFilter = (event.queryStringParameters?.usageFilter || UsageFilter.COMBINED) as UsageFilter;
    const scope = (event.queryStringParameters?.scope || Scope.ACCOUNT) as Scope;

    if (!VALID_USAGE_FILTERS.includes(usageFilter)) {
      return {
        statusCode: StatusCode.BAD_REQUEST,
        headers: corsHeaders,
        body: JSON.stringify({
          error: `Invalid usageFilter. Must be: ${VALID_USAGE_FILTERS.join(', ')}`,
        }),
      };
    }

    if (!VALID_SCOPES.includes(scope)) {
      return {
        statusCode: StatusCode.BAD_REQUEST,
        headers: corsHeaders,
        body: JSON.stringify({
          error: `Invalid scope. Must be: ${VALID_SCOPES.join(', ')}`,
        }),
      };
    }

    const s3 = new S3BucketClient(getEnv(EnvironmentKey.WEBSITE_BUCKET_NAME));
    const key = usedCapabilitiesKey(scope, usageFilter);

    logger.info('Fetching used capabilities', { key });

    let body: string;
    try {
      body = await s3.getObject(key);
    } catch (e) {
      logger.warn('Used capabilities file not found', { key, error: String(e) });
      return {
        statusCode: StatusCode.NOT_FOUND,
        headers: corsHeaders,
        body: JSON.stringify({
          error: `No usage data found for scope=${scope}. Run POST /analysis with scope=${scope} first.`,
        }),
      };
    }

    return {
      statusCode: StatusCode.OK,
      headers: corsHeaders,
      body,
    };
  } catch (error) {
    logger.error('Failed to get used capabilities', { error: String(error) });
    return {
      statusCode: StatusCode.INTERNAL_SERVER_ERROR,
      headers: corsHeaders,
      body: JSON.stringify({ error: String(error) }),
    };
  }
};
