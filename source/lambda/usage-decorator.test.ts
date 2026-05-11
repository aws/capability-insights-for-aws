import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handler } from './usage-decorator';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { sdkStreamMixin } from '@smithy/util-stream';
import { Readable } from 'stream';

const s3Mock = mockClient(S3Client);

const sampleProducts = [
  {
    productId: 'lambda-pid',
    productName: 'AWS Lambda',
    productType: 'SERVICE',
    regionalAvailability: { 'us-east-1': 'Available' },
    childProducts: [
      {
        productId: 'lambda-pid-layer',
        productName: 'AWS Lambda Layers',
        productType: 'FEATURE',
        regionalAvailability: { 'us-east-1': 'Available' },
      },
    ],
  },
  {
    productId: 's3-pid',
    productName: 'Amazon S3',
    productType: 'SERVICE',
    regionalAvailability: { 'us-east-1': 'Available' },
    childProducts: [],
  },
  {
    productId: 'ec2-pid',
    productName: 'Amazon EC2',
    productType: 'SERVICE',
    regionalAvailability: { 'us-east-1': 'Available' },
    childProducts: [],
  },
  {
    productId: 'unused-pid',
    productName: 'Unused Service',
    productType: 'SERVICE',
    regionalAvailability: { 'us-east-1': 'Available' },
    childProducts: [],
  },
];

const sampleApis = [
  {
    sdkServiceName: 'Lambda',
    productID: 'lambda-pid',
    productName: 'AWS Lambda',
    apis: [
      { apiName: 'Lambda+Invoke', apiAction: 'Invoke' },
      { apiName: 'Lambda+CreateFunction', apiAction: 'CreateFunction' },
      { apiName: 'Lambda+DeleteFunction', apiAction: 'DeleteFunction' },
    ],
  },
  {
    sdkServiceName: 'S3',
    productID: 's3-pid',
    productName: 'Amazon S3',
    apis: [
      { apiName: 'S3+GetObject', apiAction: 'GetObject' },
      { apiName: 'S3+PutObject', apiAction: 'PutObject' },
    ],
  },
  {
    sdkServiceName: 'EC2',
    productID: 'ec2-pid',
    productName: 'Amazon EC2',
    apis: [{ apiName: 'EC2+DescribeInstances', apiAction: 'DescribeInstances' }],
  },
  {
    sdkServiceName: 'Unused',
    productID: 'unused-pid',
    productName: 'Unused Service',
    apis: [{ apiName: 'Unused+DoThing', apiAction: 'DoThing' }],
  },
];

const sampleCfnResources = [
  {
    serviceName: 'Lambda',
    resourceTypes: [
      { resourceTypeName: 'Function', regionalAvailability: { 'us-east-1': 'Available' } },
      { resourceTypeName: 'LayerVersion', regionalAvailability: { 'us-east-1': 'Available' } },
    ],
  },
  {
    serviceName: 'S3',
    resourceTypes: [{ resourceTypeName: 'Bucket', regionalAvailability: { 'us-east-1': 'Available' } }],
  },
  {
    serviceName: 'EC2',
    resourceTypes: [{ resourceTypeName: 'Instance', regionalAvailability: { 'us-east-1': 'Available' } }],
  },
];

const asStreamingBody = (obj: unknown) => sdkStreamMixin(Readable.from([JSON.stringify(obj)]));

function mockCatalogFetches() {
  s3Mock
    .on(GetObjectCommand, { Key: 'data/json/products.json' })
    .resolves({ Body: asStreamingBody(sampleProducts) as never })
    .on(GetObjectCommand, { Key: 'data/json/apis.json' })
    .resolves({ Body: asStreamingBody(sampleApis) as never })
    .on(GetObjectCommand, { Key: 'data/json/cfn_resources.json' })
    .resolves({ Body: asStreamingBody(sampleCfnResources) as never });
}

interface CapturedBody {
  products: Array<{ productId: string; childProducts?: Array<{ productId: string }> }>;
  apis: Array<{ sdkServiceName: string; apis: Array<{ apiAction: string }> }>;
  cfnResources: Array<{
    serviceName: string;
    resourceTypes: Array<{
      resourceTypeName: string;
      usage?: { stacks: string[]; properties: Record<string, string[]>; count: number };
    }>;
  }>;
  lastAnalyzedAt: string;
}

