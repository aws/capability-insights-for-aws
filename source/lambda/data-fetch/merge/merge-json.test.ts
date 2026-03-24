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
          regionalAvailability: { isAvailableIn: ['us-east-1', 'us-west-2'] },
          childProducts: [
            {
              productId: 'feature-1',
              productName: 'Test Feature',
              productType: 'FEATURE',
              regionalAvailability: { isAvailableIn: ['us-east-1'] },
            },
          ],
        },
      ]);
      const chunk2 = JSON.stringify([
        {
          productId: 'product-1',
          productName: 'Test Service',
          productType: 'SERVICE',
          regionalAvailability: { isAvailableIn: ['eu-west-1', 'ap-northeast-1'] },
          childProducts: [
            {
              productId: 'feature-1',
              productName: 'Test Feature',
              productType: 'FEATURE',
              regionalAvailability: { isAvailableIn: ['eu-west-1'] },
            },
          ],
        },
      ]);

      const result = JSON.parse(
        mergeJson([chunk1, chunk2], p => p.productId, [{ key: 'childProducts', getId: c => c.productId }]),
      );

      expect(result).toHaveLength(1);
      expect(result[0].regionalAvailability.isAvailableIn).toEqual([
        'us-east-1',
        'us-west-2',
        'eu-west-1',
        'ap-northeast-1',
      ]);
      expect(result[0].childProducts).toHaveLength(1);
      expect(result[0].childProducts[0].regionalAvailability.isAvailableIn).toEqual(['us-east-1', 'eu-west-1']);
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
              availableInRegions: ['us-east-1'],
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
              availableInRegions: ['eu-west-1', 'ap-southeast-1'],
            },
          ],
        },
      ]);

      const result = JSON.parse(
        mergeJson([chunk1, chunk2], a => a.sdkServiceName, [{ key: 'apis', getId: op => op.apiName }]),
      );

      expect(result).toHaveLength(1);
      expect(result[0].apis).toHaveLength(1);
      expect(result[0].apis[0].availableInRegions).toEqual(['us-east-1', 'eu-west-1', 'ap-southeast-1']);
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
              availableInRegions: ['us-east-1'],
              notAvailableInRegions: [],
              resourceProperties: [
                {
                  resourcePropertyName: 'TestProperty',
                  resourceConfigurations: [
                    { resourceConfigurationName: 'config-v1', availableInRegions: ['us-east-1'] },
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
              availableInRegions: ['eu-west-1', 'ap-northeast-1'],
              notAvailableInRegions: [],
              resourceProperties: [
                {
                  resourcePropertyName: 'TestProperty',
                  resourceConfigurations: [
                    { resourceConfigurationName: 'config-v1', availableInRegions: ['eu-west-1'] },
                    { resourceConfigurationName: 'config-v2', availableInRegions: ['eu-west-1', 'ap-northeast-1'] },
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
      expect(rt.availableInRegions).toEqual(['us-east-1', 'eu-west-1', 'ap-northeast-1']);

      // One property
      const prop = rt.resourceProperties[0];
      expect(prop.resourcePropertyName).toBe('TestProperty');

      // Two configurations with merged regions
      const configs = prop.resourceConfigurations;
      expect(configs).toHaveLength(2);
      expect(configs.find(c => c.resourceConfigurationName === 'config-v1').availableInRegions).toEqual([
        'us-east-1',
        'eu-west-1',
      ]);
      expect(configs.find(c => c.resourceConfigurationName === 'config-v2').availableInRegions).toEqual([
        'eu-west-1',
        'ap-northeast-1',
      ]);
    });
  });
});
