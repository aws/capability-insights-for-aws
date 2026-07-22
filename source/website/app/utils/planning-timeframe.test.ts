import { describe, expect, it } from 'vitest';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import {
  RegionalAvailabilityType,
  type RegionalAvailability,
} from '@capability-insights/shared/types/availability/regional-availability';
import { launchDateRank, deriveTimeframeOptions, matchesTimeframe } from './planning-timeframe';

function row(overrides: Partial<RegionalAvailability>): RegionalAvailability {
  return {
    id: 'r',
    name: 'Row',
    regionalAvailabilityType: RegionalAvailabilityType.SERVICE,
    parentId: null,
    regionDates: {},
    regionalAvailability: {},
    ...overrides,
  } as RegionalAvailability;
}

describe('launchDateRank', () => {
  it('parses "YYYY Qn" into a sortable rank', () => {
    expect(launchDateRank('2026 Q4')).toBe(20264);
    expect(launchDateRank('2027 Q1')).toBe(20271);
    expect(launchDateRank(' 2026 Q3 ')).toBe(20263);
  });

  it('treats a bare year as Q1', () => {
    expect(launchDateRank('2026')).toBe(20261);
  });

  it('returns null for unparseable values', () => {
    expect(launchDateRank('soon')).toBeNull();
    expect(launchDateRank('2026 Q5')).toBeNull();
    expect(launchDateRank('')).toBeNull();
  });
});

describe('deriveTimeframeOptions', () => {
  it('collects unique planned quarters, sorted, ignoring non-planned dates', () => {
    const items = [
      row({
        regionDates: { 'us-east-1': '2026 Q4', 'eu-west-1': '2026 Q2' },
        regionalAvailability: { 'us-east-1': AvailabilityStatus.PLANNED, 'eu-west-1': AvailabilityStatus.PLANNED },
      }),
      row({
        // Available (historical) date must be ignored even though it parses.
        regionDates: { 'us-east-1': '2025 Q1', 'ap-northeast-1': '2026 Q4' },
        regionalAvailability: {
          'us-east-1': AvailabilityStatus.AVAILABLE,
          'ap-northeast-1': AvailabilityStatus.PLANNED,
        },
      }),
    ];
    expect(deriveTimeframeOptions(items).map(o => o.value)).toEqual(['2026 Q2', '2026 Q4']);
  });

  it('returns nothing when there are no planned dates', () => {
    const items = [
      row({
        regionDates: { 'us-east-1': '2025 Q1' },
        regionalAvailability: { 'us-east-1': AvailabilityStatus.AVAILABLE },
      }),
    ];
    expect(deriveTimeframeOptions(items)).toEqual([]);
  });
});

describe('matchesTimeframe', () => {
  const planned = row({
    regionDates: { 'us-east-1': '2026 Q3', 'eu-west-2': '2026 Q4' },
    regionalAvailability: {
      'us-east-1': AvailabilityStatus.PLANNED,
      'eu-west-2': AvailabilityStatus.PLANNED,
    },
  });

  it('matches when any planned region falls in a target quarter', () => {
    expect(matchesTimeframe(planned, new Set([launchDateRank('2026 Q3')!]))).toBe(true);
    expect(matchesTimeframe(planned, new Set([launchDateRank('2027 Q1')!]))).toBe(false);
  });

  it('ignores dates whose region status is not Planned', () => {
    const available = row({
      regionDates: { 'us-east-1': '2026 Q3' },
      regionalAvailability: { 'us-east-1': AvailabilityStatus.AVAILABLE },
    });
    expect(matchesTimeframe(available, new Set([launchDateRank('2026 Q3')!]))).toBe(false);
  });

  it('scopes to the given regions when regionCodes is provided (AND semantics)', () => {
    // 2026 Q4 only exists in eu-west-2. Scoped to us-east-1 => no match.
    expect(matchesTimeframe(planned, new Set([launchDateRank('2026 Q4')!]), new Set(['us-east-1']))).toBe(false);
    expect(matchesTimeframe(planned, new Set([launchDateRank('2026 Q4')!]), new Set(['eu-west-2']))).toBe(true);
  });
});
