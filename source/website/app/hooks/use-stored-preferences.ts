import { useEffect, useState } from 'react';
import type { CollectionPreferencesProps } from '@cloudscape-design/components/collection-preferences';

/**
 * Default table preferences used before a user has customized anything. No
 * `contentDisplay` is set, so Cloudscape shows every column (all Regions) on a
 * first visit — matching the prior behavior.
 */
export const DEFAULT_TABLE_PREFERENCES: CollectionPreferencesProps.Preferences = {
  stickyColumns: { first: 1, last: 0 },
};

function loadPreferences(storageKey: string): CollectionPreferencesProps.Preferences {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return DEFAULT_TABLE_PREFERENCES;
    // Merge over the defaults so newly added default keys still apply to a
    // preference object that was persisted by an older build.
    return { ...DEFAULT_TABLE_PREFERENCES, ...(JSON.parse(stored) as CollectionPreferencesProps.Preferences) };
  } catch {
    return DEFAULT_TABLE_PREFERENCES;
  }
}

/**
 * Persists a table's CollectionPreferences (column visibility/order, sticky
 * columns, page size) to localStorage, keyed per table.
 *
 * On a first visit the table uses {@link DEFAULT_TABLE_PREFERENCES} (all
 * columns shown). Once a user adjusts "Column preferences" in the UI, the
 * selection is restored on every subsequent load — including after a browser
 * restart — so they only have to set it up once. Scope is per-browser,
 * per-profile (localStorage); it does not sync across browsers or devices.
 */
export function useStoredPreferences(key: string) {
  const storageKey = `${key}TablePreferences`;

  const [preferences, setPreferences] = useState<CollectionPreferencesProps.Preferences>(() =>
    loadPreferences(storageKey),
  );

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(preferences));
    } catch {
      // Ignore storage failures (quota exceeded, disabled storage) — the table
      // still works, it just won't persist the selection this session.
    }
  }, [preferences, storageKey]);

  return { preferences, setPreferences };
}
