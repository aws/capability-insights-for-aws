import { useEffect, useState } from 'react';
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
import { capabilityInsightsClient } from '~/clients/capability-insights-client';
import { formatTimestamp } from '~/utils/time-utils';
import type { SyncMetadata } from '@capability-insights/shared/types/sync-metadata';

import type { RouteHandle } from '~/types/route';

export const handle: RouteHandle = { pageName: PAGE_SETTINGS };

export function meta() {
  return [{ title: PAGE_SETTINGS }];
}

export default function Settings() {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [syncMetadata, setSyncMetadata] = useState<SyncMetadata | null>(null);

  useEffect(() => {
    capabilityInsightsClient.getLastSyncTime().then(setSyncMetadata);
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

  return (
    <ContentLayout header={<Header variant="h1">{PAGE_SETTINGS}</Header>}>
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
              <StatusIndicator type="error">Sync completed with {syncMetadata.errors.length} error(s)</StatusIndicator>
            </Popover>
          ) : syncMetadata?.lastSyncTime ? (
            <StatusIndicator type="success">Last synced: {formatTimestamp(syncMetadata.lastSyncTime)}</StatusIndicator>
          ) : (
            <StatusIndicator type="pending">No sync has completed yet</StatusIndicator>
          )}
          <Box variant="small" color="text-body-secondary">
            If data appears outdated, use the button below to sync manually. This runs in the background and may take a
            few minutes. Refresh the page to see the update.
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
    </ContentLayout>
  );
}
