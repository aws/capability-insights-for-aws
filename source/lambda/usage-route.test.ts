import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getUsedCapabilities } from './routes/usage-route';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockGetObject = vi.fn();

vi.mock('./services/s3-client', () => ({
  S3BucketClient: vi.fn().mockImplementation(() => ({
    getObject: mockGetObject,
  })),
}));

function makeEvent(query: Record<string, string> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/capabilities',
    body: null,
    headers: {},
    multiValueHeaders: {},
    isBase64Encoded: false,
    pathParameters: null,
    queryStringParameters: Object.keys(query).length > 0 ? query : null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '',
    requestContext: {
      accountId: '123456789012',
      apiId: 'test',
      authorizer: null,
      protocol: 'HTTP/1.1',
      httpMethod: 'GET',
      identity: {} as APIGatewayProxyEvent['requestContext']['identity'],
      path: '/capabilities',
      stage: 'prod',
      requestId: 'test-id',
      requestTimeEpoch: 0,
      resourceId: '',
      resourcePath: '',
    },
  };
}

const sampleBody = {
  products: [{ productId: 'lambda-pid', productName: 'AWS Lambda' }],
  apis: [{ sdkServiceName: 'Lambda', apis: [{ apiAction: 'Invoke' }] }],
  cfnResources: [{ serviceName: 'Lambda', resourceTypes: [{ resourceTypeName: 'Function' }] }],
  lastAnalyzedAt: '2026-05-08T11:37:09.435Z',
};

describe('usage-route', () => {
  beforeEach(() => {
    vi.stubEnv('WEBSITE_BUCKET_NAME', 'test-bucket');
    mockGetObject.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('validation', () => {
    it('returns 400 for invalid usageFilter', async () => {
      const event = makeEvent({ usageFilter: 'invalid' });
      const result = await getUsedCapabilities(event);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('Invalid usageFilter');
    });

    it('returns 400 for invalid scope', async () => {
      const event = makeEvent({ scope: 'bogus' });
      const result = await getUsedCapabilities(event);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('Invalid scope');
    });
  });

  describe('S3 key construction', () => {
    it('uses defaults (account + combined) when no params provided', async () => {
      mockGetObject.mockResolvedValueOnce(JSON.stringify(sampleBody));

      const event = makeEvent();
      const result = await getUsedCapabilities(event);
      expect(result.statusCode).toBe(200);
      expect(mockGetObject).toHaveBeenCalledWith('data/json/used-capabilities-account-combined.json');
    });

    it('reads the file matching scope=organization + usageFilter=deployed', async () => {
      mockGetObject.mockResolvedValueOnce(JSON.stringify(sampleBody));

      const event = makeEvent({ scope: 'organization', usageFilter: 'deployed' });
      await getUsedCapabilities(event);
      expect(mockGetObject).toHaveBeenCalledWith('data/json/used-capabilities-organization-deployed.json');
    });

    it('reads the active_usage file for account scope', async () => {
      mockGetObject.mockResolvedValueOnce(JSON.stringify(sampleBody));

      const event = makeEvent({ usageFilter: 'active_usage' });
      await getUsedCapabilities(event);
      expect(mockGetObject).toHaveBeenCalledWith('data/json/used-capabilities-account-active_usage.json');
    });
  });

  describe('response', () => {
    it('returns 200 with the file body verbatim', async () => {
      mockGetObject.mockResolvedValueOnce(JSON.stringify(sampleBody));

      const event = makeEvent();
      const result = await getUsedCapabilities(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual(sampleBody);
    });

    it('includes CORS headers', async () => {
      mockGetObject.mockResolvedValueOnce(JSON.stringify(sampleBody));

      const event = makeEvent();
      const result = await getUsedCapabilities(event);

      expect(result.headers).toMatchObject({
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
    });
  });

  describe('missing file', () => {
    it('returns 404 with a helpful message when the file does not exist', async () => {
      mockGetObject.mockRejectedValueOnce(new Error('NoSuchKey'));

      const event = makeEvent({ scope: 'organization' });
      const result = await getUsedCapabilities(event);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body).error).toContain('scope=organization');
    });
  });
});
