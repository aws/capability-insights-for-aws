import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCollection } from '@cloudscape-design/collection-hooks';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Table from '@cloudscape-design/components/table';
import type { TableProps } from '@cloudscape-design/components/table';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import PropertyFilter from '@cloudscape-design/components/property-filter';
import type { PropertyFilterProps } from '@cloudscape-design/components/property-filter';
import Pagination from '@cloudscape-design/components/pagination';
import CollectionPreferences from '@cloudscape-design/components/collection-preferences';
import type { CollectionPreferencesProps } from '@cloudscape-design/components/collection-preferences';
import { PAGE_POLICY_ENFORCER } from '~/constants/app';
import { capabilityInsightsClient } from '~/clients/capability-insights-client';
import { formatTimestamp } from '~/utils/time-utils';
import { useUrlFilter, DEFAULT_EMPTY_QUERY } from '~/hooks/use-url-filter';
import { useFeatureFlags } from '~/hooks/use-feature-flags';
import type { PolicyConfiguration } from '@capability-insights/shared/types/policy-enforcer/policy-configuration';
import type { PolicyStatus } from '@capability-insights/shared/types/policy-enforcer/policy-enums';

import type { RouteHandle } from '~/types/route';

export const handle: RouteHandle = { pageName: PAGE_POLICY_ENFORCER };

export function meta() {
  return [{ title: PAGE_POLICY_ENFORCER }];
}

function StatusCell({ status }: { status: PolicyStatus }) {
  switch (status) {
    case 'active':
      return <StatusIndicator type="success">Active</StatusIndicator>;
    case 'pending':
      return <StatusIndicator type="pending">Pending</StatusIndicator>;
    case 'error':
      return <StatusIndicator type="error">Error</StatusIndicator>;
    default:
      return <StatusIndicator type="info">{status}</StatusIndicator>;
  }
}

const COLUMN_DEFINITIONS: TableProps.ColumnDefinition<PolicyConfiguration>[] = [
  {
    id: 'policyName',
    header: 'Name',
    sortingField: 'policyName',
    cell: item => <Link href={`/policy-enforcer/${encodeURIComponent(item.policyName)}`}>{item.policyName}</Link>,
  },
  {
    id: 'description',
    header: 'Description',
    cell: item => item.description || '—',
  },
  {
    id: 'regions',
    header: 'Regions',
    cell: item => item.regions.length,
  },
  {
    id: 'policyType',
    header: 'Type',
    sortingField: 'policyType',
    cell: item => item.policyType,
  },
  {
    id: 'status',
    header: 'Status',
    sortingField: 'status',
    cell: item => <StatusCell status={item.status} />,
  },
  {
    id: 'lastRefreshTime',
    header: 'Last refresh',
    sortingField: 'lastRefreshTime',
    cell: item => (item.lastRefreshTime ? formatTimestamp(item.lastRefreshTime) : '—'),
  },
  {
    id: 'tags',
    header: 'Tags',
    cell: item => (item.tags.length > 0 ? item.tags.map(t => `${t.key}=${t.value}`).join(', ') : '—'),
  },
];

const FILTERING_PROPERTIES: PropertyFilterProps.FilteringProperty[] = [
  {
    key: 'policyName',
    propertyLabel: 'Name',
    groupValuesLabel: 'Name values',
    operators: ['=', '!=', ':', '!:'],
  },
  {
    key: 'policyType',
    propertyLabel: 'Type',
    groupValuesLabel: 'Type values',
    operators: ['=', '!=', ':', '!:'],
  },
  {
    key: 'status',
    propertyLabel: 'Status',
    groupValuesLabel: 'Status values',
    operators: ['=', '!=', ':', '!:'],
  },
  {
    key: 'description',
    propertyLabel: 'Description',
    groupValuesLabel: 'Description values',
    operators: [':', '!:'],
  },
  {
    key: 'lastRefreshTime',
    propertyLabel: 'Last refresh',
    groupValuesLabel: 'Last refresh values',
    operators: [':', '!:'],
  },
  {
    key: 'tags',
    propertyLabel: 'Tags',
    groupValuesLabel: 'Tag values',
    operators: [':', '!:'],
  },
];

