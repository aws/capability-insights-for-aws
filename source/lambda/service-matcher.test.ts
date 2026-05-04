import { describe, it, expect } from 'vitest';
import {
  getUsedProducts,
  getUsedApis,
  getUsedServices,
  filterUsedServices,
  filterUsedProducts,
  matchCloudTrailToCapabilities,
  type CloudTrailUsage,
} from './services/service-matcher';
import type { Product } from '@capability-insights/shared/types/capability/product';
import { ProductType } from '@capability-insights/shared/types/capability/product';
import type { ApiService } from '@capability-insights/shared/types/capability/api';

const makeProduct = (id: string, name: string, children: Product[] = []): Product => ({
  productId: id,
  productName: name,
  productType: ProductType.SERVICE,
  regionalAvailability: {},
  childProducts: children,
});

const makeApiService = (sdkName: string, fullName: string): ApiService => ({
  sdkServiceName: sdkName,
  sdkServiceFullName: fullName,
  apis: [],
});

const sampleUsage: CloudTrailUsage = {
  '123456789012': {
    s3: {
      apis: ['GetObject', 'PutObject'],
      regionApis: { 'us-east-1': ['GetObject', 'PutObject'] },
    },
    lambda: {
      apis: ['Invoke'],
      regionApis: { 'us-east-1': ['Invoke'] },
    },
  },
};

describe('service-matcher', () => {
  describe('getUsedApis', () => {
    it('returns service:api pairs from CloudTrail usage', () => {
      const apis = getUsedApis(sampleUsage);
      expect(apis).toContain('s3:GetObject');
      expect(apis).toContain('s3:PutObject');
      expect(apis).toContain('lambda:Invoke');
      expect(apis).toHaveLength(3);
    });

    it('returns empty array when no usage provided', () => {
      expect(getUsedApis(undefined)).toEqual([]);
      expect(getUsedApis({})).toEqual([]);
    });

    it('deduplicates apis across accounts', () => {
      const usage: CloudTrailUsage = {
        '111': { s3: { apis: ['GetObject'], regionApis: {} } },
        '222': { s3: { apis: ['GetObject'], regionApis: {} } },
      };
      const apis = getUsedApis(usage);
      expect(apis.filter(a => a === 's3:GetObject')).toHaveLength(1);
    });
  });

  describe('getUsedProducts', () => {
    const products = [
      makeProduct('s3', 'Amazon S3'),
      makeProduct('lambda', 'AWS Lambda'),
      makeProduct('dynamodb', 'Amazon DynamoDB'),
    ];

    it('filters products matching CloudTrail usage', () => {
      const result = getUsedProducts(products, sampleUsage);
      const ids = result.map(p => p.productId);
      expect(ids).toContain('s3');
      expect(ids).toContain('lambda');
      expect(ids).not.toContain('dynamodb');
    });

    it('returns empty when no usage data', () => {
      expect(getUsedProducts(products)).toEqual([]);
      expect(getUsedProducts(products, {})).toEqual([]);
    });

    it('combines CloudTrail and Resource Explorer usage', () => {
      const reUsage = { '123': { dynamodb: { resources: 5 } } };
      const result = getUsedProducts(products, sampleUsage, reUsage);
      const ids = result.map(p => p.productId);
      expect(ids).toContain('s3');
      expect(ids).toContain('lambda');
      expect(ids).toContain('dynamodb');
    });

    it('combines all three sources', () => {
      const cfnUsage = { '123': { dynamodb: { stacks: 2 } } };
      const result = getUsedProducts(products, undefined, undefined, cfnUsage);
      const ids = result.map(p => p.productId);
      expect(ids).toContain('dynamodb');
      expect(ids).not.toContain('s3');
    });

    it('filters child products to only used ones', () => {
      const parentProducts = [
        makeProduct('s3', 'Amazon S3', [
          makeProduct('s3-glacier', 'S3 Glacier'),
          makeProduct('s3-express', 'S3 Express'),
        ]),
      ];
      // s3 is used, and child products match via productName containing "s3"
      const result = getUsedProducts(parentProducts, sampleUsage);
      expect(result).toHaveLength(1);
      // Children match because their names contain "s3"
      expect(result[0].childProducts).toHaveLength(2);

      // Now test with children that don't match
      const parentWithUnrelatedChildren = [
        makeProduct('s3', 'Amazon S3', [makeProduct('kinesis-firehose', 'Amazon Kinesis Firehose')]),
      ];
      const result2 = getUsedProducts(parentWithUnrelatedChildren, sampleUsage);
      expect(result2).toHaveLength(1);
      expect(result2[0].childProducts).toEqual([]);
    });
  });

  describe('getUsedServices', () => {
    const services = [
      makeApiService('s3', 'Amazon Simple Storage Service'),
      makeApiService('lambda', 'AWS Lambda'),
      makeApiService('ec2', 'Amazon EC2'),
    ];

    it('filters services matching CloudTrail usage', () => {
      const result = getUsedServices(services, sampleUsage);
      const names = result.map(s => s.sdkServiceName);
      expect(names).toContain('s3');
      expect(names).toContain('lambda');
      expect(names).not.toContain('ec2');
    });

    it('returns empty when no usage', () => {
      expect(getUsedServices(services)).toEqual([]);
    });
  });

  describe('filterUsedServices', () => {
    const services = [
      makeApiService('s3', 'Amazon Simple Storage Service'),
      makeApiService('lambda', 'AWS Lambda'),
      makeApiService('ec2', 'Amazon EC2'),
    ];

    it('filters to only services present in CloudTrail usage', () => {
      const result = filterUsedServices(services, sampleUsage);
      expect(result).toHaveLength(2);
    });
  });

  describe('filterUsedProducts', () => {
    const products = [
      makeProduct('s3', 'Amazon S3'),
      makeProduct('lambda', 'AWS Lambda'),
      makeProduct('dynamodb', 'Amazon DynamoDB'),
    ];

    it('filters to only products present in CloudTrail usage', () => {
      const result = filterUsedProducts(products, sampleUsage);
      expect(result).toHaveLength(2);
    });
  });

  describe('matchCloudTrailToCapabilities', () => {
    const services = [makeApiService('s3', 'Amazon Simple Storage Service')];
    const products = [makeProduct('s3', 'Amazon S3')];

    it('matches CloudTrail events to products and services', () => {
      const result = matchCloudTrailToCapabilities(sampleUsage, services, products);
      expect(result).toHaveProperty('123456789012');

      const matches = result['123456789012'];
      const s3Match = matches.find(m => m.eventSource === 's3');
      expect(s3Match).toBeDefined();
      expect(s3Match!.service?.sdkServiceName).toBe('s3');
      expect(s3Match!.product?.productId).toBe('s3');
      expect(s3Match!.apis).toEqual(['GetObject', 'PutObject']);
    });

    it('handles unmatched services', () => {
      const result = matchCloudTrailToCapabilities(sampleUsage, [], []);
      const matches = result['123456789012'];
      expect(matches).toHaveLength(2);
      expect(matches[0].service).toBeUndefined();
      expect(matches[0].product).toBeUndefined();
    });
  });
});
