import type { RegionalAvailability } from '@capability-insights/shared/types/availability/regional-availability';

/**
 * Parse a planned launch-date string ("YYYY Qn", e.g. "2026 Q4") into a
 * sortable integer (year*10 + quarter). Returns null for unparseable values.
 */
export function launchDateRank(date: string): number | null {
  const m = /^(\d{4})\s*Q([1-4])$/.exec(date.trim());
  if (m) return Number(m[1]) * 10 + Number(m[2]);
  const y = /^(\d{4})$/.exec(date.trim());
  if (y) return Number(y[1]) * 10 + 1;
  return null;
}

/**
 * Format a rank back into a human-readable quarter label.
 */
function rankToLabel(rank: number): string {
  const year = Math.floor(rank / 10);
  const quarter = rank % 10;
  return `${year} Q${quarter}`;
}

export interface TimeframeOption {
  value: string;
  label: string;
  rank: number;
}

/**
 * Derive unique quarter values from planned (not yet launched) regionDates and
 * return them as sorted filter options ("YYYY Qn"). Only includes
 * quarters where the region status is still 'Planned'.
 */
export function deriveTimeframeOptions(items: RegionalAvailability[]): TimeframeOption[] {
  const ranks = new Set<number>();
  for (const item of items) {
    if (!item.regionDates || !item.regionalAvailability) continue;
    for (const [region, date] of Object.entries(item.regionDates)) {
      if (item.regionalAvailability[region] !== 'Planned') continue;
      const rank = launchDateRank(date);
      if (rank !== null) ranks.add(rank);
    }
  }

  return Array.from(ranks)
    .sort((a, b) => a - b)
    .map(rank => ({
      value: rankToLabel(rank),
      label: rankToLabel(rank),
      rank,
    }));
}

/**
 * Check whether a row has a planned launch date in one of the target quarters.
 * Only considers regions whose availability status is still 'Planned'.
 * When regionCodes is provided, only those regions are checked.
 */
export function matchesTimeframe(
  item: RegionalAvailability,
  targetRanks: Set<number>,
  regionCodes?: Set<string>,
): boolean {
  if (!item.regionDates || !item.regionalAvailability) return false;
  for (const [region, date] of Object.entries(item.regionDates)) {
    if (regionCodes && !regionCodes.has(region)) continue;
    if (item.regionalAvailability[region] !== 'Planned') continue;
    const rank = launchDateRank(date);
    if (rank !== null && targetRanks.has(rank)) return true;
  }
  return false;
}
