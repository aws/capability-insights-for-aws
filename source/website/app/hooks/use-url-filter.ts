import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { PropertyFilterProps } from '@cloudscape-design/components/property-filter';

/** Default empty query for clearing property filters. */
export const DEFAULT_EMPTY_QUERY: PropertyFilterProps.Query = {
  tokens: [],
  operation: 'and',
};

function getFilter(search: string, storageKey: string, filterPath: string): PropertyFilterProps.Query | undefined {
  try {
    const urlEncoded = new URLSearchParams(search).get(filterPath);
    const storedEncoded = localStorage.getItem(storageKey);

    const urlFilter = urlEncoded ? decodeURIComponent(escape(atob(urlEncoded))) : null;
    const storedFilter = storedEncoded ? decodeURIComponent(escape(atob(storedEncoded))) : null;

    const filterString = urlFilter || storedFilter;
    return filterString ? (JSON.parse(filterString) as PropertyFilterProps.Query) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persists PropertyFilter query state to a base64-encoded URL param and localStorage.
 * On mount reads from URL. On change writes back to both.
 */
export function useUrlFilter(key: string, urlPath = 'filter') {
  const { search } = useLocation();
  const navigate = useNavigate();

  const storageKey = `${key}TablePropertyFilter`;

  const [filter, setFilter] = useState<PropertyFilterProps.Query | undefined>(getFilter(search, storageKey, urlPath));

  useEffect(() => {
    if (filter === undefined) return;

    const queryParams = new URLSearchParams(search);
    const currentUrlFilter = queryParams.get(urlPath);

    const hasTokens = (filter.tokens?.length ?? 0) > 0;
    const hasTokenGroups = ((filter as { tokenGroups?: unknown[] }).tokenGroups?.length ?? 0) > 0;
    const isEmptyFilter = !hasTokens && !hasTokenGroups;

    if (isEmptyFilter) {
      if (currentUrlFilter !== null) {
        queryParams.delete(urlPath);
        localStorage.removeItem(storageKey);
        navigate({ search: queryParams.toString() }, { replace: true });
      } else {
        localStorage.removeItem(storageKey);
      }
    } else {
      const encodedFilter = btoa(unescape(encodeURIComponent(JSON.stringify(filter))));
      if (currentUrlFilter !== encodedFilter) {
        queryParams.set(urlPath, encodedFilter);
        localStorage.setItem(storageKey, encodedFilter);
        navigate({ search: queryParams.toString() }, { replace: true });
      }
    }
  }, [filter, navigate, search, urlPath, storageKey]);

  return { filter, setFilter };
}
