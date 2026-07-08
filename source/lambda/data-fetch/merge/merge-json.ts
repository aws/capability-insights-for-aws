/**
 * Configuration for merging a nested child array.
 */
export interface ChildMergeConfig {
  key: string;
  getId: (item: never) => string;
}

/**
 * Merges multiple JSON array chunks by deduplicating items using a provided
 * identity function. When two items share the same ID, their fields are deep
 * merged: scalars use last-write-wins, plain arrays are concatenated, nested
 * objects are recursively merged, and designated child arrays are deduplicated
 * by their own IDs recursively.
 *
 * @param chunks - Raw JSON strings, each containing an array of T
 * @param getId - Extracts the unique identifier from a top-level item
 * @param childConfigs - Optional array of child merge configs for nested deduplication
 * @returns The merged JSON array as a string
 */
export function mergeJson<T>(chunks: string[], getId: (item: T) => string, childConfigs?: ChildMergeConfig[]): string {
  const items = chunks.flatMap(c => JSON.parse(c) as T[]);
  return JSON.stringify(mergeArrayById(items, getId, childConfigs), null, 2);
}

/**
 * Deduplicates an array of items by ID, deep merging items that share the same ID.
 *
 * @param items - All items to deduplicate
 * @param getId - Extracts the unique identifier from an item
 * @param childConfigs - Optional array of child merge configs for nested deduplication
 * @returns Deduplicated array with merged items
 */
function mergeArrayById<T>(items: T[], getId: (item: T) => string, childConfigs?: ChildMergeConfig[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    const id = getId(item);
    const existing = map.get(id);
    map.set(id, existing ? deepMerge(existing, item, childConfigs) : item);
  }
  return [...map.values()];
}

/**
 * Deep merges two items field by field. Scalars are overwritten by incoming,
 * plain arrays are concatenated (or deduplicated if matching a childConfig),
 * nested objects are recursively merged.
 *
 * @param existing - The previously seen item
 * @param incoming - The new item to merge into existing
 * @param childConfigs - Optional array of child merge configs for nested deduplication
 * @returns A new merged item combining both inputs
 */
function deepMerge<T>(existing: T, incoming: T, childConfigs?: ChildMergeConfig[]): T {
  const mergedItem = { ...existing } as Record<string, unknown>;
  for (const [key, incomingValue] of Object.entries(incoming as Record<string, unknown>)) {
    const existingValue = mergedItem[key];

    if (Array.isArray(incomingValue) && Array.isArray(existingValue)) {
      const config = childConfigs?.find(c => c.key === key);
      if (config) {
        // Deduplicate this child array. Pass ALL configs down so self-recursive
        // structures (e.g. childProducts nested inside childProducts) keep
        // merging by id at every depth instead of concatenating duplicates.
        mergedItem[key] = mergeArrayById(
          [...existingValue, ...incomingValue],
          config.getId as (item: unknown) => string,
          childConfigs,
        );
      } else {
        // Plain array — just concatenate
        mergedItem[key] = [...existingValue, ...incomingValue];
      }
    } else if (isPlainObject(incomingValue) && isPlainObject(existingValue)) {
      mergedItem[key] = deepMerge(existingValue, incomingValue, childConfigs);
    } else {
      mergedItem[key] = incomingValue;
    }
  }
  return mergedItem as T;
}

/**
 * Returns true if the provided value is a plain object ({}). Arrays and null
 * are excluded despite being typeof "object" in JS.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
