/** Filter modes for the usage capabilities endpoint. */
export const UsageFilter = {
  DEPLOYED: 'deployed',
  ACTIVE_USAGE: 'active_usage',
  COMBINED: 'combined',
} as const;

export type UsageFilter = (typeof UsageFilter)[keyof typeof UsageFilter];

export const VALID_USAGE_FILTERS: UsageFilter[] = [
  UsageFilter.DEPLOYED,
  UsageFilter.ACTIVE_USAGE,
  UsageFilter.COMBINED,
];
