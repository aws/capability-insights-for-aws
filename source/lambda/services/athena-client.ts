import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-athena';
import { AthenaQueryStatus } from '../constants/athena';
import { cloudTrailUsageQuery } from './athena-queries';
import { logger } from '../util/logger';

interface AthenaQueryParams {
  database: string;
  query: string;
  resultsLocation: string;
}

/**
 * Executes an Athena query and waits for completion, paginating through all result pages.
 * Polls query status every second, up to 12 minutes.
 */
export async function executeAthenaQuery(athena: AthenaClient, params: AthenaQueryParams): Promise<string[][]> {
  // Start query
  const { QueryExecutionId } = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: params.query,
      QueryExecutionContext: { Database: params.database },
      ResultConfiguration: { OutputLocation: params.resultsLocation },
    }),
  );

  if (!QueryExecutionId) {
    throw new Error('Failed to start Athena query');
  }

  // Wait for completion
  let status: string = AthenaQueryStatus.RUNNING;
  let elapsedSeconds = 0;
  const pollTimeoutSeconds = 720; // 12 minutes max
  let queryExecution;

  while (
    (status === AthenaQueryStatus.RUNNING || status === AthenaQueryStatus.QUEUED) &&
    elapsedSeconds < pollTimeoutSeconds
  ) {
    await new Promise(resolve => setTimeout(resolve, 1000));

    const result = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId }));

    queryExecution = result.QueryExecution;
    status = queryExecution?.Status?.State || AthenaQueryStatus.FAILED;
    elapsedSeconds++;
  }

  if (status !== AthenaQueryStatus.SUCCEEDED) {
    const failureReason = queryExecution?.Status?.StateChangeReason || 'Unknown reason';
    logger.error('Athena query failed', {
      status,
      failureReason,
      queryExecutionId: QueryExecutionId,
    });
    throw new Error(`Athena query failed with status: ${status}. Reason: ${failureReason}`);
  }

  // Get results, paginating through all pages
  const allRows: string[][] = [];
  let nextToken: string | undefined;
  let isFirstPage = true;

  do {
    const response = await athena.send(
      new GetQueryResultsCommand({
        QueryExecutionId,
        NextToken: nextToken,
      }),
    );

    const rows = response.ResultSet?.Rows || [];

    // Skip header row on the first page only
    const dataRows = isFirstPage ? rows.slice(1) : rows;
    isFirstPage = false;

    for (const row of dataRows) {
      allRows.push(row.Data?.map(col => col.VarCharValue || '') || []);
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return allRows;
}

/**
 * Queries CloudTrail logs for distinct service/API/region/account combinations.
 * Filters to AwsApiCall events within the specified time window.
 * daysToScan is sanitized to an integer between 1 and 365.
 */
export async function queryCloudTrailUsage(
  athena: AthenaClient,
  database: string,
  tableName: string,
  resultsLocation: string,
  daysToScan: number = 30,
): Promise<string[][]> {
  const safeDays = Math.max(1, Math.min(Math.floor(daysToScan), 365));

  return executeAthenaQuery(athena, {
    database,
    query: cloudTrailUsageQuery(database, tableName, safeDays),
    resultsLocation,
  });
}
