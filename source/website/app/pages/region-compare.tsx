import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import FormField from '@cloudscape-design/components/form-field';
import Tabs from '@cloudscape-design/components/tabs';
import Table from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import Box from '@cloudscape-design/components/box';
import Toggle from '@cloudscape-design/components/toggle';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Alert from '@cloudscape-design/components/alert';
import Spinner from '@cloudscape-design/components/spinner';
import Popover from '@cloudscape-design/components/popover';

import { APP_NAME, PAGE_REGION_COMPARE } from '~/constants/app';
import type { RouteHandle } from '~/types/route';
import { capabilityInsightsClient } from '~/clients/capability-insights-client';
import { formatTimestamp } from '~/utils/time-utils';
import type { Region } from '@capability-insights/shared/types/capability/region';
import type { Product } from '@capability-insights/shared/types/capability/product';
import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type { CfnResource } from '@capability-insights/shared/types/capability/cfn';
import type { SyncMetadata } from '@capability-insights/shared/types/sync-metadata';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import {
  flattenProducts,
  isAvailableIn,
  diffRegions,
  type RegionalAvailabilityMap,
} from '@capability-insights/shared/types/capability-query';

export const handle: RouteHandle = { pageName: PAGE_REGION_COMPARE };

export function meta() {
  return [
    { title: `${PAGE_REGION_COMPARE} · ${APP_NAME}` },
    { name: 'description', content: 'Compare AWS capability availability between two regions' },
  ];
}

/** A single comparable catalog entity, normalized for the diff table. */
interface CompareItem {
  id: string;
  name: string;
  /** Secondary label (e.g. service for an API operation). */
  detail?: string;
  regionalAvailability?: RegionalAvailabilityMap;
}

type EntityKind = 'products' | 'apis' | 'cfn';

function statusIndicator(status: AvailabilityStatus | undefined): React.ReactNode {
  switch (status) {
    case AvailabilityStatus.AVAILABLE:
      return <StatusIndicator type="success">Available</StatusIndicator>;
    case AvailabilityStatus.PLANNED:
    case AvailabilityStatus.PLANNING:
      return <StatusIndicator type="pending">{status}</StatusIndicator>;
    case AvailabilityStatus.NOT_EXPANDING:
      return <StatusIndicator type="warning">Not expanding</StatusIndicator>;
    case AvailabilityStatus.NOT_AVAILABLE:
      return <StatusIndicator type="stopped">Not available</StatusIndicator>;
    default:
      return (
        <Box color="text-status-inactive" fontSize="body-s">
          —
        </Box>
      );
  }
}

/** Build the comparable-item list for each entity kind from the raw catalogs. */
function toItems(kind: EntityKind, products: Product[], apis: ApiService[], cfn: CfnResource[]): CompareItem[] {
  if (kind === 'products') {
    return flattenProducts(products).map(p => ({
      id: p.productId,
      name: p.productName,
      detail: p.productType,
      regionalAvailability: p.regionalAvailability,
    }));
  }
  if (kind === 'apis') {
    const items: CompareItem[] = [];
    for (const service of apis) {
      for (const op of service.apis) {
        items.push({
          id: `${service.sdkServiceName}:${op.apiAction}`,
          name: op.apiAction,
          detail: service.sdkServiceFullName || service.sdkServiceName,
          regionalAvailability: op.regionalAvailability,
        });
      }
    }
    return items;
  }
  // cfn
  const items: CompareItem[] = [];
  for (const service of cfn) {
    for (const rt of service.resourceTypes) {
      items.push({
        id: rt.resourceTypeName,
        name: rt.resourceTypeName,
        detail: service.serviceName,
        regionalAvailability: rt.regionalAvailability,
      });
    }
  }
  return items;
}

function regionOption(r: Region): SelectProps.Option {
  return { value: r.Region, label: `${r.Region} — ${r.RegionLongName}`, description: r.Partition };
}

