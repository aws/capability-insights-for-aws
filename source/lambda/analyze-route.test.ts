import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleAnalyze } from './routes/analyze-route';
import { SFNClient, StartExecutionCommand, DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import { OrganizationsClient, ListAccountsCommand } from '@aws-sdk/client-organizations';
import { mockClient } from 'aws-sdk-client-mock';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const sfnMock = mockClient(SFNClient);
const orgsMock = mockClient(OrganizationsClient);

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
    orgsMock.reset();
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

    it('falls back to CONFIGURED_CLOUDTRAIL_BUCKET env var when bucket is omitted from the request', async () => {
      vi.stubEnv('CONFIGURED_CLOUDTRAIL_BUCKET', 'env-fallback-bucket');
      sfnMock.on(StartExecutionCommand).resolves({
        executionArn: 'arn:aws:states:us-east-1:123:execution:test:fallback-run',
      });

      const event = makeEvent({
        body: JSON.stringify({ scope: 'account' }),
      });

      const result = await handleAnalyze(event);
      expect(result.statusCode).toBe(202);

      const input = JSON.parse(sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input.input!);
      expect(input.cloudTrailBucket).toBe('env-fallback-bucket');
    });

    it('prefers analyzerParams.cloudtrail.bucket over CONFIGURED_CLOUDTRAIL_BUCKET when both are set', async () => {
      vi.stubEnv('CONFIGURED_CLOUDTRAIL_BUCKET', 'env-fallback-bucket');
      sfnMock.on(StartExecutionCommand).resolves({
        executionArn: 'arn:aws:states:us-east-1:123:execution:test:override-run',
      });

      const event = makeEvent({
        body: JSON.stringify({
          scope: 'account',
          analyzerParams: { cloudtrail: { bucket: 'request-body-bucket' } },
        }),
      });

      const result = await handleAnalyze(event);
      expect(result.statusCode).toBe(202);

      const input = JSON.parse(sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input.input!);
      expect(input.cloudTrailBucket).toBe('request-body-bucket');
    });

    it('returns 503 when state machine ARN is not configured (Usage Analysis stack not deployed)', async () => {
      vi.stubEnv('ANALYSIS_STATE_MACHINE_ARN', '');
      delete process.env.ANALYSIS_STATE_MACHINE_ARN;

      const event = makeEvent({
        body: JSON.stringify({ scope: 'account' }),
      });

      const result = await handleAnalyze(event);
      expect(result.statusCode).toBe(503);
      const body = JSON.parse(result.body) as { error: string; message: string };
      expect(body.error).toContain('Usage Analysis is not enabled');
      expect(body.message).toContain('--enable-usage-analysis');
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
      expect(input.analyzers).toEqual(['cloudtrail', 'cloudformation']);
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

  describe('POST /analysis with scope=organization', () => {
    it('discovers active accounts via Organizations and passes them to the state machine', async () => {
      orgsMock
        .on(ListAccountsCommand, { NextToken: undefined })
        .resolves({
          Accounts: [
            { Id: '111111111111', Status: 'ACTIVE' },
            { Id: '222222222222', Status: 'ACTIVE' },
          ],
          NextToken: 'page-2',
        })
        .on(ListAccountsCommand, { NextToken: 'page-2' })
        .resolves({
          Accounts: [
            { Id: '333333333333', Status: 'ACTIVE' },
            { Id: '999999999999', Status: 'SUSPENDED' },
          ],
        });

      sfnMock.on(StartExecutionCommand).resolves({
        executionArn: 'arn:aws:states:us-east-1:123:execution:test:org-run-1',
      });

      const event = makeEvent({
        body: JSON.stringify({
          scope: 'organization',
          analyzerParams: { cloudtrail: { bucket: 'org-trail-bucket' } },
        }),
      });

      const result = await handleAnalyze(event);
      expect(result.statusCode).toBe(202);

      const sfnCall = sfnMock.commandCalls(StartExecutionCommand)[0];
      const input = JSON.parse(sfnCall.args[0].input.input!);
      expect(input.scope).toBe('organization');
      expect(input.accounts).toEqual(['111111111111', '222222222222', '333333333333']);

      expect(orgsMock.commandCalls(ListAccountsCommand)).toHaveLength(2);
    });

    it('still returns 202 when the organization has a single active account', async () => {
      orgsMock.on(ListAccountsCommand).resolves({
        Accounts: [{ Id: '111111111111', Status: 'ACTIVE' }],
      });
      sfnMock.on(StartExecutionCommand).resolves({
        executionArn: 'arn:aws:states:us-east-1:123:execution:test:org-run-2',
      });

      const event = makeEvent({
        body: JSON.stringify({
          scope: 'organization',
          analyzerParams: { cloudtrail: { bucket: 'org-trail-bucket' } },
        }),
      });

      const result = await handleAnalyze(event);
      expect(result.statusCode).toBe(202);

      const input = JSON.parse(sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input.input!);
      expect(input.accounts).toEqual(['111111111111']);
    });

    it('returns 500 when the Organizations API fails', async () => {
      orgsMock.on(ListAccountsCommand).rejects(new Error('AWSOrganizationsNotInUseException'));

      const event = makeEvent({
        body: JSON.stringify({
          scope: 'organization',
          analyzerParams: { cloudtrail: { bucket: 'org-trail-bucket' } },
        }),
      });

      const result = await handleAnalyze(event);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error).toContain('Analysis failed');

      expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
    });

    it('ignores provided accountIds when scope is organization', async () => {
      orgsMock.on(ListAccountsCommand).resolves({
        Accounts: [
          { Id: '111111111111', Status: 'ACTIVE' },
          { Id: '222222222222', Status: 'ACTIVE' },
        ],
      });
      sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'arn:...' });

      const event = makeEvent({
        body: JSON.stringify({
          scope: 'organization',
          accountIds: ['999999999999'], // should be ignored
          analyzerParams: { cloudtrail: { bucket: 'org-trail-bucket' } },
        }),
      });

      await handleAnalyze(event);
      const input = JSON.parse(sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input.input!);
      expect(input.accounts).toEqual(['111111111111', '222222222222']);
      expect(input.accounts).not.toContain('999999999999');
    });

    it('returns 202 with an empty accounts list when no active accounts are found', async () => {
      // Locks in current behavior (forwards [] to SFN). Update intentionally if we move to fail-fast.
      orgsMock.on(ListAccountsCommand).resolves({
        Accounts: [
          { Id: '111111111111', Status: 'SUSPENDED' },
          { Id: '222222222222', Status: 'SUSPENDED' },
        ],
      });
      sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'arn:...' });

      const event = makeEvent({
        body: JSON.stringify({
          scope: 'organization',
          analyzerParams: { cloudtrail: { bucket: 'org-trail-bucket' } },
        }),
      });

      const result = await handleAnalyze(event);
      expect(result.statusCode).toBe(202);

      const input = JSON.parse(sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input.input!);
      expect(input.accounts).toEqual([]);
    });

    it('forwards CloudTrail analyzerParams to the state machine input', async () => {
      // Locks in the flattening contract (analyzerParams.cloudtrail.* → cloudTrailBucket / cloudTrailPrefix / daysToScan).
      orgsMock.on(ListAccountsCommand).resolves({
        Accounts: [{ Id: '111111111111', Status: 'ACTIVE' }],
      });
      sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'arn:...' });

      const event = makeEvent({
        body: JSON.stringify({
          scope: 'organization',
          analyzers: ['cloudtrail', 'cloudformation'],
          analyzerParams: {
            cloudtrail: {
              bucket: 'my-trail-bucket',
              prefix: 'CustomPrefix/',
              daysToScan: 30,
            },
          },
        }),
      });

      await handleAnalyze(event);
      const input = JSON.parse(sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input.input!);
      expect(input.cloudTrailBucket).toBe('my-trail-bucket');
      expect(input.cloudTrailPrefix).toBe('CustomPrefix/');
      expect(input.daysToScan).toBe(30);
      expect(input.analyzers).toEqual(['cloudtrail', 'cloudformation']);
    });
  });

  describe('POST /analysis with scope=account', () => {
    it('uses provided accountIds when supplied', async () => {
      sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'arn:...' });

      const event = makeEvent({
        body: JSON.stringify({
          scope: 'account',
          accountIds: ['111111111111', '222222222222'],
          analyzerParams: { cloudtrail: { bucket: 'b' } },
        }),
      });

      await handleAnalyze(event);
      const input = JSON.parse(sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input.input!);
      expect(input.accounts).toEqual(['111111111111', '222222222222']);

      expect(orgsMock.commandCalls(ListAccountsCommand)).toHaveLength(0);
    });

    it('falls back to the invoking account when accountIds is omitted', async () => {
      sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'arn:...' });

      const event = makeEvent({
        body: JSON.stringify({
          scope: 'account',
          analyzerParams: { cloudtrail: { bucket: 'b' } },
        }),
      });

      await handleAnalyze(event);
      const input = JSON.parse(sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input.input!);
      expect(input.accounts).toEqual(['123456789012']);
    });
  });
});
