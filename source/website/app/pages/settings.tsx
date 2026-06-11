import { useEffect, useRef, useState } from 'react';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Container from '@cloudscape-design/components/container';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Button from '@cloudscape-design/components/button';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Popover from '@cloudscape-design/components/popover';
import { PAGE_SETTINGS } from '~/constants/app';
import {
  AnalysisNotEnabledError,
  PolicyEnforcerNotEnabledError,
  capabilityInsightsClient,
} from '~/clients/capability-insights-client';
import { formatTimestamp } from '~/utils/time-utils';
import { useFeatureFlags } from '~/hooks/use-feature-flags';
import type { SyncMetadata } from '@capability-insights/shared/types/sync-metadata';
import { ExecutionStatus } from '@capability-insights/shared/types/analysis';

import type { RouteHandle } from '~/types/route';

export const handle: RouteHandle = { pageName: PAGE_SETTINGS };

export function meta() {
  return [{ title: PAGE_SETTINGS }];
}

/**
 * How often the Settings page polls `GET /analysis` while an analysis run
 * is in progress.
 */
const POLL_INTERVAL_MS = 5000;

type AnalysisStatus = 'idle' | 'running' | 'success' | 'error' | 'not-enabled';

export default function Settings() {
  const { refresh: refreshFeatureFlags } = useFeatureFlags();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [syncMetadata, setSyncMetadata] = useState<SyncMetadata | null>(null);

  // Usage analysis state
  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>('idle');
  const [analysisError, setAnalysisError] = useState<string>('');
  const [analysisResult, setAnalysisResult] = useState<Record<string, unknown> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [policyRefreshStatus, setPolicyRefreshStatus] = useState<
    'idle' | 'loading' | 'success' | 'error' | 'not-enabled'
  >('idle');
  const [policyRefreshMessage, setPolicyRefreshMessage] = useState<string>('');
  const [policyRefreshError, setPolicyRefreshError] = useState<string>('');

  useEffect(() => {
    capabilityInsightsClient.getLastSyncTime().then(setSyncMetadata);
  }, []);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const handleSync = async () => {
    setLoading(true);
    setStatus('idle');
    try {
      await capabilityInsightsClient.syncCapabilityData();
      setStatus('success');
    } catch (e) {
      setStatus('error');
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const pollAnalysis = (executionArn: string) => {
    const tick = async () => {
      try {
        const result = await capabilityInsightsClient.getAnalysisStatus(executionArn);
        if ('status' in result && result.status === ExecutionStatus.RUNNING) {
          pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
          return;
        }
        if ('status' in result && result.status === ExecutionStatus.FAILED) {
          setAnalysisStatus('error');
          setAnalysisError(typeof result.error === 'string' ? result.error : 'Analysis failed');
          // Surface the failed run's timestamp/status on the dashboard's
          // "Last sync" popover without requiring a manual reload.
          void refreshFeatureFlags();
          return;
        }
        setAnalysisResult(result as Record<string, unknown>);
        setAnalysisStatus('success');
        // Refresh feature flags so the dashboard's "Last sync → Usage
        // analysis" row reflects this run's new execution time immediately.
        void refreshFeatureFlags();
      } catch (e) {
        setAnalysisStatus('error');
        setAnalysisError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
  };

  const handleAnalyze = async () => {
    setAnalysisStatus('running');
    setAnalysisError('');
    setAnalysisResult(null);
    try {
      const executionArn = await capabilityInsightsClient.triggerAnalysis();
      pollAnalysis(executionArn);
    } catch (e) {
      if (e instanceof AnalysisNotEnabledError) {
        setAnalysisStatus('not-enabled');
        setAnalysisError(e.message);
        return;
      }
      setAnalysisStatus('error');
      setAnalysisError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRefreshAllPolicies = async () => {
    setPolicyRefreshStatus('loading');
    setPolicyRefreshMessage('');
    setPolicyRefreshError('');
    try {
      const result = await capabilityInsightsClient.refreshAllPolicies();
      setPolicyRefreshStatus('success');
      setPolicyRefreshMessage(result.message);
    } catch (e) {
      if (e instanceof PolicyEnforcerNotEnabledError) {
        setPolicyRefreshStatus('not-enabled');
        setPolicyRefreshError(e.message);
        return;
      }
      setPolicyRefreshStatus('error');
      setPolicyRefreshError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ContentLayout header={<Header variant="h1">{PAGE_SETTINGS}</Header>}>
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Data synchronization</Header>}>
          <SpaceBetween size="m">
            <Alert type="info">Data is automatically refreshed every 24 hours.</Alert>
            {syncMetadata?.errors?.length ? (
              <Popover
                dismissButton={false}
                position="bottom"
                size="large"
                content={
                  <SpaceBetween size="xs">
                    {syncMetadata.errors.map((err, i) => (
                      <StatusIndicator key={i} type="error">
                        {err}
                      </StatusIndicator>
                    ))}
                  </SpaceBetween>
                }
              >
                <StatusIndicator type="error">
                  Sync completed with {syncMetadata.errors.length} error(s)
                </StatusIndicator>
              </Popover>
            ) : syncMetadata?.lastSyncTime ? (
              <StatusIndicator type="success">
                Last synced: {formatTimestamp(syncMetadata.lastSyncTime)}
              </StatusIndicator>
            ) : (
              <StatusIndicator type="pending">No sync has completed yet</StatusIndicator>
            )}
            <Box variant="small" color="text-body-secondary">
              If data appears outdated, use the button below to sync manually. This runs in the background and may take
              a few minutes. Refresh the page to see the update.
            </Box>
            <Button onClick={handleSync} loading={loading}>
              Sync capability data
            </Button>
            {status === 'success' && (
              <Alert type="success">
                Data sync has been triggered. It may take a few minutes for updated data to appear.
              </Alert>
            )}
            {status === 'error' && (
              <Alert type="error">
                <SpaceBetween size="xs">
                  <Box>Failed to trigger data sync.</Box>
                  <Box variant="small" color="text-body-secondary">
                    {errorMessage}
                  </Box>
                </SpaceBetween>
              </Alert>
            )}
          </SpaceBetween>
        </Container>

        <Container header={<Header variant="h2">Usage analysis</Header>}>
          <SpaceBetween size="m">
            <Alert type="info">
              Analyzes CloudTrail and CloudFormation in this account to personalize the dashboard with what you actually
              use.
            </Alert>
            <Box variant="small" color="text-body-secondary">
              Triggers a new analysis run. Takes a few minutes. The CloudTrail bucket configured at deploy time is used.
              Refresh the page to see updated personalization.
            </Box>
            <Button
              onClick={handleAnalyze}
              loading={analysisStatus === 'running'}
              disabled={analysisStatus === 'running'}
            >
              Run usage analysis
            </Button>
            {analysisStatus === 'running' && (
              <StatusIndicator type="loading">
                Analysis in progress — this can take 1-5 minutes for the first run
              </StatusIndicator>
            )}
            {analysisStatus === 'success' && analysisResult && (
              <Alert type="success">
                <SpaceBetween size="xs">
                  <Box>Analysis complete.</Box>
                  {typeof analysisResult.deployed === 'number' && (
                    <Box variant="small" color="text-body-secondary">
                      deployed: {String(analysisResult.deployed)} · active_usage: {String(analysisResult.active_usage)}{' '}
                      · combined: {String(analysisResult.combined)}
                    </Box>
                  )}
                </SpaceBetween>
              </Alert>
            )}
            {analysisStatus === 'not-enabled' && (
              <Alert type="info" header="Usage Analysis is not enabled">
                <SpaceBetween size="xs">
                  <Box>
                    The optional Usage Analysis stack is not deployed. To enable personalization, re-run deploy with{' '}
                    <code>--enable-usage-analysis</code>.
                  </Box>
                  {analysisError && (
                    <Box variant="small" color="text-body-secondary">
                      {analysisError}
                    </Box>
                  )}
                </SpaceBetween>
              </Alert>
            )}
            {analysisStatus === 'error' && (
              <Alert type="error">
                <SpaceBetween size="xs">
                  <Box>Failed to run usage analysis.</Box>
                  <Box variant="small" color="text-body-secondary">
                    {analysisError}
                  </Box>
                </SpaceBetween>
              </Alert>
            )}
          </SpaceBetween>
        </Container>

        <Container header={<Header variant="h2">Policy Enforcer</Header>}>
          <SpaceBetween size="m">
            <Alert type="info">
              Policies refresh automatically once a week. Use the button below to refresh every policy now against the
              latest catalog data.
            </Alert>
            <Box variant="small" color="text-body-secondary">
              Runs in the background and may take a few minutes depending on how many policies you have. Each policy's
              status updates as it completes.
            </Box>
            <Button
              onClick={handleRefreshAllPolicies}
              loading={policyRefreshStatus === 'loading'}
              disabled={policyRefreshStatus === 'loading'}
            >
              Refresh all policies
            </Button>
            {policyRefreshStatus === 'success' && <Alert type="success">{policyRefreshMessage}</Alert>}
            {policyRefreshStatus === 'not-enabled' && (
              <Alert type="info" header="Policy Enforcer is not enabled">
                <SpaceBetween size="xs">
                  <Box>
                    The optional Policy Enforcer stack is not deployed. To enable it, re-run deploy with{' '}
                    <Box variant="code" display="inline">
                      --enable-policy-enforcer
                    </Box>
                    .
                  </Box>
                  {policyRefreshError && (
                    <Box variant="small" color="text-body-secondary">
                      {policyRefreshError}
                    </Box>
                  )}
                </SpaceBetween>
              </Alert>
            )}
            {policyRefreshStatus === 'error' && (
              <Alert type="error">
                <SpaceBetween size="xs">
                  <Box>Failed to refresh policies.</Box>
                  <Box variant="small" color="text-body-secondary">
                    {policyRefreshError}
                  </Box>
                </SpaceBetween>
              </Alert>
            )}
          </SpaceBetween>
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}
