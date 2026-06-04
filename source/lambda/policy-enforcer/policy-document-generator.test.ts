import { describe, it, expect } from 'vitest';
import { generatePolicyDocument } from './policy-document-generator';
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

const TS = '2026-06-03T15:00:00Z';

const buildService = (sdkServiceName: string, apis: { name: string; available: boolean }[]): ApiService => ({
  sdkServiceName,
  sdkServiceFullName: sdkServiceName,
  apis: apis.map(a => ({
    apiName: a.name,
    apiAction: a.name,
    homepage: '',
    regionalAvailability: a.available
      ? {
          'us-east-1': AvailabilityStatus.AVAILABLE,
          'eu-west-1': AvailabilityStatus.AVAILABLE,
        }
      : {
          'us-east-1': AvailabilityStatus.AVAILABLE,
          // missing eu-west-1 → not available under intersection
        },
  })),
});

describe('generatePolicyDocument — IAM', () => {
  it('produces a single document with valid structure for a small allow-list', () => {
    const result = generatePolicyDocument({
      catalogData: [buildService('s3', [{ name: 'GetObject', available: true }])],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].Version).toBe('2012-10-17');
    expect(result.documents[0].Statement[0].Effect).toBe('Deny');
    expect(result.documents[0].Statement[0].Resource).toBe('*');
    expect(result.documents[0].Statement[0].NotAction).toEqual(['s3:*']);
    expect(result.documents[0].Statement[0].Sid).toMatch(/^PolicyEnforcerBlanketDeny/);
    expect(result.error).toBeUndefined();
  });

  it('includes generation timestamp in Sid (sanitized)', () => {
    const result = generatePolicyDocument({
      catalogData: [buildService('s3', [{ name: 'GetObject', available: true }])],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    const sid = result.documents[0].Statement[0].Sid;
    // Timestamp embedded with non-alphanumeric chars stripped.
    expect(sid).toContain('20260603T150000Z');
  });

  it('uses Strategy A (service:* + Action deny) for partially-available services with many available APIs', () => {
    // Service has 1 unavailable API and many available — Strategy A is shorter.
    const apis = Array.from({ length: 20 }, (_, i) => ({
      name: `Action${i}`,
      available: true,
    }));
    apis.push({ name: 'UnavailableAction', available: false });

    const result = generatePolicyDocument({
      catalogData: [buildService('s3', apis)],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    // Blanket: s3:*; Tier 2: s3:UnavailableAction
    const blanket = result.documents[0].Statement[0];
    expect(blanket.NotAction).toEqual(['s3:*']);

    expect(result.documents).toHaveLength(2);
    const tier2 = result.documents[1].Statement[0];
    expect(tier2.Action).toEqual(['s3:UnavailableAction']);
  });

  it('uses Strategy B (list available actions) when most APIs are unavailable', () => {
    // 2 available, 20 unavailable — Strategy B is shorter.
    const apis = [
      { name: 'AvailA', available: true },
      { name: 'AvailB', available: true },
      ...Array.from({ length: 20 }, (_, i) => ({ name: `UnavailX${i}`, available: false })),
    ];

    const result = generatePolicyDocument({
      catalogData: [buildService('s3', apis)],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    // Strategy B: list the two available actions in NotAction; no Tier 2 needed.
    expect(result.documents).toHaveLength(1);
    const blanket = result.documents[0].Statement[0];
    expect(blanket.NotAction).toEqual(['s3:AvailA', 's3:AvailB']);
  });

  it('omits fully-unavailable services from NotAction (covered by blanket deny)', () => {
    const apis = [{ name: 'OnlyAction', available: false }];
    const result = generatePolicyDocument({
      catalogData: [
        buildService('s3', [{ name: 'GetObject', available: true }]),
        buildService('unavailableservice', apis),
      ],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(result.documents[0].Statement[0].NotAction).toEqual(['s3:*']);
    expect(result.blanketDenyServiceCount).toBe(1);
    expect(result.fullyAvailableServiceCount).toBe(1);
  });

  it('counts fully, partially, and fully-unavailable services into separate counters', () => {
    const result = generatePolicyDocument({
      catalogData: [
        // Fully available
        buildService('s3', [{ name: 'GetObject', available: true }]),
        // Partially available (1 of 2)
        buildService('ec2', [
          { name: 'DescribeInstances', available: true },
          { name: 'RunInstances', available: false },
        ]),
        // Fully unavailable
        buildService('unavailable', [{ name: 'OnlyAction', available: false }]),
      ],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(result.fullyAvailableServiceCount).toBe(1);
    expect(result.partiallyAvailableServiceCount).toBe(1);
    expect(result.blanketDenyServiceCount).toBe(1);
  });

  it('returns documents whose total size is the sum of individual sizes', () => {
    const result = generatePolicyDocument({
      catalogData: [buildService('s3', [{ name: 'GetObject', available: true }])],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    const expectedTotal = result.documents.reduce((sum, d) => sum + JSON.stringify(d).length, 0);
    expect(result.totalSize).toBe(expectedTotal);
  });

  it('marks splitRequired=true when documents > 1', () => {
    // Force a split by creating a huge fully-available catalog.
    const services: ApiService[] = [];
    for (let i = 0; i < 1500; i++) {
      services.push(buildService(`service${i}`, [{ name: 'Action', available: true }]));
    }
    const result = generatePolicyDocument({
      catalogData: services,
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(result.splitRequired).toBe(true);
    expect(result.documents.length).toBeGreaterThan(1);
    for (const doc of result.documents) {
      expect(JSON.stringify(doc).length).toBeLessThanOrEqual(6144);
    }
  });
});

describe('generatePolicyDocument — SCP', () => {
  it('produces a single document for SCP type', () => {
    const result = generatePolicyDocument({
      catalogData: [buildService('s3', [{ name: 'GetObject', available: true }])],
      configuration: config({ policyType: 'SCP' }),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(result.documents).toHaveLength(1);
    expect(result.error).toBeUndefined();
  });

  it('returns an error when SCP would exceed 5,120 chars', () => {
    const services: ApiService[] = [];
    for (let i = 0; i < 1500; i++) {
      services.push(buildService(`service${i}`, [{ name: 'Action', available: true }]));
    }
    const result = generatePolicyDocument({
      catalogData: services,
      configuration: config({ policyType: 'SCP' }),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/5,120/);
    expect(result.totalSize).toBeGreaterThan(5120);
  });

  it('combines blanket and specific deny in a single SCP document', () => {
    const apis = Array.from({ length: 20 }, (_, i) => ({
      name: `Avail${i}`,
      available: true,
    }));
    apis.push({ name: 'Bad', available: false });

    const result = generatePolicyDocument({
      catalogData: [buildService('s3', apis)],
      configuration: config({ policyType: 'SCP' }),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].Statement).toHaveLength(2);
    expect(result.documents[0].Statement[0].NotAction).toEqual(['s3:*']);
    expect(result.documents[0].Statement[1].Action).toEqual(['s3:Bad']);
  });
});

describe('generatePolicyDocument — exceptions', () => {
  it('treats exception actions as available (their service moves out of blanket-deny)', () => {
    const services = [
      buildService('s3', [{ name: 'GetObject', available: true }]),
      // unavailable service that would normally be blanket-denied
      buildService('thingthatdoesntexist', [{ name: 'DoSomething', available: false }]),
    ];

    const result = generatePolicyDocument({
      catalogData: services,
      configuration: config({
        exceptions: [{ action: 'thingthatdoesntexist:DoSomething', addedAt: '2026-01-01T00:00:00Z' }],
      }),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    // The exception's service is now fully available (only API was the excepted one),
    // so it shows up as `service:*` in the blanket NotAction.
    expect(result.documents[0].Statement[0].NotAction).toContain('thingthatdoesntexist:*');
  });
});
