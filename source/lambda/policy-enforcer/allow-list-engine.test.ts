import { describe, it, expect } from 'vitest';
import { computeAllowList } from './allow-list-engine';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type { PolicyConfiguration } from '@capability-insights/shared/types/policy-enforcer/policy-configuration';

const config = (overrides: Partial<PolicyConfiguration> = {}): PolicyConfiguration => ({
  policyName: 'Test',
  tags: [],
  regions: ['us-east-1', 'eu-west-1'],
  mode: 'intersection',
  policyType: 'IAM',
  exceptions: [],
  status: 'pending',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

const sampleCatalog: ApiService[] = [
  {
    sdkServiceName: 's3',
    sdkServiceFullName: 'Amazon Simple Storage Service',
    apis: [
      {
        apiName: 'GetObject',
        apiAction: 'GetObject',
        homepage: '',
        regionalAvailability: {
          'us-east-1': AvailabilityStatus.AVAILABLE,
          'eu-west-1': AvailabilityStatus.AVAILABLE,
          'ap-south-1': AvailabilityStatus.AVAILABLE,
        },
      },
      {
        apiName: 'CreateMultiRegionAccessPoint',
        apiAction: 'CreateMultiRegionAccessPoint',
        homepage: '',
        regionalAvailability: {
          'us-east-1': AvailabilityStatus.AVAILABLE,
          // intentionally missing eu-west-1 and ap-south-1 → "not available"
        },
      },
    ],
  },
  {
    sdkServiceName: 'CloudWatch',
    sdkServiceFullName: 'Amazon CloudWatch',
    apis: [
      {
        apiName: 'PutMetricData',
        apiAction: 'PutMetricData',
        homepage: 'https://awscli.amazonaws.com/v2/documentation/api/latest/reference/monitoring/put-metric-data.html',
        regionalAvailability: {
          'us-east-1': AvailabilityStatus.AVAILABLE,
          'eu-west-1': AvailabilityStatus.AVAILABLE,
        },
      },
    ],
  },
];

describe('computeAllowList', () => {
  describe('intersection mode', () => {
    it('includes only actions available in ALL selected regions', () => {
      const result = computeAllowList({
        catalogData: sampleCatalog,
        configuration: config({ mode: 'intersection', regions: ['us-east-1', 'eu-west-1'] }),
      });

      // s3:GetObject available in both, monitoring→cloudwatch:PutMetricData available in both
      // s3:CreateMultiRegionAccessPoint missing eu-west-1 data → excluded
      expect(result.actions).toEqual(['cloudwatch:PutMetricData', 's3:GetObject']);
      expect(result.excludedCount).toBe(1);
    });

    it('treats missing regional data as "not available"', () => {
      const result = computeAllowList({
        catalogData: sampleCatalog,
        configuration: config({
          mode: 'intersection',
          regions: ['us-east-1', 'ap-south-1'],
        }),
      });

      // Only s3:GetObject is Available in both us-east-1 and ap-south-1.
      // CreateMultiRegionAccessPoint missing in ap-south-1, monitoring missing in ap-south-1.
      expect(result.actions).toEqual(['s3:GetObject']);
    });
  });

  describe('union mode', () => {
    it('includes actions available in AT LEAST ONE selected region', () => {
      const result = computeAllowList({
        catalogData: sampleCatalog,
        configuration: config({ mode: 'union', regions: ['us-east-1', 'eu-west-1'] }),
      });

      expect(result.actions.sort()).toEqual([
        'cloudwatch:PutMetricData',
        's3:CreateMultiRegionAccessPoint',
        's3:GetObject',
      ]);
      expect(result.excludedCount).toBe(0);
    });
  });

  describe('exceptions', () => {
    it('always includes exceptions regardless of availability', () => {
      const result = computeAllowList({
        catalogData: sampleCatalog,
        configuration: config({
          mode: 'intersection',
          regions: ['us-east-1', 'ap-south-1'],
          exceptions: [{ action: 'cloudwatch:PutMetricData', addedAt: '2026-01-01T00:00:00Z' }],
        }),
      });

      expect(result.actions).toContain('cloudwatch:PutMetricData');
      expect(result.exceptionCount).toBe(1);
    });

    it('does not double-count exceptions already in the allow-list', () => {
      const result = computeAllowList({
        catalogData: sampleCatalog,
        configuration: config({
          mode: 'union',
          regions: ['us-east-1'],
          exceptions: [{ action: 's3:GetObject', addedAt: '2026-01-01T00:00:00Z' }],
        }),
      });

      expect(result.actions.filter(a => a === 's3:GetObject')).toHaveLength(1);
      expect(result.exceptionCount).toBe(0); // already in the set
    });
  });

  describe('determinism and shape', () => {
    it('returns sorted output', () => {
      const result = computeAllowList({
        catalogData: sampleCatalog,
        configuration: config({ mode: 'union', regions: ['us-east-1'] }),
      });
      const sorted = [...result.actions].sort();
      expect(result.actions).toEqual(sorted);
    });

    it('produces identical output for identical inputs', () => {
      const a = computeAllowList({
        catalogData: sampleCatalog,
        configuration: config({ mode: 'intersection', regions: ['us-east-1', 'eu-west-1'] }),
      });
      const b = computeAllowList({
        catalogData: sampleCatalog,
        configuration: config({ mode: 'intersection', regions: ['us-east-1', 'eu-west-1'] }),
      });
      expect(a).toEqual(b);
    });

    it('intersection result is a subset of union result', () => {
      const inter = computeAllowList({
        catalogData: sampleCatalog,
        configuration: config({ mode: 'intersection', regions: ['us-east-1', 'eu-west-1'] }),
      });
      const union = computeAllowList({
        catalogData: sampleCatalog,
        configuration: config({ mode: 'union', regions: ['us-east-1', 'eu-west-1'] }),
      });
      const unionSet = new Set(union.actions);
      for (const a of inter.actions) {
        expect(unionSet.has(a)).toBe(true);
      }
    });
  });
});
