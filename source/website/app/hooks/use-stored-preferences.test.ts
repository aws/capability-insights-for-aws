import { describe, expect, it, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { CollectionPreferencesProps } from '@cloudscape-design/components/collection-preferences';
import { useStoredPreferences, DEFAULT_TABLE_PREFERENCES } from './use-stored-preferences';

const KEY = 'MyTable';
const STORAGE_KEY = `${KEY}TablePreferences`;

describe('useStoredPreferences', () => {
  beforeEach(() => localStorage.clear());

  it('returns the default preferences when nothing is stored', () => {
    const { result } = renderHook(() => useStoredPreferences(KEY));
    expect(result.current.preferences).toEqual(DEFAULT_TABLE_PREFERENCES);
  });

  it('persists preferences to localStorage under a per-table key on change', () => {
    const { result } = renderHook(() => useStoredPreferences(KEY));
    const next: CollectionPreferencesProps.Preferences = {
      stickyColumns: { first: 1, last: 0 },
      contentDisplay: [
        { id: 'name', visible: true },
        { id: 'us-east-1', visible: false },
      ],
    };

    act(() => result.current.setPreferences(next));

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(next);
  });

  it('restores stored preferences on mount', () => {
    const stored: CollectionPreferencesProps.Preferences = {
      stickyColumns: { first: 1, last: 0 },
      contentDisplay: [{ id: 'us-east-1', visible: false }],
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

    const { result } = renderHook(() => useStoredPreferences(KEY));

    expect(result.current.preferences).toEqual(stored);
  });

  it('merges stored preferences over the defaults', () => {
    // A preference object persisted by an older build (no stickyColumns) should
    // still pick up the default stickyColumns.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ pageSize: 50 }));

    const { result } = renderHook(() => useStoredPreferences(KEY));

    expect(result.current.preferences).toEqual({ ...DEFAULT_TABLE_PREFERENCES, pageSize: 50 });
  });

  it('falls back to the defaults when stored JSON is malformed', () => {
    localStorage.setItem(STORAGE_KEY, '{not-valid-json');

    const { result } = renderHook(() => useStoredPreferences(KEY));

    expect(result.current.preferences).toEqual(DEFAULT_TABLE_PREFERENCES);
  });

  it('keeps preferences isolated per table key', () => {
    const a = renderHook(() => useStoredPreferences('TableA'));
    renderHook(() => useStoredPreferences('TableB'));

    act(() => a.result.current.setPreferences({ pageSize: 10 }));

    expect(JSON.parse(localStorage.getItem('TableATablePreferences') ?? 'null')).toMatchObject({ pageSize: 10 });
    // TableB only ever held its default — never TableA's pageSize.
    expect(localStorage.getItem('TableBTablePreferences') ?? '').not.toContain('"pageSize":10');
  });
});
