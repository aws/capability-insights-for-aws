import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { FeatureFlags } from '@capability-insights/shared/types/feature-flags';
import { capabilityInsightsClient } from '~/clients/capability-insights-client';

/**
 * State of feature-flag fetching.
 *
 * - `loading`: initial fetch in flight; UI should show a neutral placeholder
 *   (skeleton or hidden control).
 * - `ready`: flags fetched at least once; UI can render the right state.
 * - `error`: API unreachable; UI should fall back to "feature unavailable"
 *   to avoid showing controls that won't work.
 */
type FeatureFlagsState =
  { status: 'loading'; flags: null } | { status: 'ready'; flags: FeatureFlags } | { status: 'error'; flags: null };

interface FeatureFlagsContextValue {
  state: FeatureFlagsState;
  /** Force a re-fetch (e.g. after a deploy or analysis trigger). */
  refresh: () => Promise<void>;
}

const FeatureFlagsContext = createContext<FeatureFlagsContextValue | null>(null);

/**
 * Hook returning the current feature-flag state and a refresh callback.
 *
 * Components can call this anywhere under {@link FeatureFlagsProvider}.
 * Throws when used outside the provider so misuse is caught loudly during
 * development rather than producing silent UI bugs.
 */
export function useFeatureFlags(): FeatureFlagsContextValue {
  const ctx = useContext(FeatureFlagsContext);
  if (!ctx) {
    throw new Error('useFeatureFlags must be used inside <FeatureFlagsProvider>');
  }
  return ctx;
}

/**
 * Convenience hook that returns just the resolved flags or null while
 * loading/errored. Useful for components that don't care about the loading
 * distinction (e.g. sidebar nav can render the same way for "loading" and
 * "feature disabled" — disabled with a tooltip).
 */
export function useFeatureFlagsResolved(): FeatureFlags | null {
  const { state } = useFeatureFlags();
  return state.status === 'ready' ? state.flags : null;
}

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FeatureFlagsState>({ status: 'loading', flags: null });

  const fetchFlags = useCallback(async () => {
    const flags = await capabilityInsightsClient.getFeatureFlags();
    if (flags) {
      setState({ status: 'ready', flags });
    } else {
      setState({ status: 'error', flags: null });
    }
  }, []);

  useEffect(() => {
    void fetchFlags();
  }, [fetchFlags]);

  const value = useMemo<FeatureFlagsContextValue>(() => ({ state, refresh: fetchFlags }), [state, fetchFlags]);

  return <FeatureFlagsContext.Provider value={value}>{children}</FeatureFlagsContext.Provider>;
}
