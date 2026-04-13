import { describe, it, expect } from 'vitest';
import { mergeJson } from './merge-json';

describe('mergeJson', () => {
  describe('regions', () => {
    it('merges regions from different sources', () => {
      const chunk1 = JSON.stringify([
        {
          Region: 'us-east-1',
          RegionLongName: 'US East (N. Virginia)',
          Partition: 'aws',
          RegionStatus: 'available',
          RequireRegionOptIn: false,
        },
      ]);
      const chunk2 = JSON.stringify([
        {
          Region: 'eu-west-1',
          RegionLongName: 'Europe (Ireland)',
          Partition: 'aws',
          RegionStatus: 'available',
          RequireRegionOptIn: false,
        },
      ]);

      const result = JSON.parse(mergeJson([chunk1, chunk2], r => r.Region));

      expect(result).toHaveLength(2);
      expect(result.map(r => r.Region).sort()).toEqual(['eu-west-1', 'us-east-1']);
    });
  });

  describe('products', () => {
    it('merges product availability from different region sources', () => {
      const chunk1 = JSON.stringify([
        {
          productId: 'product-1',
          productName: 'Test Service',
          productType: 'SERVICE',
          regionalAvailability: { 'us-east-1': 'Available', 'us-west-2': 'Available' },
          childProducts: [
            {
              productId: 'feature-1',
              productName: 'Test Feature',
              productType: 'FEATURE',
              regionalAvailability: { 'us-east-1': 'Available' },
            },
          ],
        },
      ]);
      const chunk2 = JSON.stringify([
        {
          productId: 'product-1',
          productName: 'Test Service',
          productType: 'SERVICE',
          regionalAvailability: { 'eu-west-1': 'Available', 'ap-northeast-1': 'Planning' },
          childProducts: [
            {
              productId: 'feature-1',
              productName: 'Test Feature',
              productType: 'FEATURE',
              regionalAvailability: { 'eu-west-1': 'Available' },
            },
          ],
        },
      ]);

      const result = JSON.parse(
        mergeJson([chunk1, chunk2], p => p.productId, [{ key: 'childProducts', getId: c => c.productId }]),
      );

      expect(result).toHaveLength(1);
      expect(result[0].regionalAvailability).toEqual({
        'us-east-1': 'Available',
        'us-west-2': 'Available',
        'eu-west-1': 'Available',
        'ap-northeast-1': 'Planning',
      });
      expect(result[0].childProducts).toHaveLength(1);
      expect(result[0].childProducts[0].regionalAvailability).toEqual({
        'us-east-1': 'Available',
        'eu-west-1': 'Available',
      });
    });
  });

  describe('apis', () => {
    it('merges API operation availability from different region sources', () => {
      const chunk1 = JSON.stringify([
        {
          sdkServiceName: 'test-service',
          sdkServiceFullName: 'Test Service',
          productID: 'product-1',
          productName: 'Test Service',
          apis: [
            {
              apiName: 'TestOperation',
              apiAction: 'TestOperation',
              homepage: 'https://example.com',
              regionalAvailability: { 'us-east-1': 'Available' },
            },
          ],
        },
      ]);
      const chunk2 = JSON.stringify([
        {
          sdkServiceName: 'test-service',
          sdkServiceFullName: 'Test Service',
          productID: 'product-1',
          productName: 'Test Service',
          apis: [
            {
              apiName: 'TestOperation',
              apiAction: 'TestOperation',
              homepage: 'https://example.com',
              regionalAvailability: { 'eu-west-1': 'Available', 'ap-southeast-1': 'Available' },
            },
          ],
        },
      ]);

      const result = JSON.parse(
        mergeJson([chunk1, chunk2], a => a.sdkServiceName, [{ key: 'apis', getId: op => op.apiName }]),
      );

      expect(result).toHaveLength(1);
      expect(result[0].apis).toHaveLength(1);
      expect(result[0].apis[0].regionalAvailability).toEqual({
        'us-east-1': 'Available',
        'eu-west-1': 'Available',
        'ap-southeast-1': 'Available',
      });
    });
  });

  describe('cfn_resources', () => {
    it('merges all 4 levels with different regions at each level', () => {
      const chunk1 = JSON.stringify([
        {
          serviceName: 'Test Service',
          resourceTypes: [
            {
              resourceTypeName: 'AWS::Test::Resource',
              resourceTypeHomepage: 'https://example.com/docs',
              regionalAvailability: { 'us-east-1': 'Available' },
              resourceProperties: [
                {
                  resourcePropertyName: 'TestProperty',
                  resourceConfigurations: [
                    { resourceConfigurationName: 'config-v1', regionalAvailability: { 'us-east-1': 'Available' } },
                  ],
                },
              ],
            },
          ],
        },
      ]);
      const chunk2 = JSON.stringify([
        {
          serviceName: 'Test Service',
          resourceTypes: [
            {
              resourceTypeName: 'AWS::Test::Resource',
              resourceTypeHomepage: 'https://example.com/docs',
              regionalAvailability: { 'eu-west-1': 'Available', 'ap-northeast-1': 'Unavailable' },
              resourceProperties: [
                {
                  resourcePropertyName: 'TestProperty',
                  resourceConfigurations: [
                    { resourceConfigurationName: 'config-v1', regionalAvailability: { 'eu-west-1': 'Available' } },
                    {
                      resourceConfigurationName: 'config-v2',
                      regionalAvailability: { 'eu-west-1': 'Available', 'ap-northeast-1': 'Available' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]);

      const result = JSON.parse(
        mergeJson([chunk1, chunk2], r => r.serviceName, [
          { key: 'resourceTypes', getId: rt => rt.resourceTypeName },
          { key: 'resourceProperties', getId: rp => rp.resourcePropertyName },
          { key: 'resourceConfigurations', getId: rc => rc.resourceConfigurationName },
        ]),
      );

      // One service
      expect(result).toHaveLength(1);

      // One resource type with merged regions
      const rt = result[0].resourceTypes[0];
      expect(rt.regionalAvailability).toEqual({
        'us-east-1': 'Available',
        'eu-west-1': 'Available',
        'ap-northeast-1': 'Unavailable',
      });

      // One property
      const prop = rt.resourceProperties[0];
      expect(prop.resourcePropertyName).toBe('TestProperty');

      // Two configurations with merged regions
      const configs = prop.resourceConfigurations;
      expect(configs).toHaveLength(2);
      expect(configs.find(c => c.resourceConfigurationName === 'config-v1').regionalAvailability).toEqual({
        'us-east-1': 'Available',
        'eu-west-1': 'Available',
      });
      expect(configs.find(c => c.resourceConfigurationName === 'config-v2').regionalAvailability).toEqual({
        'eu-west-1': 'Available',
        'ap-northeast-1': 'Available',
      });
    });
  });
});
