import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Tabs from '@cloudscape-design/components/tabs';
import Box from '@cloudscape-design/components/box';
import Badge from '@cloudscape-design/components/badge';
import Alert from '@cloudscape-design/components/alert';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Link from '@cloudscape-design/components/link';
import Popover from '@cloudscape-design/components/popover';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Toggle from '@cloudscape-design/components/toggle';

import { APP_NAME, PAGE_CAPABILITY_BY_REGION } from '~/constants/app';
import type { Region } from '@capability-insights/shared/types/capability/region';
import type { PropertyFilterProps } from '@cloudscape-design/components/property-filter';
import { capabilityInsightsClient, DataFile } from '~/clients/capability-insights-client';
import type { SyncMetadata } from '@capability-insights/shared/types/sync-metadata';
import AvailabilityTable from '~/components/availability/availability-table';
import AvailabilityStatCard from '~/components/availability/availability-stat-card';
import RegionalAvailabilityTypeBadge from '~/components/availability/regional-availability-type-badge';
import { fromApiServices, fromCfnResources, fromProducts } from '~/mappers/regional-availability.mapper';
import { formatTimestamp } from '~/utils/time-utils';
import { useFeatureFlags } from '~/hooks/use-feature-flags';
import type {
  ProductAvailability,
  ApiAvailability,
  CfnAvailability,
} from '@capability-insights/shared/types/availability/regional-availability';

import type { RouteHandle } from '~/types/route';

export const handle: RouteHandle = { pageName: PAGE_CAPABILITY_BY_REGION };

export function meta() {
  return [{ title: APP_NAME }, { name: 'description', content: 'AWS regional availability dashboard' }];
}

