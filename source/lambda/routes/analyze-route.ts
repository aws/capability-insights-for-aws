import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SFNClient, StartExecutionCommand, DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import { OrganizationsClient, ListAccountsCommand } from '@aws-sdk/client-organizations';
import { StatusCode } from '../constants/status-codes';
import { HttpMethod } from '../constants/http-methods';
import { EnvironmentKey, getEnv, getOptionalEnv } from '../constants/environment';
import { Scope } from '../constants/scope';
import { logger } from '../util/logger';

type AnalyzerType = 'cloudtrail' | 'resourceExplorer' | 'cloudformation';

const ExecutionStatus = {
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const;

interface CloudTrailConfig {
  bucket: string;
  prefix?: string;
  daysToScan?: number;
}

interface ResourceExplorerConfig {
  // TODO: Add resource explorer specific config here
  [key: string]: unknown;
}

interface CloudFormationConfig {
  // TODO: Add cloudformation specific config here
  [key: string]: unknown;
}

interface AnalyzerParams {
  cloudtrail?: CloudTrailConfig;
  resourceExplorer?: ResourceExplorerConfig;
  cloudformation?: CloudFormationConfig;
}

interface AnalyzeRequest {
  scope: Scope;
  accountIds?: string[];
  analyzers: AnalyzerType[];
  analyzerParams?: AnalyzerParams;
}

/**
 * Handles POST /analysis (start analysis) and GET /analysis (poll status).
 *
 * POST: Starts a Step Functions execution that orchestrates usage analyzers.
 * For organization scope, discovers accounts via AWS Organizations.
 *
 * GET: Polls execution status via ?executionArn= query parameter.
 * Returns RUNNING, SUCCEEDED (with results), or FAILED.
 */
export async function handleAnalyze(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // Handle GET request - poll execution status
  if (event.httpMethod === HttpMethod.GET) {
    return await getAnalysisStatus(event);
  }

  // Handle POST request - start new analysis
  try {
    const stateMachineArn = getEnv(EnvironmentKey.ANALYSIS_STATE_MACHINE_ARN);

    const body: AnalyzeRequest = JSON.parse(event.body || '{}');
    const {
      scope,
      accountIds,
      // 'resourceExplorer' is intentionally omitted from the default until
      // its analyzer Lambda exists (see TODO in environment.ts). Callers can
      // still opt in explicitly via analyzers in the request body.
      analyzers = ['cloudtrail', 'cloudformation'],
      analyzerParams = {},
    } = body;

    if (!scope) {
      return {
        statusCode: StatusCode.BAD_REQUEST,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Missing required field: scope' }),
      };
    }

    if (analyzers.includes('cloudtrail') && !analyzerParams.cloudtrail?.bucket) {
      return {
        statusCode: StatusCode.BAD_REQUEST,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Missing required field: analyzerParams.cloudtrail.bucket' }),
      };
    }

    const currentAccountId = event.requestContext.accountId;

    // Determine accounts to analyze
    const accounts =
      scope === Scope.ORGANIZATION ? await discoverOrganizationAccounts() : accountIds || [currentAccountId];

    // Start Step Function execution
    const sfnClient = new SFNClient({});

    const executionInput = {
      scope,
      accounts,
      analyzers,
      cloudTrailBucket: analyzerParams.cloudtrail?.bucket,
      cloudTrailPrefix: analyzerParams.cloudtrail?.prefix || 'AWSLogs/',
      daysToScan: analyzerParams.cloudtrail?.daysToScan || 30,
      websiteBucket: getEnv(EnvironmentKey.WEBSITE_BUCKET_NAME),
      cloudtrailAnalyzerLambda: getEnv(EnvironmentKey.CLOUDTRAIL_ANALYZER_LAMBDA_NAME),
      resourceExplorerAnalyzerLambda: getOptionalEnv(EnvironmentKey.RESOURCE_EXPLORER_ANALYZER_LAMBDA_NAME),
      cloudformationAnalyzerLambda: getOptionalEnv(EnvironmentKey.CLOUDFORMATION_ANALYZER_LAMBDA_NAME),
    };

    const response = await sfnClient.send(
      new StartExecutionCommand({
        stateMachineArn,
        input: JSON.stringify(executionInput),
      }),
    );

    return {
      statusCode: StatusCode.ACCEPTED,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        executionArn: response.executionArn,
        status: ExecutionStatus.RUNNING,
        message: `${scope} analysis started`,
      }),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Analysis error', { error: String(error) });
    return {
      statusCode: StatusCode.INTERNAL_SERVER_ERROR,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Analysis failed', message }),
    };
  }
}

/** Polls Step Functions execution status for a running analysis. */
async function getAnalysisStatus(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const executionArn = event.queryStringParameters?.executionArn;

    if (!executionArn) {
      return {
        statusCode: StatusCode.BAD_REQUEST,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Missing required query parameter: executionArn' }),
      };
    }

    const sfnClient = new SFNClient({});
    const execution = await sfnClient.send(new DescribeExecutionCommand({ executionArn }));

    if (execution.status === ExecutionStatus.RUNNING) {
      return {
        statusCode: StatusCode.OK,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ status: ExecutionStatus.RUNNING }),
      };
    }

    if (execution.status === ExecutionStatus.SUCCEEDED) {
      const results = execution.output ? JSON.parse(execution.output) : {};
      return {
        statusCode: StatusCode.OK,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(results),
      };
    }

    return {
      statusCode: StatusCode.OK,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        status: ExecutionStatus.FAILED,
        error: execution.cause || execution.error || 'Unknown error',
      }),
    };
  } catch (error: unknown) {
    logger.error('Status check error', { error: String(error) });
    return {
      statusCode: StatusCode.INTERNAL_SERVER_ERROR,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        status: ExecutionStatus.FAILED,
        error: 'Failed to check analysis status',
      }),
    };
  }
}

/** Discovers all active accounts in the AWS Organization. */
async function discoverOrganizationAccounts(): Promise<string[]> {
  const client = new OrganizationsClient({});
  const accounts: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await client.send(new ListAccountsCommand({ NextToken: nextToken }));
    if (response.Accounts) {
      accounts.push(...response.Accounts.filter(a => a.Status === 'ACTIVE').map(a => a.Id!));
    }
    nextToken = response.NextToken;
  } while (nextToken);

  return accounts;
}
