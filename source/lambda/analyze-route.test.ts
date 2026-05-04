import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleAnalyze } from './routes/analyze-route';
import { SFNClient, StartExecutionCommand, DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import { mockClient } from 'aws-sdk-client-mock';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const sfnMock = mockClient(SFNClient);

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/analysis',
    body: null,
    headers: {},
    multiValueHeaders: {},
    isBase64Encoded: false,
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '',
    requestContext: {
      accountId: '123456789012',
      apiId: 'test',
      authorizer: null,
      protocol: 'HTTP/1.1',
      httpMethod: 'POST',
      identity: {} as APIGatewayProxyEvent['requestContext']['identity'],
      path: '/analysis',
      stage: 'prod',
      requestId: 'test-id',
      requestTimeEpoch: 0,
      resourceId: '',
      resourcePath: '',
    },
    ...overrides,
  };
}

describe('analyze-route', () => {
  beforeEach(() => {
    sfnMock.reset();
    vi.stubEnv('ANALYSIS_STATE_MACHINE_ARN', 'arn:aws:states:us-east-1:123:stateMachine:test');
    vi.stubEnv('WEBSITE_BUCKET_NAME', 'test-bucket');
    vi.stubEnv('CLOUDTRAIL_ANALYZER_LAMBDA_NAME', 'TestAnalyzer');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('POST /analysis', () => {
    it('starts a Step Functions execution and returns 202', async () => {
      sfnMock.on(StartExecutionCommand).resolves({
        executionArn: 'arn:aws:states:us-east-1:123:execution:test:run-1',
      });

      const event = makeEvent({
        body: JSON.stringify({
          scope: 'account',
          analyzerParams: { cloudtrail: { bucket: 'my-trail-bucket' } },
        }),
      });

      const result = await handleAnalyze(event);
      expect(result.statusCode).toBe(202);

      const body = JSON.parse(result.body);
      expect(body.status).toBe('RUNNING');
      expect(body.executionArn).toBe('arn:aws:states:us-east-1:123:execution:test:run-1');
    });

    it('returns 400 when scope is missing', async () => {
      const event = makeEvent({
        body: JSON.stringify({ analyzerParams: { cloudtrail: { bucket: 'b' } } }),
      });
      const result = await handleAnalyze(event);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('scope');
    });

    it('returns 400 when cloudtrail bucket is missing', async () => {
      const event = makeEvent({
        body: JSON.stringify({ scope: 'account' }),
      });
      const result = await handleAnalyze(event);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('cloudtrail.bucket');
    });

    it('returns 500 when state machine ARN is not configured', async () => {
      vi.stubEnv('ANALYSIS_STATE_MACHINE_ARN', '');
      delete process.env.ANALYSIS_STATE_MACHINE_ARN;

      const event = makeEvent({
        body: JSON.stringify({ scope: 'account' }),
      });

      const result = await handleAnalyze(event);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error).toContain('Analysis failed');
    });

    it('uses default analyzers when not specified', async () => {
      sfnMock.on(StartExecutionCommand).resolves({
        executionArn: 'arn:aws:states:us-east-1:123:execution:test:run-1',
      });

      const event = makeEvent({
        body: JSON.stringify({
          scope: 'account',
          analyzerParams: { cloudtrail: { bucket: 'my-trail-bucket' } },
        }),
      });

      await handleAnalyze(event);

      const call = sfnMock.commandCalls(StartExecutionCommand)[0];
      const input = JSON.parse(call.args[0].input.input!);
      expect(input.analyzers).toEqual(['cloudtrail', 'resourceExplorer', 'cloudformation']);
    });
  });

  describe('GET /analysis', () => {
    it('returns RUNNING status for in-progress execution', async () => {
      sfnMock.on(DescribeExecutionCommand).resolves({
        status: 'RUNNING',
      });

      const event = makeEvent({
        httpMethod: 'GET',
        queryStringParameters: {
          executionArn: 'arn:aws:states:us-east-1:123:execution:test:run-1',
        },
      });

      const result = await handleAnalyze(event);
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).status).toBe('RUNNING');
    });

    it('returns results for succeeded execution', async () => {
      const output = { cloudtrail: { '123': { s3: { apis: ['GetObject'] } } } };
      sfnMock.on(DescribeExecutionCommand).resolves({
        status: 'SUCCEEDED',
        output: JSON.stringify(output),
      });

      const event = makeEvent({
        httpMethod: 'GET',
        queryStringParameters: {
          executionArn: 'arn:aws:states:us-east-1:123:execution:test:run-1',
        },
      });

      const result = await handleAnalyze(event);
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual(output);
    });

    it('returns FAILED status with error details', async () => {
      sfnMock.on(DescribeExecutionCommand).resolves({
        status: 'FAILED',
        error: 'Lambda.Timeout',
        cause: 'Function timed out',
      });

      const event = makeEvent({
        httpMethod: 'GET',
        queryStringParameters: {
          executionArn: 'arn:aws:states:us-east-1:123:execution:test:run-1',
        },
      });

      const result = await handleAnalyze(event);
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.status).toBe('FAILED');
      expect(body.error).toBe('Function timed out');
    });

    it('returns 400 when executionArn is missing', async () => {
      const event = makeEvent({
        httpMethod: 'GET',
        queryStringParameters: null,
      });

      const result = await handleAnalyze(event);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('executionArn');
    });
  });
});