export default function CapabilityByRegion() {
  const { state: featureFlagsState, refresh: refreshFeatureFlags } = useFeatureFlags();
  const [regions, setRegions] = useState<Region[]>([]);
  const [productRows, setProductRows] = useState<ProductAvailability[]>([]);
  const [apiRows, setApiRows] = useState<ApiAvailability[]>([]);
  const [cfnRows, setCfnRows] = useState<CfnAvailability[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncMetadata, setSyncMetadata] = useState<SyncMetadata | null>(null);

  // Resolve Usage Analysis state from feature flags. Until flags load we
  // treat the feature as unavailable to avoid flashing a working toggle
  // that would then disable. The toggle's three states map to:
  //   - usageAnalysisAvailable=false → feature stack not deployed (banner)
  //   - usageAnalysisAvailable=true && hasResults=false → enabled but no data yet
  //   - usageAnalysisAvailable=true && hasResults=true → fully working
  const usageAnalysisAvailable = featureFlagsState.status === 'ready' && featureFlagsState.flags.usageAnalysis.enabled;
  const usageAnalysisHasResults =
    featureFlagsState.status === 'ready' && featureFlagsState.flags.usageAnalysis.hasResults === true;

  // Status indicator for the Usage Analysis sync row in the "Last sync"
  // popover. Mirrors the catalog-data row but is sourced from the feature
  // flags response (lastExecutionTime + lastExecutionStatus). Each sync is
  // surfaced separately so failures of one don't hide the other.
  const usageAnalysis = featureFlagsState.status === 'ready' ? featureFlagsState.flags.usageAnalysis : null;
  const analysisStatusIndicator = useMemo(() => {
    if (!usageAnalysis?.enabled) return null;
    const { lastExecutionStatus, lastExecutionTime } = usageAnalysis;
    if (!lastExecutionTime || !lastExecutionStatus) {
      return <StatusIndicator type="pending">Not run yet</StatusIndicator>;
    }
    if (lastExecutionStatus === 'SUCCEEDED') {
      return <StatusIndicator type="success">{formatTimestamp(lastExecutionTime)}</StatusIndicator>;
    }
    if (lastExecutionStatus === 'RUNNING') {
      return <StatusIndicator type="in-progress">Running since {formatTimestamp(lastExecutionTime)}</StatusIndicator>;
    }
    return (
      <StatusIndicator type="error">
        {lastExecutionStatus} at {formatTimestamp(lastExecutionTime)}
      </StatusIndicator>
    );
  }, [usageAnalysis]);

  // "My stuff" toggle state — persisted in URL search params
  const [searchParams, setSearchParams] = useSearchParams();
  const myStuffEnabled = searchParams.get('myStuff') === 'true';
  const [myStuffLoading, setMyStuffLoading] = useState(false);
  const [allProductRows, setAllProductRows] = useState<ProductAvailability[]>([]);
  const [allApiRows, setAllApiRows] = useState<ApiAvailability[]>([]);
  const [allCfnRows, setAllCfnRows] = useState<CfnAvailability[]>([]);
  // Cache for personalized rows — avoids re-fetching on every toggle
  const [usedProductRows, setUsedProductRows] = useState<ProductAvailability[] | null>(null);
  const [usedApiRows, setUsedApiRows] = useState<ApiAvailability[] | null>(null);
  const [usedCfnRows, setUsedCfnRows] = useState<CfnAvailability[] | null>(null);

  useEffect(() => {
    // Re-fetch feature flags on mount so the "Usage analysis" sync time and
    // My Stuff state reflect any analysis run that happened since the app
    // first loaded (the provider only fetches once at startup).
    void refreshFeatureFlags();
    async function load() {
      const [r, p, a, c, syncMetadataResult] = await Promise.all([
        capabilityInsightsClient.listRegions(),
        capabilityInsightsClient.listProducts(),
        capabilityInsightsClient.listApiOperations(),
        capabilityInsightsClient.listCfnResources(),
        capabilityInsightsClient.getLastSyncTime(),
      ]);
      setRegions(r);
      const pRows = fromProducts(p);
      const aRows = fromApiServices(a);
      const cRows = fromCfnResources(c);
      setAllProductRows(pRows);
      setAllApiRows(aRows);
      setAllCfnRows(cRows);
      setSyncMetadata(syncMetadataResult);
      setLoading(false);

      if (searchParams.get('myStuff') === 'true') {
        setMyStuffLoading(true);
        const usedCapabilities = await capabilityInsightsClient.getUsedCapabilities('account', 'combined');
        if (usedCapabilities) {
          const uP = fromProducts(usedCapabilities.products);
          const uA = fromApiServices(usedCapabilities.apis);
          const uC = fromCfnResources(usedCapabilities.cfnResources);
          setUsedProductRows(uP);
          setUsedApiRows(uA);
          setUsedCfnRows(uC);
          setProductRows(uP);
          setApiRows(uA);
          setCfnRows(uC);
        } else {
          setProductRows(pRows);
          setApiRows(aRows);
          setCfnRows(cRows);
        }
        setMyStuffLoading(false);
      } else {
        setProductRows(pRows);
        setApiRows(aRows);
        setCfnRows(cRows);
      }
    }
    load();
  }, []);

  const handleMyStuffToggle = useCallback(
    async (checked: boolean) => {
      setSearchParams(checked ? { myStuff: 'true' } : {}, { replace: true });
      if (checked) {
        // Use cached personalized rows if available
        if (usedProductRows && usedApiRows && usedCfnRows) {
          setProductRows(usedProductRows);
          setApiRows(usedApiRows);
          setCfnRows(usedCfnRows);
          return;
        }
        setMyStuffLoading(true);
        const usedCapabilities = await capabilityInsightsClient.getUsedCapabilities('account', 'combined');
        if (usedCapabilities) {
          const uP = fromProducts(usedCapabilities.products);
          const uA = fromApiServices(usedCapabilities.apis);
          const uC = fromCfnResources(usedCapabilities.cfnResources);
          setUsedProductRows(uP);
          setUsedApiRows(uA);
          setUsedCfnRows(uC);
          setProductRows(uP);
          setApiRows(uA);
          setCfnRows(uC);
        }
        setMyStuffLoading(false);
      } else {
        setProductRows(allProductRows);
        setApiRows(allApiRows);
        setCfnRows(allCfnRows);
      }
    },
    [allProductRows, allApiRows, allCfnRows, usedProductRows, usedApiRows, usedCfnRows, setSearchParams],
  );

  const cfnStackFilterProperty = useMemo((): PropertyFilterProps.FilteringProperty[] => {
    const allStacks = new Set<string>();
    for (const row of cfnRows) {
      if (row.stacks) row.stacks.forEach(s => allStacks.add(s));
    }
    if (allStacks.size === 0) return [];
    return [
      {
        key: 'stack',
        propertyLabel: 'Stack',
        groupValuesLabel: 'Stack values',
        operators: [{ operator: '=', tokenType: 'enum' }, { operator: '!=', tokenType: 'enum' }, ':', '!:'],
        group: 'properties',
      },
    ];
  }, [cfnRows]);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Browse regional availability data for AWS services, API operations, and CloudFormation resource types."
          actions={
            <SpaceBetween direction="horizontal" size="m" alignItems="center">
              {usageAnalysisAvailable ? (
                <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                  <Toggle onChange={({ detail }) => handleMyStuffToggle(detail.checked)} checked={myStuffEnabled}>
                    My stuff
                  </Toggle>
                  {!usageAnalysisHasResults && (
                    <Popover
                      dismissButton={false}
                      position="bottom"
                      size="medium"
                      triggerType="custom"
                      content={
                        <SpaceBetween size="xs">
                          <Box variant="p">
                            Usage Analysis is enabled but hasn&apos;t run yet, so there&apos;s no personalized data to
                            show. Run an analysis from Settings to populate the &quot;My stuff&quot; view.
                          </Box>
                          <Link href="/settings" variant="primary" fontSize="body-s">
                            Go to Settings
                          </Link>
                        </SpaceBetween>
                      }
                    >
                      <StatusIndicator type="info">Run analysis to populate</StatusIndicator>
                    </Popover>
                  )}
                </SpaceBetween>
              ) : null}
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
                      <Link href="/settings" variant="primary" fontSize="body-s">
                        Go to settings
                      </Link>
                    </SpaceBetween>
                  }
                >
                  <StatusIndicator type="error">
                    Sync completed with {syncMetadata.errors.length} error(s)
                  </StatusIndicator>
                </Popover>
              ) : syncMetadata?.lastSyncTime ? (
                <Popover
                  dismissButton={false}
                  position="bottom"
                  size="medium"
                  content={
                    <SpaceBetween size="s">
                      <SpaceBetween size="xxs">
                        <Box variant="awsui-key-label">Catalog data</Box>
                        <StatusIndicator type="success">{formatTimestamp(syncMetadata.lastSyncTime)}</StatusIndicator>
                        <Box variant="small" color="text-body-secondary">
                          Refreshes automatically every 24 hours.
                        </Box>
                      </SpaceBetween>
                      {usageAnalysisAvailable && (
                        <SpaceBetween size="xxs">
                          <Box variant="awsui-key-label">Usage analysis</Box>
                          {analysisStatusIndicator}
                        </SpaceBetween>
                      )}
                      <Link href="/settings" variant="primary" fontSize="body-s">
                        Sync manually
                      </Link>
                    </SpaceBetween>
                  }
                >
                  {myStuffEnabled && usageAnalysis?.lastExecutionTime
                    ? `Last analysis: ${formatTimestamp(usageAnalysis.lastExecutionTime)}`
                    : `Last sync: ${formatTimestamp(syncMetadata.lastSyncTime)}`}
                </Popover>
              ) : undefined}
            </SpaceBetween>
          }
        >
          {PAGE_CAPABILITY_BY_REGION}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {featureFlagsState.status === 'ready' && !usageAnalysisAvailable && (
          <Alert
            type="info"
            header="Personalization is not enabled"
            action={
              <Link
                external
                href="https://github.com/aws/capability-insights-for-aws#deploy-flags"
                variant="primary"
                fontSize="body-s"
              >
                Deployment docs
              </Link>
            }
          >
            The &quot;My stuff&quot; view filters this dashboard to services, APIs, and resources actually used in your
            account. To enable it, redeploy with the <code>--enable-usage-analysis</code> flag.
          </Alert>
        )}
        <ColumnLayout columns={4} variant="text-grid">
          <AvailabilityStatCard
            label="Services &amp; features"
            loading={loading}
            badges={['services', 'features']}
            rows={productRows}
          />
          <AvailabilityStatCard
            label="API operations"
            loading={loading}
            badges={['SDK services', 'operations']}
            rows={apiRows}
          />
          <AvailabilityStatCard
            label="CloudFormation resources"
            loading={loading}
            badges={['services', 'resource types']}
            rows={cfnRows}
          />
          <div>
            <Box variant="awsui-key-label">Regions</Box>
            <Box variant="p">{loading ? 'Loading…' : <Badge>{regions.length.toLocaleString()} regions</Badge>}</Box>
          </div>
        </ColumnLayout>

        <Tabs
          tabs={[
            {
              label: 'Services and features',
              id: 'products',
              content: (
                <AvailabilityTable
                  title="Services and features"
                  nameHeader="AWS Services"
                  regions={regions}
                  regionalAvailability={productRows}
                  downloadUrls={capabilityInsightsClient.exportUrls(DataFile.PRODUCTS)}
                  nameCell={row => (
                    <SpaceBetween direction="horizontal" size="xs">
                      {row.homepageUrl ? (
                        <Link href={row.homepageUrl} external>
                          {row.name}
                        </Link>
                      ) : (
                        <span>{row.name}</span>
                      )}
                      <RegionalAvailabilityTypeBadge type={row.regionalAvailabilityType} />
                    </SpaceBetween>
                  )}
                  loading={loading || myStuffLoading}
                />
              ),
            },
            {
              label: 'API operations',
              id: 'apis',
              content: (
                <AvailabilityTable
                  title="API operations"
                  nameHeader="AWS Services"
                  regions={regions}
                  regionalAvailability={apiRows}
                  downloadUrls={capabilityInsightsClient.exportUrls(DataFile.APIS)}
                  nameCell={row => (
                    <SpaceBetween direction="horizontal" size="xs">
                      {row.homepageUrl ? (
                        <Link href={row.homepageUrl} external>
                          {row.name}
                        </Link>
                      ) : (
                        <span>{row.name}</span>
                      )}
                      <RegionalAvailabilityTypeBadge type={row.regionalAvailabilityType} />
                    </SpaceBetween>
                  )}
                  loading={loading || myStuffLoading}
                />
              ),
            },
            {
              label: 'CloudFormation resources',
              id: 'cfn',
              content: (
                <AvailabilityTable
                  title="CloudFormation resources"
                  nameHeader="AWS Resources"
                  regions={regions}
                  regionalAvailability={cfnRows}
                  downloadUrls={capabilityInsightsClient.exportUrls(DataFile.CFN_RESOURCES)}
                  extraFilteringProperties={cfnStackFilterProperty}
                  nameCell={row => (
                    <SpaceBetween direction="horizontal" size="xs">
                      {row.homepageUrl ? (
                        <Link href={row.homepageUrl} external>
                          {row.name}
                        </Link>
                      ) : (
                        <span>{row.name}</span>
                      )}
                      <RegionalAvailabilityTypeBadge type={row.regionalAvailabilityType} />
                    </SpaceBetween>
                  )}
                  loading={loading || myStuffLoading}
                />
              ),
            },
          ]}
        />
      </SpaceBetween>
    </ContentLayout>
  );
}
