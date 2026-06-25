import type { Scope } from '@capability-insights/shared/types/scope';
import type { UsageFilter } from '@capability-insights/shared/types/usage-filter';

/**
 * Canonical S3 keys (within the website bucket) for the data files the
 * pipeline reads and writes. Centralized so the decorator (writer) and the
 * API routes (readers) cannot drift apart on path strings.
 */

/** Master capability catalogs written by the data-fetch Lambda. */
export const CatalogKey = {
  REGIONS: 'data/json/regions.json',
  PRODUCTS: 'data/json/products.json',
  APIS: 'data/json/apis.json',
  CFN_RESOURCES: 'data/json/cfn_resources.json',
} as const;

/**
 * Key for a per-(scope, filter) "used capabilities" file produced by the
 * usage decorator, e.g. `data/json/used-capabilities-account-combined.json`.
 */
export function usedCapabilitiesKey(scope: Scope | 'account' | 'organization', filter: UsageFilter | string): string {
  return `data/json/used-capabilities-${scope}-${filter}.json`;
}

/**
 * The "combined account" file used as the probe for whether any personalized
 * data exists yet (see features-route `hasResults`).
 */
export const USED_CAPABILITIES_PROBE_KEY = usedCapabilitiesKey('account', 'combined');