const VISIBLE_CONTENT_OPTIONS: CollectionPreferencesProps.ContentDisplayOption[] = [
  { id: 'policyName', label: 'Name', alwaysVisible: true },
  { id: 'description', label: 'Description' },
  { id: 'regions', label: 'Regions' },
  { id: 'policyType', label: 'Type' },
  { id: 'status', label: 'Status' },
  { id: 'lastRefreshTime', label: 'Last refresh' },
  { id: 'tags', label: 'Tags' },
];

export default function PolicyEnforcer() {
  const { filter: filterQuery, setFilter: setFilterQuery } = useUrlFilter('policy-enforcer');
  const { state: featureFlagsState } = useFeatureFlags();
  const policyEnforcerEnabled = featureFlagsState.status !== 'ready' || featureFlagsState.flags.policyEnforcer.enabled;
  const [policies, setPolicies] = useState<PolicyConfiguration[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [refreshingPolicy, setRefreshingPolicy] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState('');
  const [preferences, setPreferences] = useState<CollectionPreferencesProps.Preferences>({
    pageSize: 20,
  });

  const fetchPolicies = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const result = await capabilityInsightsClient.listPolicies();
      setPolicies(result);
    } catch (e) {
      setPolicies([]);
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (policyEnforcerEnabled) void fetchPolicies();
    else setLoading(false);
  }, [fetchPolicies, policyEnforcerEnabled]);

  const filteringOptions = useMemo(
    () => [
      ...policies.map(p => ({ propertyKey: 'policyName', value: p.policyName })),
      ...policies
        .filter((p): p is PolicyConfiguration & { description: string } => !!p.description)
        .map(p => ({ propertyKey: 'description', value: p.description })),
      { propertyKey: 'policyType', value: 'IAM' },
      { propertyKey: 'policyType', value: 'SCP' },
      { propertyKey: 'status', value: 'active' },
      { propertyKey: 'status', value: 'pending' },
      { propertyKey: 'status', value: 'error' },
      ...policies
        .filter((p): p is PolicyConfiguration & { lastRefreshTime: string } => !!p.lastRefreshTime)
        .map(p => ({ propertyKey: 'lastRefreshTime', value: formatTimestamp(p.lastRefreshTime) })),
      ...policies.flatMap(p => p.tags.map(t => ({ propertyKey: 'tags', value: `${t.key}=${t.value}` }))),
    ],
    [policies],
  );

  const handleRefreshPolicy = async (policyName: string) => {
    setRefreshingPolicy(policyName);
    setRefreshError('');
    try {
      await capabilityInsightsClient.refreshPolicy(policyName);
      await fetchPolicies();
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshingPolicy(null);
    }
  };

  const { items, collectionProps, propertyFilterProps, paginationProps, filteredItemsCount } = useCollection(policies, {
    sorting: { defaultState: { sortingColumn: COLUMN_DEFINITIONS[0] } },
    pagination: { pageSize: preferences.pageSize ?? 20 },
    propertyFiltering: {
      filteringProperties: FILTERING_PROPERTIES,
      defaultQuery: filterQuery ?? DEFAULT_EMPTY_QUERY,
      filteringFunction: (item, { tokens }) => {
        for (const token of tokens) {
          const tokenValues: string[] = Array.isArray(token.value) ? token.value : [token.value];

          // Free-text token (no property selected) — search across all fields
          if (!token.propertyKey) {
            const allText = [
              item.policyName,
              item.description ?? '',
              item.policyType,
              item.status,
              item.tags.map(t => `${t.key}=${t.value}`).join(' '),
            ]
              .join(' ')
              .toLowerCase();
            if (!tokenValues.some(tv => allText.includes(tv.toLowerCase()))) return false;
            continue;
          }

          let value = '';
          switch (token.propertyKey) {
            case 'policyName':
              value = item.policyName;
              break;
            case 'policyType':
              value = item.policyType;
              break;
            case 'status':
              value = item.status;
              break;
            case 'description':
              value = item.description ?? '';
              break;
            case 'lastRefreshTime':
              value = item.lastRefreshTime ? formatTimestamp(item.lastRefreshTime) : '';
              break;
            case 'tags':
              value = item.tags.map(t => `${t.key}=${t.value}`).join(' ');
              break;
            default:
              break;
          }
          const lowerValue = value.toLowerCase();
          switch (token.operator) {
            case '=':
              if (!tokenValues.some(tv => value === tv)) return false;
              break;
            case '!=':
              if (tokenValues.some(tv => value === tv)) return false;
              break;
            case ':':
              if (!tokenValues.some(tv => lowerValue.includes(tv.toLowerCase()))) return false;
              break;
            case '!:':
              if (tokenValues.some(tv => lowerValue.includes(tv.toLowerCase()))) return false;
              break;
          }
        }
        return true;
      },
      noMatch: ' ',
    },
  });

  const actionsColumn: TableProps.ColumnDefinition<PolicyConfiguration> = {
    id: 'actions',
    header: 'Actions',
    cell: item => (
      <Button
        variant="link"
        loading={refreshingPolicy === item.policyName}
        onClick={() => void handleRefreshPolicy(item.policyName)}
      >
        Refresh now
      </Button>
    ),
  };

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Generate IAM Managed Policies and Service Control Policies that deny services and APIs unavailable in your target regions."
          actions={
            <Button variant="primary" href="/policy-enforcer/create" disabled={!policyEnforcerEnabled}>
              Create policy
            </Button>
          }
        >
          {PAGE_POLICY_ENFORCER}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {!policyEnforcerEnabled && (
          <Alert
            type="info"
            header="Policy Enforcer is not enabled"
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
            The Policy Enforcer stack is not deployed. To enable regional governance policy generation, redeploy with
            the{' '}
            <Box variant="code" display="inline">
              --enable-policy-enforcer
            </Box>{' '}
            flag.
          </Alert>
        )}
        {refreshError && (
          <Alert type="error" dismissible onDismiss={() => setRefreshError('')}>
            {refreshError}
          </Alert>
        )}
        {policyEnforcerEnabled && loadError && <Alert type="error">{loadError}</Alert>}
        {policyEnforcerEnabled && (
          <Table
            {...collectionProps}
            loading={loading}
            loadingText="Loading policies"
            items={items}
            trackBy="policyName"
            variant="container"
            columnDefinitions={[...COLUMN_DEFINITIONS, actionsColumn]}
            columnDisplay={preferences.contentDisplay}
            header={<Header counter={`(${filteredItemsCount})`}>Policies</Header>}
            filter={
              <PropertyFilter
                {...propertyFilterProps}
                onChange={({ detail }) => {
                  propertyFilterProps.onChange({ detail });
                  setFilterQuery(detail);
                }}
                filteringPlaceholder="Filter policies"
                countText={`${filteredItemsCount} ${filteredItemsCount === 1 ? 'match' : 'matches'}`}
                expandToViewport
                filteringOptions={filteringOptions}
              />
            }
            pagination={<Pagination {...paginationProps} />}
            preferences={
              <CollectionPreferences
                title="Preferences"
                confirmLabel="Confirm"
                cancelLabel="Cancel"
                onConfirm={({ detail }) => setPreferences(detail)}
                preferences={preferences}
                pageSizePreference={{
                  title: 'Page size',
                  options: [
                    { value: 10, label: '10 policies' },
                    { value: 20, label: '20 policies' },
                    { value: 50, label: '50 policies' },
                  ],
                }}
                contentDisplayPreference={{
                  title: 'Column preferences',
                  description: 'Select which columns to display',
                  options: VISIBLE_CONTENT_OPTIONS,
                }}
              />
            }
            empty={
              <Box textAlign="center" padding="l">
                <Box variant="strong">No policies available</Box>
              </Box>
            }
          />
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