export default function RegionCompare() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [regions, setRegions] = useState<Region[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [apis, setApis] = useState<ApiService[]>([]);
  const [cfn, setCfn] = useState<CfnResource[]>([]);
  const [syncMetadata, setSyncMetadata] = useState<SyncMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const regionA = searchParams.get('a') ?? '';
  const regionB = searchParams.get('b') ?? '';
  const activeTab = (searchParams.get('tab') as EntityKind) || 'products';
  const onlyDiff = searchParams.get('all') !== 'true';
  const [filterText, setFilterText] = useState('');

  function setParam(key: string, value: string): void {
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  }

  useEffect(() => {
    async function load() {
      try {
        const [r, p, a, c, sync] = await Promise.all([
          capabilityInsightsClient.listRegions(),
          capabilityInsightsClient.listProducts(),
          capabilityInsightsClient.listApiOperations(),
          capabilityInsightsClient.listCfnResources(),
          capabilityInsightsClient.getLastSyncTime(),
        ]);
        setRegions(r);
        setProducts(p);
        setApis(a);
        setCfn(c);
        setSyncMetadata(sync);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const items = useMemo(() => toItems(activeTab, products, apis, cfn), [activeTab, products, apis, cfn]);

  const bothSelected = Boolean(regionA && regionB && regionA !== regionB);

  // Diff summary (uses the shared deterministic core, same semantics as the
  // policy allow-list engine: only AVAILABLE counts, missing data = not).
  const summary = useMemo(() => {
    if (!bothSelected) return null;
    return diffRegions(items, regionA, regionB);
  }, [items, regionA, regionB, bothSelected]);

  const rows = useMemo(() => {
    if (!bothSelected) return [];
    const needle = filterText.trim().toLowerCase();
    return items
      .map(it => {
        const availA = isAvailableIn(it.regionalAvailability, regionA);
        const availB = isAvailableIn(it.regionalAvailability, regionB);
        return {
          ...it,
          statusA: it.regionalAvailability?.[regionA],
          statusB: it.regionalAvailability?.[regionB],
          differs: availA !== availB,
        };
      })
      .filter(row => (onlyDiff ? row.differs : true))
      .filter(row => !needle || row.name.toLowerCase().includes(needle) || row.detail?.toLowerCase().includes(needle))
      .sort((x, y) => x.name.localeCompare(y.name));
  }, [items, regionA, regionB, bothSelected, onlyDiff, filterText]);

  const selectedA = regions.find(r => r.Region === regionA);
  const selectedB = regions.find(r => r.Region === regionB);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Compare which products, API operations, and CloudFormation resource types are available between two regions."
          actions={
            syncMetadata?.lastSyncTime ? (
              <Popover
                header="Data freshness"
                content={`Catalog last synced ${formatTimestamp(syncMetadata.lastSyncTime)}`}
                triggerType="custom"
              >
                <StatusIndicator type="success">Synced {formatTimestamp(syncMetadata.lastSyncTime)}</StatusIndicator>
              </Popover>
            ) : undefined
          }
        >
          {PAGE_REGION_COMPARE}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {loadError && (
          <Alert type="error" header="Failed to load catalog data">
            {loadError}
          </Alert>
        )}

        <ColumnLayout columns={2}>
          <FormField label="Region A">
            <Select
              selectedOption={selectedA ? regionOption(selectedA) : null}
              onChange={({ detail }) => setParam('a', detail.selectedOption.value ?? '')}
              options={regions.map(regionOption)}
              filteringType="auto"
              placeholder="Select a region"
              empty={loading ? 'Loading regions…' : 'No regions'}
            />
          </FormField>
          <FormField label="Region B">
            <Select
              selectedOption={selectedB ? regionOption(selectedB) : null}
              onChange={({ detail }) => setParam('b', detail.selectedOption.value ?? '')}
              options={regions.map(regionOption)}
              filteringType="auto"
              placeholder="Select a region"
              empty={loading ? 'Loading regions…' : 'No regions'}
            />
          </FormField>
        </ColumnLayout>

        {loading && <Spinner size="large" />}

        {!loading && regionA && regionB && regionA === regionB && (
          <Alert type="info">Pick two different regions to compare.</Alert>
        )}

        {!loading && !bothSelected && regionA !== regionB && (
          <Box color="text-status-inactive">Select two regions above to see the comparison.</Box>
        )}

        {bothSelected && summary && (
          <ColumnLayout columns={4} variant="text-grid">
            <div>
              <Box variant="awsui-key-label">Only in {regionA}</Box>
              <Box variant="h2">{summary.onlyInA.length}</Box>
            </div>
            <div>
              <Box variant="awsui-key-label">Only in {regionB}</Box>
              <Box variant="h2">{summary.onlyInB.length}</Box>
            </div>
            <div>
              <Box variant="awsui-key-label">In both</Box>
              <Box variant="h2">{summary.inBoth.length}</Box>
            </div>
            <div>
              <Box variant="awsui-key-label">In neither</Box>
              <Box variant="h2">{summary.inNeither.length}</Box>
            </div>
          </ColumnLayout>
        )}

        {bothSelected && (
          <Tabs
            activeTabId={activeTab}
            onChange={({ detail }) => setParam('tab', detail.activeTabId)}
            tabs={(['products', 'apis', 'cfn'] as EntityKind[]).map(kind => ({
              id: kind,
              label: kind === 'products' ? 'Products' : kind === 'apis' ? 'API operations' : 'CloudFormation resources',
              content: (
                <Table<(typeof rows)[number]>
                  variant="embedded"
                  items={rows}
                  trackBy="id"
                  filter={
                    <SpaceBetween size="m" direction="horizontal">
                      <TextFilter
                        filteringText={filterText}
                        filteringPlaceholder="Find by name"
                        onChange={({ detail }) => setFilterText(detail.filteringText)}
                      />
                      <Toggle checked={!onlyDiff} onChange={({ detail }) => setParam('all', String(detail.checked))}>
                        Show items available in both / neither
                      </Toggle>
                    </SpaceBetween>
                  }
                  columnDefinitions={[
                    { id: 'name', header: 'Name', cell: row => row.name, sortingField: 'name' },
                    { id: 'detail', header: 'Service / type', cell: row => row.detail ?? '—' },
                    { id: 'a', header: regionA, cell: row => statusIndicator(row.statusA) },
                    { id: 'b', header: regionB, cell: row => statusIndicator(row.statusB) },
                  ]}
                  empty={
                    <Box textAlign="center" color="inherit">
                      {onlyDiff ? 'No differences between these regions for this category.' : 'No items.'}
                    </Box>
                  }
                />
              ),
            }))}
          />
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
