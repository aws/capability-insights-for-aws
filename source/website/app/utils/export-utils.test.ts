import { describe, expect, it } from 'vitest';
import {
  RegionalAvailabilityType,
  type RegionalAvailability,
} from '@capability-insights/shared/types/availability/regional-availability';
import type { Region } from '@capability-insights/shared/types/capability/region';
import { generateCsv, generateJson } from './export-utils';

const regions: Region[] = [
  {
    Region: 'us-east-1',
    RegionLongName: 'US East (N. Virginia)',
    Partition: 'aws',
    RegionStatus: 'available',
    RequireRegionOptIn: false,
  },
  {
    Region: 'eu-west-1',
    RegionLongName: 'Europe (Ireland)',
    Partition: 'aws',
    RegionStatus: 'available',
    RequireRegionOptIn: false,
  },
];

function makeItem(overrides: Partial<RegionalAvailability> = {}): RegionalAvailability {
  return {
    id: 'item-1',
    parentId: null,
    name: 'Amazon S3',
    regionalAvailabilityType: RegionalAvailabilityType.SERVICE,
    regionalAvailability: { 'us-east-1': 'Available' as never, 'eu-west-1': 'Available' as never },
    ...overrides,
  };
}

describe('generateCsv', () => {
  it('generates correct headers and data rows', () => {
    const items = [makeItem()];
    const csv = generateCsv(items, regions);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Name,Type,us-east-1,eu-west-1');
    expect(lines[1]).toBe('Amazon S3,Service,Available,Available');
  });

  it('handles empty items array', () => {
    const csv = generateCsv([], regions);
    expect(csv).toBe('Name,Type,us-east-1,eu-west-1');
  });

  it('escapes values containing commas', () => {
    const items = [makeItem({ name: 'Service, Inc.' })];
    const csv = generateCsv(items, regions);
    const lines = csv.split('\n');
    expect(lines[1]).toContain('"Service, Inc."');
  });

  it('escapes values containing double quotes', () => {
    const items = [makeItem({ name: 'Say "Hello"' })];
    const csv = generateCsv(items, regions);
    const lines = csv.split('\n');
    expect(lines[1]).toContain('"Say ""Hello"""');
  });

  it('escapes values containing newlines', () => {
    const items = [makeItem({ name: 'Line1\nLine2' })];
    const csv = generateCsv(items, regions);
    const dataRow = csv.split('\n').slice(1).join('\n');
    expect(dataRow).toContain('"Line1\nLine2"');
  });

  it('outputs empty string for missing region availability', () => {
    const items = [makeItem({ regionalAvailability: { 'us-east-1': 'Available' as never } })];
    const csv = generateCsv(items, regions);
    const lines = csv.split('\n');
    expect(lines[1]).toBe('Amazon S3,Service,Available,');
  });

  it('handles items with no regionalAvailability', () => {
    const items = [makeItem({ regionalAvailability: undefined })];
    const csv = generateCsv(items, regions);
    const lines = csv.split('\n');
    expect(lines[1]).toBe('Amazon S3,Service,,');
  });

  it('generates multiple rows preserving order', () => {
    const items = [
      makeItem({ id: '1', name: 'First' }),
      makeItem({ id: '2', name: 'Second' }),
      makeItem({ id: '3', name: 'Third' }),
    ];
    const csv = generateCsv(items, regions);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('First');
    expect(lines[2]).toContain('Second');
    expect(lines[3]).toContain('Third');
  });
});

describe('generateJson', () => {
  it('generates correct structure with region columns', () => {
    const items = [makeItem()];
    const json = JSON.parse(generateJson(items, regions));
    expect(json).toHaveLength(1);
    expect(json[0]).toEqual({
      name: 'Amazon S3',
      type: RegionalAvailabilityType.SERVICE,
      'us-east-1': 'Available',
      'eu-west-1': 'Available',
    });
  });

  it('handles empty items array', () => {
    const json = JSON.parse(generateJson([], regions));
    expect(json).toEqual([]);
  });

  it('uses null for missing region availability', () => {
    const items = [makeItem({ regionalAvailability: { 'us-east-1': 'Available' as never } })];
    const json = JSON.parse(generateJson(items, regions));
    expect(json[0]['eu-west-1']).toBeNull();
  });

  it('uses null for all regions when regionalAvailability is undefined', () => {
    const items = [makeItem({ regionalAvailability: undefined })];
    const json = JSON.parse(generateJson(items, regions));
    expect(json[0]['us-east-1']).toBeNull();
    expect(json[0]['eu-west-1']).toBeNull();
  });

  it('preserves item order', () => {
    const items = [makeItem({ id: '1', name: 'Alpha' }), makeItem({ id: '2', name: 'Beta' })];
    const json = JSON.parse(generateJson(items, regions));
    expect(json[0].name).toBe('Alpha');
    expect(json[1].name).toBe('Beta');
  });

  it('produces valid parseable JSON', () => {
    const items = [makeItem({ name: 'Special "chars" & <tags>' })];
    expect(() => JSON.parse(generateJson(items, regions))).not.toThrow();
  });
});
