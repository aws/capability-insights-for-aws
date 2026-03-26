import { useEffect, useState } from 'react';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Tabs from '@cloudscape-design/components/tabs';
import Box from '@cloudscape-design/components/box';
import Badge from '@cloudscape-design/components/badge';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Link from '@cloudscape-design/components/link';
import Popover from '@cloudscape-design/components/popover';
import StatusIndicator from '@cloudscape-design/components/status-indicator';

import { APP_NAME, PAGE_CAPABILITY_BY_REGION } from '~/constants/app';
import type { Region } from '@capability-insights/shared/types/capability/region';
import { capabilityInsightsClient, DataFile } from '~/clients/capability-insights-client';
import AvailabilityTable from '~/components/availability/availability-table';
import AvailabilityStatCard from '~/components/availability/availability-stat-card';
import { createFilterProperties } from '~/components/availability/availability-table-properties';
import RegionalAvailabilityTypeBadge from '~/components/availability/regional-availability-type-badge';
import { fromApiServices, fromCfnResources, fromProducts } from '~/mappers/regional-availability.mapper';
import { formatTimestamp } from '~/utils/time-utils';
import type {
  ProductAvailability,
  ApiAvailability,
  CfnAvailability,
  RegionalAvailabilityRow,
} from '@capability-insights/shared/types/availability/regional-availability';

import type { RouteHandle } from '~/types/route';

export const handle: RouteHandle = { pageName: PAGE_CAPABILITY_BY_REGION };

export function meta() {
  return [{ title: APP_NAME }, { name: 'description', content: 'AWS regional availability dashboard' }];
}

const productFilterProperties = createFilterProperties<ProductAvailability>([
  { key: 'productType', label: 'Type', isEnum: true },
]);

const apiFilterProperties = createFilterProperties<ApiAvailability>([
  { key: 'sdkServiceName', label: 'SDK Service' },
  { key: 'productName', label: 'Product' },
]);

const cfnFilterProperties = createFilterProperties<CfnAvailability>([{ key: 'serviceName', label: 'Service' }]);

export default function CapabilityByRegion() {
  const [regions, setRegions] = useState<Region[]>([]);
  const [productRows, setProductRows] = useState<RegionalAvailabilityRow<ProductAvailability>[]>([]);
  const [apiRows, setApiRows] = useState<RegionalAvailabilityRow<ApiAvailability>[]>([]);
  const [cfnRows, setCfnRows] = useState<RegionalAvailabilityRow<CfnAvailability>[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const [r, p, a, c, syncMeta] = await Promise.all([
        capabilityInsightsClient.listRegions(),
        capabilityInsightsClient.listProducts(),
        capabilityInsightsClient.listApiOperations(),
        capabilityInsightsClient.listCfnResources(),
        capabilityInsightsClient.getLastSyncTime(),
      ]);
      const codes = r.map(reg => reg.Region);
      setRegions(r);
      setProductRows(fromProducts(p, codes));
      setApiRows(fromApiServices(a, codes));
      setCfnRows(fromCfnResources(c, codes));
      setLastSyncTime(syncMeta?.lastSyncTime ?? null);
      setLoading(false);
    }
    load();
  }, []);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Browse regional availability data for AWS services, API operations, and CloudFormation resource types."
          actions={
            lastSyncTime ? (
              <Popover
                dismissButton={false}
                position="bottom"
                size="small"
                content={
                  <SpaceBetween size="xs">
                    <StatusIndicator type="success">{formatTimestamp(lastSyncTime)}</StatusIndicator>
                    <Box variant="small" color="text-body-secondary">
                      Data refreshes automatically every 24 hours.
                    </Box>
                    <Link href="/settings" variant="primary" fontSize="body-s">
                      Sync manually
                    </Link>
                  </SpaceBetween>
                }
              >
                Last sync: {formatTimestamp(lastSyncTime)}
              </Popover>
            ) : undefined
          }
        >
          {PAGE_CAPABILITY_BY_REGION}
        </Header>
      }
    >
      <SpaceBetween size="l">
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
                  customFilterProperties={productFilterProperties}
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
                  loading={loading}
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
                  customFilterProperties={apiFilterProperties}
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
                  loading={loading}
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
                  customFilterProperties={cfnFilterProperties}
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
                  loading={loading}
                />
              ),
            },
          ]}
        />
      </SpaceBetween>
    </ContentLayout>
  );
}