function capturedPut(key: string): CapturedBody {
  const calls = s3Mock.commandCalls(PutObjectCommand);
  const call = calls.find(c => c.args[0].input.Key === key);
  if (!call) throw new Error(`No PutObject for ${key}`);
  return JSON.parse(call.args[0].input.Body as string) as CapturedBody;
}

describe('usage-decorator', () => {
  beforeEach(() => {
    s3Mock.reset();
    mockCatalogFetches();
    s3Mock.on(PutObjectCommand).resolves({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('input validation', () => {
    it('throws when websiteBucket is missing', async () => {
      await expect(handler({})).rejects.toThrow('websiteBucket');
    });
  });

  describe('file layout', () => {
    it('writes three files for account scope (default)', async () => {
      await handler({ websiteBucket: 'test-bucket', parallelResults: [{}, null] });

      const puts = s3Mock.commandCalls(PutObjectCommand);
      const keys = puts.map(p => p.args[0].input.Key).sort();
      expect(keys).toEqual([
        'data/json/used-capabilities-account-active_usage.json',
        'data/json/used-capabilities-account-combined.json',
        'data/json/used-capabilities-account-deployed.json',
      ]);
    });

    it('writes three files for organization scope', async () => {
      await handler({ websiteBucket: 'test-bucket', scope: 'organization', parallelResults: [{}, null] });

      const puts = s3Mock.commandCalls(PutObjectCommand);
      const keys = puts.map(p => p.args[0].input.Key).sort();
      expect(keys).toEqual([
        'data/json/used-capabilities-organization-active_usage.json',
        'data/json/used-capabilities-organization-combined.json',
        'data/json/used-capabilities-organization-deployed.json',
      ]);
    });

    it('each file has the expected top-level shape', async () => {
      await handler({ websiteBucket: 'test-bucket', parallelResults: [{}, null] });

      for (const mode of ['deployed', 'active_usage', 'combined']) {
        const body = capturedPut(`data/json/used-capabilities-account-${mode}.json`);
        expect(body).toHaveProperty('products');
        expect(body).toHaveProperty('apis');
        expect(body).toHaveProperty('cfnResources');
        expect(body).toHaveProperty('lastAnalyzedAt');
      }
    });
  });

  describe('filter mode: deployed', () => {
    it('populates products from CloudFormation matches only', async () => {
      const cloudFormationUsage = {
        accountId: '123456789012',
        region: 'us-east-1',
        records: [{ stackName: 'AppStack', serviceName: 'Lambda', resourceTypeName: 'Function', properties: {} }],
      };
      const cloudTrailUsage = {
        '123456789012': {
          's3.amazonaws.com': { apis: ['GetObject'], regionApis: { 'us-east-1': ['GetObject'] } },
        },
      };

      await handler({ websiteBucket: 'test-bucket', parallelResults: [cloudTrailUsage, cloudFormationUsage] });

      const body = capturedPut('data/json/used-capabilities-account-deployed.json');
      expect(body.products.map(p => p.productId).sort()).toEqual(['lambda-pid']);
    });

    it('has empty apis array', async () => {
      const cloudTrailUsage = {
        '123456789012': {
          'lambda.amazonaws.com': { apis: ['Invoke'], regionApis: { 'us-east-1': ['Invoke'] } },
        },
      };
      await handler({ websiteBucket: 'test-bucket', parallelResults: [cloudTrailUsage, null] });

      const body = capturedPut('data/json/used-capabilities-account-deployed.json');
      expect(body.apis).toEqual([]);
    });

    it('populates cfnResources with usage enrichment', async () => {
      const cloudFormationUsage = {
        accountId: '123456789012',
        region: 'us-east-1',
        records: [
          {
            stackName: 'AppStack',
            serviceName: 'Lambda',
            resourceTypeName: 'Function',
            properties: { Runtime: ['python3.11'], MemorySize: ['256'] },
          },
          {
            stackName: 'ApiStack',
            serviceName: 'Lambda',
            resourceTypeName: 'Function',
            properties: { Runtime: ['nodejs20.x'] },
          },
        ],
      };
      await handler({ websiteBucket: 'test-bucket', parallelResults: [{}, cloudFormationUsage] });

      const body = capturedPut('data/json/used-capabilities-account-deployed.json');
      const lambda = body.cfnResources.find(r => r.serviceName === 'Lambda');
      const fn = lambda?.resourceTypes.find(rt => rt.resourceTypeName === 'Function');
      expect(fn?.usage?.stacks.sort()).toEqual(['ApiStack', 'AppStack']);
      expect(fn?.usage?.count).toBe(2);
      expect(fn?.usage?.properties.Runtime?.sort()).toEqual(['nodejs20.x', 'python3.11']);
      expect(fn?.usage?.properties.MemorySize).toEqual(['256']);
    });

    it('narrows resourceProperties.resourceConfigurations to deployed values only', async () => {
      // Master cfn_resources.json lists all possible InstanceType configurations
      // for EC2::Instance. The decorator should narrow this to only the values
      // actually deployed (t3.medium), dropping c5.large / m5.xlarge / etc.
      const richCfnResources = [
        {
          serviceName: 'EC2',
          resourceTypes: [
            {
              resourceTypeName: 'Instance',
              regionalAvailability: { 'us-east-1': 'Available' },
              resourceProperties: [
                {
                  resourcePropertyName: 'InstanceType',
                  resourceConfigurations: [
                    { resourceConfigurationName: 't3.medium', regionalAvailability: {} },
                    { resourceConfigurationName: 'c5.large', regionalAvailability: {} },
                    { resourceConfigurationName: 'm5.xlarge', regionalAvailability: {} },
                  ],
                },
              ],
            },
          ],
        },
      ];

      s3Mock.reset();
      s3Mock
        .on(GetObjectCommand, { Key: 'data/json/products.json' })
        .resolves({ Body: asStreamingBody(sampleProducts) as never })
        .on(GetObjectCommand, { Key: 'data/json/apis.json' })
        .resolves({ Body: asStreamingBody(sampleApis) as never })
        .on(GetObjectCommand, { Key: 'data/json/cfn_resources.json' })
        .resolves({ Body: asStreamingBody(richCfnResources) as never })
        .on(PutObjectCommand)
        .resolves({});

      const cloudFormationUsage = {
        accountId: '123456789012',
        region: 'us-east-1',
        records: [
          {
            stackName: 'AppStack',
            serviceName: 'EC2',
            resourceTypeName: 'Instance',
            properties: { InstanceType: ['t3.medium'] },
          },
        ],
      };
      await handler({ websiteBucket: 'test-bucket', parallelResults: [{}, cloudFormationUsage] });

      const body = capturedPut('data/json/used-capabilities-account-deployed.json');
      const ec2 = body.cfnResources.find(r => r.serviceName === 'EC2');
      const instance = ec2?.resourceTypes.find(rt => rt.resourceTypeName === 'Instance') as {
        resourceProperties?: Array<{
          resourcePropertyName: string;
          resourceConfigurations: Array<{ resourceConfigurationName: string }>;
        }>;
      };
      expect(instance?.resourceProperties).toHaveLength(1);
      const instanceTypeProp = instance?.resourceProperties?.[0];
      expect(instanceTypeProp?.resourcePropertyName).toBe('InstanceType');
      expect(instanceTypeProp?.resourceConfigurations.map(c => c.resourceConfigurationName)).toEqual(['t3.medium']);
    });

    it('drops resource types and services with no CFN usage', async () => {
      const cloudFormationUsage = {
        accountId: '123456789012',
        region: 'us-east-1',
        records: [{ stackName: 'AppStack', serviceName: 'Lambda', resourceTypeName: 'Function', properties: {} }],
      };
      await handler({ websiteBucket: 'test-bucket', parallelResults: [{}, cloudFormationUsage] });

      const body = capturedPut('data/json/used-capabilities-account-deployed.json');
      // Only Lambda::Function should remain. S3::Bucket, EC2::Instance, Lambda::LayerVersion should be absent.
      expect(body.cfnResources).toHaveLength(1);
      expect(body.cfnResources[0].serviceName).toBe('Lambda');
      expect(body.cfnResources[0].resourceTypes).toHaveLength(1);
      expect(body.cfnResources[0].resourceTypes[0].resourceTypeName).toBe('Function');
    });
  });

  describe('filter mode: active_usage', () => {
    it('populates products from CloudTrail matches only', async () => {
      const cloudFormationUsage = {
        accountId: '123456789012',
        region: 'us-east-1',
        records: [{ stackName: 'AppStack', serviceName: 'EC2', resourceTypeName: 'Instance', properties: {} }],
      };
      const cloudTrailUsage = {
        '123456789012': {
          'lambda.amazonaws.com': { apis: ['Invoke'], regionApis: { 'us-east-1': ['Invoke'] } },
        },
      };

      await handler({ websiteBucket: 'test-bucket', parallelResults: [cloudTrailUsage, cloudFormationUsage] });

      const body = capturedPut('data/json/used-capabilities-account-active_usage.json');
      expect(body.products.map(p => p.productId)).toEqual(['lambda-pid']);
    });

    it('scopes each service apis[] to only the called APIs', async () => {
      const cloudTrailUsage = {
        '123456789012': {
          'lambda.amazonaws.com': {
            apis: ['Invoke', 'CreateFunction'],
            regionApis: { 'us-east-1': ['Invoke', 'CreateFunction'] },
          },
        },
      };
      await handler({ websiteBucket: 'test-bucket', parallelResults: [cloudTrailUsage, null] });

      const body = capturedPut('data/json/used-capabilities-account-active_usage.json');
      expect(body.apis).toHaveLength(1);
      const lambdaApi = body.apis[0];
      expect(lambdaApi.sdkServiceName).toBe('Lambda');
      // DeleteFunction was not called, so it should NOT appear
      expect(lambdaApi.apis.map(a => a.apiAction).sort()).toEqual(['CreateFunction', 'Invoke']);
    });

    it('has empty cfnResources array', async () => {
      const cloudFormationUsage = {
        accountId: '123456789012',
        region: 'us-east-1',
        records: [{ stackName: 'AppStack', serviceName: 'Lambda', resourceTypeName: 'Function', properties: {} }],
      };
      await handler({ websiteBucket: 'test-bucket', parallelResults: [{}, cloudFormationUsage] });

      const body = capturedPut('data/json/used-capabilities-account-active_usage.json');
      expect(body.cfnResources).toEqual([]);
    });

    it('drops services entirely when no APIs were called', async () => {
      const cloudTrailUsage = {
        '123456789012': {
          'lambda.amazonaws.com': { apis: ['Invoke'], regionApis: { 'us-east-1': ['Invoke'] } },
        },
      };
      await handler({ websiteBucket: 'test-bucket', parallelResults: [cloudTrailUsage, null] });

      const body = capturedPut('data/json/used-capabilities-account-active_usage.json');
      // S3, EC2, Unused should be absent since no CloudTrail calls for them
      const sdkServiceNames = body.apis.map(a => a.sdkServiceName);
      expect(sdkServiceNames).toEqual(['Lambda']);
    });
  });

  describe('filter mode: combined', () => {
    it('populates products from the union of both sources', async () => {
      const cloudFormationUsage = {
        accountId: '123456789012',
        region: 'us-east-1',
        records: [{ stackName: 'AppStack', serviceName: 'EC2', resourceTypeName: 'Instance', properties: {} }],
      };
      const cloudTrailUsage = {
        '123456789012': {
          'lambda.amazonaws.com': { apis: ['Invoke'], regionApis: { 'us-east-1': ['Invoke'] } },
        },
      };

      await handler({ websiteBucket: 'test-bucket', parallelResults: [cloudTrailUsage, cloudFormationUsage] });

      const body = capturedPut('data/json/used-capabilities-account-combined.json');
      expect(body.products.map(p => p.productId).sort()).toEqual(['ec2-pid', 'lambda-pid']);
    });

    it('dedupes products across sources', async () => {
      const cloudFormationUsage = {
        accountId: '123456789012',
        region: 'us-east-1',
        records: [{ stackName: 'AppStack', serviceName: 'Lambda', resourceTypeName: 'Function', properties: {} }],
      };
      const cloudTrailUsage = {
        '123456789012': {
          'lambda.amazonaws.com': { apis: ['Invoke'], regionApis: { 'us-east-1': ['Invoke'] } },
        },
      };

      await handler({ websiteBucket: 'test-bucket', parallelResults: [cloudTrailUsage, cloudFormationUsage] });

      const body = capturedPut('data/json/used-capabilities-account-combined.json');
      // Lambda is in both — should appear exactly once
      const pids = body.products.map(p => p.productId);
      expect(pids).toEqual(['lambda-pid']);
    });

    it('includes both apis (from CloudTrail) and cfnResources (from CloudFormation)', async () => {
      const cloudFormationUsage = {
        accountId: '123456789012',
        region: 'us-east-1',
        records: [{ stackName: 'AppStack', serviceName: 'EC2', resourceTypeName: 'Instance', properties: {} }],
      };
      const cloudTrailUsage = {
        '123456789012': {
          'lambda.amazonaws.com': { apis: ['Invoke'], regionApis: { 'us-east-1': ['Invoke'] } },
        },
      };

      await handler({ websiteBucket: 'test-bucket', parallelResults: [cloudTrailUsage, cloudFormationUsage] });

      const body = capturedPut('data/json/used-capabilities-account-combined.json');
      expect(body.apis.map(a => a.sdkServiceName)).toEqual(['Lambda']);
      expect(body.cfnResources.map(c => c.serviceName)).toEqual(['EC2']);
    });
  });

  describe('child products', () => {
    it('filters child products by productId in matched products', async () => {
      const cloudTrailUsage = {
        '123456789012': {
          'lambda.amazonaws.com': { apis: ['Invoke'], regionApis: { 'us-east-1': ['Invoke'] } },
        },
      };
      await handler({ websiteBucket: 'test-bucket', parallelResults: [cloudTrailUsage, null] });

      const body = capturedPut('data/json/used-capabilities-account-active_usage.json');
      const lambda = body.products.find(p => p.productId === 'lambda-pid');
      // Lambda parent matched, but Lambda Layer (child) wasn't seen in usage — should be dropped
      expect(lambda?.childProducts).toEqual([]);
    });
  });

  describe('graceful degradation', () => {
    it('handles failed CloudTrail branch', async () => {
      const failedBranch = { analyzer: 'cloudtrail', status: 'failed', error: 'boom' };
      const cloudFormationUsage = {
        accountId: '123456789012',
        region: 'us-east-1',
        records: [{ stackName: 'AppStack', serviceName: 'Lambda', resourceTypeName: 'Function', properties: {} }],
      };

      await handler({ websiteBucket: 'test-bucket', parallelResults: [failedBranch, cloudFormationUsage] });

      const deployed = capturedPut('data/json/used-capabilities-account-deployed.json');
      expect(deployed.products).toHaveLength(1);
      expect(deployed.cfnResources).toHaveLength(1);

      const activeUsage = capturedPut('data/json/used-capabilities-account-active_usage.json');
      expect(activeUsage.products).toEqual([]);
      expect(activeUsage.apis).toEqual([]);
    });

    it('handles failed CloudFormation branch', async () => {
      const cloudTrailUsage = {
        '123456789012': {
          'lambda.amazonaws.com': { apis: ['Invoke'], regionApis: { 'us-east-1': ['Invoke'] } },
        },
      };
      const failedBranch = { analyzer: 'cloudformation', status: 'failed', error: 'boom' };

      await handler({ websiteBucket: 'test-bucket', parallelResults: [cloudTrailUsage, failedBranch] });

      const deployed = capturedPut('data/json/used-capabilities-account-deployed.json');
      expect(deployed.products).toEqual([]);
      expect(deployed.cfnResources).toEqual([]);

      const activeUsage = capturedPut('data/json/used-capabilities-account-active_usage.json');
      expect(activeUsage.products).toHaveLength(1);
      expect(activeUsage.apis).toHaveLength(1);
    });

    it('handles missing parallelResults entirely', async () => {
      await handler({ websiteBucket: 'test-bucket' });

      for (const mode of ['deployed', 'active_usage', 'combined']) {
        const body = capturedPut(`data/json/used-capabilities-account-${mode}.json`);
        expect(body.products).toEqual([]);
        expect(body.apis).toEqual([]);
        expect(body.cfnResources).toEqual([]);
      }
    });
  });

  describe('sdk service name normalization', () => {
    it('strips .amazonaws.com suffix from CloudTrail eventSources', async () => {
      const cloudTrailUsage = {
        '123456789012': {
          'lambda.amazonaws.com': { apis: ['Invoke'], regionApis: { 'us-east-1': ['Invoke'] } },
        },
      };
      await handler({ websiteBucket: 'test-bucket', parallelResults: [cloudTrailUsage, null] });

      const body = capturedPut('data/json/used-capabilities-account-active_usage.json');
      expect(body.products.map(p => p.productId)).toEqual(['lambda-pid']);
    });

    it('handles collapsed sdkServiceName variants (with spaces/dashes)', async () => {
      // Add an ApiService with a spaced name to verify collapsed lookup works
      const apisWithSpace = [
        ...sampleApis,
        {
          sdkServiceName: 'API Gateway',
          productID: 'apigw-pid',
          productName: 'Amazon API Gateway',
          apis: [{ apiName: 'APIGateway+CreateApi', apiAction: 'CreateApi' }],
        },
      ];
      s3Mock.reset();
      s3Mock
        .on(GetObjectCommand, { Key: 'data/json/products.json' })
        .resolves({ Body: asStreamingBody(sampleProducts) as never })
        .on(GetObjectCommand, { Key: 'data/json/apis.json' })
        .resolves({ Body: asStreamingBody(apisWithSpace) as never })
        .on(GetObjectCommand, { Key: 'data/json/cfn_resources.json' })
        .resolves({ Body: asStreamingBody(sampleCfnResources) as never })
        .on(PutObjectCommand)
        .resolves({});

      const cloudTrailUsage = {
        '123456789012': {
          // CloudTrail uses "apigateway" (no space) — should still match "API Gateway"
          'apigateway.amazonaws.com': { apis: ['CreateApi'], regionApis: { 'us-east-1': ['CreateApi'] } },
        },
      };
      await handler({ websiteBucket: 'test-bucket', parallelResults: [cloudTrailUsage, null] });

      const body = capturedPut('data/json/used-capabilities-account-active_usage.json');
      expect(body.apis.map(a => a.sdkServiceName)).toEqual(['API Gateway']);
    });

    it('resolves CloudTrail-specific event sources via the alias map', async () => {
      // monitoring.amazonaws.com is the CloudTrail source for CloudWatch
      const apisWithCloudWatch = [
        {
          sdkServiceName: 'CloudWatch',
          productID: 'cloudwatch-pid',
          productName: 'Amazon CloudWatch',
          apis: [{ apiName: 'CloudWatch+GetMetricData', apiAction: 'GetMetricData' }],
        },
      ];
      const productsWithCloudWatch = [
        {
          productId: 'cloudwatch-pid',
          productName: 'Amazon CloudWatch',
          productType: 'SERVICE',
          regionalAvailability: { 'us-east-1': 'Available' },
          childProducts: [],
        },
      ];

      s3Mock.reset();
      s3Mock
        .on(GetObjectCommand, { Key: 'data/json/products.json' })
        .resolves({ Body: asStreamingBody(productsWithCloudWatch) as never })
        .on(GetObjectCommand, { Key: 'data/json/apis.json' })
        .resolves({ Body: asStreamingBody(apisWithCloudWatch) as never })
        .on(GetObjectCommand, { Key: 'data/json/cfn_resources.json' })
        .resolves({ Body: asStreamingBody([]) as never })
        .on(PutObjectCommand)
        .resolves({});

      const cloudTrailUsage = {
        '123456789012': {
          'monitoring.amazonaws.com': {
            apis: ['GetMetricData'],
            regionApis: { 'us-east-1': ['GetMetricData'] },
          },
        },
      };
      await handler({ websiteBucket: 'test-bucket', parallelResults: [cloudTrailUsage, null] });

      const body = capturedPut('data/json/used-capabilities-account-active_usage.json');
      // Without the alias map this would not resolve because the cleaned
      // event source ("monitoring") doesn't match the sdkServiceName ("cloudwatch").
      expect(body.products.map(p => p.productId)).toEqual(['cloudwatch-pid']);
      expect(body.apis.map(a => a.sdkServiceName)).toEqual(['CloudWatch']);
    });

    it('prefers direct sdkServiceName match over alias map', async () => {
      // If CloudTrail source matches an sdkServiceName directly (e.g., lambda),
      // it should not consult the alias map.
      const cloudTrailUsage = {
        '123456789012': {
          'lambda.amazonaws.com': { apis: ['Invoke'], regionApis: { 'us-east-1': ['Invoke'] } },
        },
      };
      await handler({ websiteBucket: 'test-bucket', parallelResults: [cloudTrailUsage, null] });

      const body = capturedPut('data/json/used-capabilities-account-active_usage.json');
      expect(body.products.map(p => p.productId)).toEqual(['lambda-pid']);
    });
  });
});
