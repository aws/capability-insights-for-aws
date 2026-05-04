import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getUsedCapabilities } from './routes/usage-route';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockGetObject = vi.fn();
const mockListObjects = vi.fn();

vi.mock('./services/s3-client', () => ({
  S3BucketClient: vi.fn().mockImplementation(() => ({
    getObject: mockGetObject,
    listObjects: mockListObjects,
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

const sampleProducts = [
  {
    productId: 's3',
    productName: 'Amazon S3',
    productType: 'SERVICE',
    regionalAvailability: {},
  },
  {
    productId: 'lambda',
    productName: 'AWS Lambda',
    productType: 'SERVICE',
    regionalAvailability: {},
  },
  {
    productId: 'dynamodb',
    productName: 'Amazon DynamoDB',
    productType: 'SERVICE',
    regionalAvailability: {},
  },
];

const sampleUsageData = {
  cloudtrail: {
    '123456789012': {
      s3: { apis: ['GetObject', 'PutObject'], regionApis: { 'us-east-1': ['GetObject'] } },
      lambda: { apis: ['Invoke'], regionApis: { 'us-east-1': ['Invoke'] } },
    },
  },
  resourceExplorer: {
    '123456789012': {
      dynamodb: { resources: 5 },
    },
  },
  cloudformation: {},
};

describe('usage-route', () => {
  beforeEach(() => {
    vi.stubEnv('WEBSITE_BUCKET_NAME', 'test-bucket');
    mockGetObject.mockReset();
    mockListObjects.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 400 for invalid usageFilter', async () => {
    const event = makeEvent({ usageFilter: 'invalid' });
    const result = await getUsedCapabilities(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('Invalid usageFilter');
  });

  it('returns 404 when no usage files exist', async () => {
    mockGetObject.mockResolvedValueOnce(JSON.stringify(sampleProducts));
    mockListObjects.mockResolvedValueOnce([]);

    const event = makeEvent();
    const result = await getUsedCapabilities(event);
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toContain('No usage data found');
  });

  it('returns combined results by default', async () => {
    mockGetObject
      .mockResolvedValueOnce(JSON.stringify(sampleProducts))
      .mockResolvedValueOnce(JSON.stringify(sampleUsageData));
    mockListObjects.mockResolvedValueOnce(['usage/account-usage-2026-05-01.json']);

    const event = makeEvent();
    const result = await getUsedCapabilities(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    const serviceIds = body.services.map((s: { productId: string }) => s.productId);
    expect(serviceIds).toContain('s3');
    expect(serviceIds).toContain('lambda');
    expect(serviceIds).toContain('dynamodb');
    expect(body.apis.length).toBeGreaterThan(0);
  });

  it('returns only active_usage (CloudTrail) when filtered', async () => {
    mockGetObject
      .mockResolvedValueOnce(JSON.stringify(sampleProducts))
      .mockResolvedValueOnce(JSON.stringify(sampleUsageData));
    mockListObjects.mockResolvedValueOnce(['usage/account-usage-2026-05-01.json']);

    const event = makeEvent({ usageFilter: 'active_usage' });
    const result = await getUsedCapabilities(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    const serviceIds = body.services.map((s: { productId: string }) => s.productId);
    expect(serviceIds).toContain('s3');
    expect(serviceIds).toContain('lambda');
    // dynamodb is only in resourceExplorer, not cloudtrail
    expect(serviceIds).not.toContain('dynamodb');
  });

  it('returns only deployed (RE + CFN) when filtered', async () => {
    mockGetObject
      .mockResolvedValueOnce(JSON.stringify(sampleProducts))
      .mockResolvedValueOnce(JSON.stringify(sampleUsageData));
    mockListObjects.mockResolvedValueOnce(['usage/account-usage-2026-05-01.json']);

    const event = makeEvent({ usageFilter: 'deployed' });
    const result = await getUsedCapabilities(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    const serviceIds = body.services.map((s: { productId: string }) => s.productId);
    expect(serviceIds).toContain('dynamodb');
    // s3 and lambda are only in cloudtrail
    expect(serviceIds).not.toContain('s3');
    expect(body.apis).toEqual([]);
  });

  it('picks the latest usage file when multiple exist', async () => {
    mockGetObject
      .mockResolvedValueOnce(JSON.stringify(sampleProducts))
      .mockResolvedValueOnce(JSON.stringify(sampleUsageData));
    mockListObjects.mockResolvedValueOnce([
      'usage/account-usage-2026-04-01.json',
      'usage/account-usage-2026-05-01.json',
      'usage/account-usage-2026-03-15.json',
    ]);

    const event = makeEvent();
    await getUsedCapabilities(event);

    // Second getObject call should be for the latest file (sorted reverse)
    expect(mockGetObject).toHaveBeenCalledWith('usage/account-usage-2026-05-01.json');
  });

  it('filters by accountIds when provided', async () => {
    const multiAccountUsage = {
      cloudtrail: {
        '111': { s3: { apis: ['GetObject'], regionApis: {} } },
        '222': { lambda: { apis: ['Invoke'], regionApis: {} } },
      },
    };
    mockGetObject
      .mockResolvedValueOnce(JSON.stringify(sampleProducts))
      .mockResolvedValueOnce(JSON.stringify(multiAccountUsage));
    mockListObjects.mockResolvedValueOnce(['usage/account-usage-2026-05-01.json']);

    const event = makeEvent({ accountIds: '111' });
    const result = await getUsedCapabilities(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    const serviceIds = body.services.map((s: { productId: string }) => s.productId);
    expect(serviceIds).toContain('s3');
    expect(serviceIds).not.toContain('lambda');
  });

  it('uses organization prefix for organization scope', async () => {
    mockGetObject
      .mockResolvedValueOnce(JSON.stringify(sampleProducts))
      .mockResolvedValueOnce(JSON.stringify(sampleUsageData));
    mockListObjects.mockResolvedValueOnce([
      'usage/organization-usage-2026-05-01.json',
      'usage/account-usage-2026-05-01.json',
    ]);

    const event = makeEvent({ scope: 'organization' });
    const result = await getUsedCapabilities(event);
    expect(result.statusCode).toBe(200);
    expect(mockGetObject).toHaveBeenCalledWith('usage/organization-usage-2026-05-01.json');
  });
});
