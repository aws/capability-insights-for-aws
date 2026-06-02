import { useMemo, useState } from 'react';
import { useCollection } from '@cloudscape-design/collection-hooks';
import Table from '@cloudscape-design/components/table';
import PropertyFilter from '@cloudscape-design/components/property-filter';
import type { PropertyFilterProps } from '@cloudscape-design/components/property-filter';
import type { CollectionPreferencesProps } from '@cloudscape-design/components/collection-preferences';
import Pagination from '@cloudscape-design/components/pagination';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Button from '@cloudscape-design/components/button';
import ButtonDropdown from '@cloudscape-design/components/button-dropdown';
import type { Region } from '@capability-insights/shared/types/capability/region';
import type { RegionalAvailability } from '@capability-insights/shared/types/availability/regional-availability';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import type { ExportUrls } from '~/clients/capability-insights-client';
import {
  createColumns,
  createFilteringProperties,
  createFilteringFunction,
  TablePreferences,
} from './availability-table-properties';

interface AvailabilityTableProps<T extends RegionalAvailability> {
  title: string;
  nameHeader: string;
  nameCell: (row: T) => React.ReactNode;
  regions: Region[];
  regionalAvailability: T[];
  downloadUrls: ExportUrls;
  loading?: boolean;
  extraFilteringProperties?: PropertyFilterProps.FilteringProperty[];
}

export default function AvailabilityTable<T extends RegionalAvailability>({
  title,
  nameHeader,
  nameCell,
  regions,
  regionalAvailability,
  downloadUrls,
  loading = false,
  extraFilteringProperties,
}: AvailabilityTableProps<T>) {
  const [preferences, setPreferences] = useState<CollectionPreferencesProps.Preferences>({
    stickyColumns: { first: 1, last: 0 },
  });

  const columnDefinitions = createColumns({
    nameColumnHeader: nameHeader,
    regions,
    nameCell: nameCell as (row: RegionalAvailability) => React.ReactNode,
  });
  const filteringProperties = createFilteringProperties(regions, extraFilteringProperties);
  const filteringFunction = useMemo(() => createFilteringFunction(regionalAvailability), [regionalAvailability]);

  const hasNesting = regionalAvailability.some(i => i.parentId !== null);
  const parentItems = useMemo(
    () => regionalAvailability.filter(i => i.parentId === null && regionalAvailability.some(c => c.parentId === i.id)),
    [regionalAvailability],
  );

  const {
    items: collectionItems,
    actions,
    collectionProps,
    propertyFilterProps,
    filteredItemsCount,
    paginationProps,
  } = useCollection(regionalAvailability, {
    sorting: {},
    pagination: { pageSize: 20 },
    propertyFiltering: {
      filteringProperties,
      filteringFunction,
      noMatch: ' ',
    },
    ...(hasNesting && {
      expandableRows: {
        getId: item => item.id,
        getParentId: item => item.parentId,
      },
    }),
  });

  const allExpanded = hasNesting && (collectionProps.expandableRows?.expandedItems.length ?? 0) > 0;

  const regionOptionValues = Object.values(AvailabilityStatus);
  const regionFilteringOptions = regions.flatMap(r =>
    regionOptionValues.map(status => ({ propertyKey: `region:${r.Region}`, value: status })),
  );

  // Collect unique stack values for the stack filter
  const stackFilteringOptions = useMemo(() => {
    const stacks = new Set<string>();
    for (const item of regionalAvailability) {
      if (item.stacks) item.stacks.forEach(s => stacks.add(s));
    }
    return Array.from(stacks).map(s => ({ propertyKey: 'stack', value: s }));
  }, [regionalAvailability]);

  const filteringOptions = [
    ...propertyFilterProps.filteringOptions,
    ...regionFilteringOptions,
    ...stackFilteringOptions,
  ];

  return (
    <Table
      {...collectionProps}
      columnDefinitions={columnDefinitions}
      items={collectionItems}
      loading={loading}
      loadingText="Loading data"
      stickyColumns={preferences.stickyColumns}
      columnDisplay={preferences.contentDisplay}
      variant="embedded"
      resizableColumns
      enableKeyboardNavigation
      header={
        <Header
          counter={`(${filteredItemsCount})`}
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              {hasNesting && (
                <Button
                  iconName={allExpanded ? 'treeview-collapse' : 'treeview-expand'}
                  onClick={() => actions.setExpandedItems(allExpanded ? [] : parentItems)}
                >
                  {allExpanded ? 'Collapse all' : 'Expand all'}
                </Button>
              )}
              <ButtonDropdown
                items={[
                  { id: 'json', text: 'Download as JSON' },
                  { id: 'csv', text: 'Download as CSV' },
                ]}
                onItemClick={({ detail }) => {
                  const url = detail.id === 'json' ? downloadUrls.json : downloadUrls.csv;
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = '';
                  a.click();
                }}
                ariaLabel={`Export ${title}`}
              >
                Export
              </ButtonDropdown>
            </SpaceBetween>
          }
        >
          {title}
        </Header>
      }
      filter={
        <PropertyFilter
          {...propertyFilterProps}
          filteringOptions={filteringOptions}
          filteringPlaceholder={`Filter ${title.toLowerCase()}`}
          countText={`${filteredItemsCount} matches`}
          expandToViewport
          enableTokenGroups
          virtualScroll
          customGroupsText={[
            {
              properties: 'Properties',
              values: 'Property values',
              group: 'properties',
            },
            { properties: 'Regions', values: 'Region values', group: 'regions' },
          ]}
        />
      }
      pagination={<Pagination {...paginationProps} />}
      preferences={
        <TablePreferences columns={columnDefinitions} preferences={preferences} setPreferences={setPreferences} />
      }
      expandableRows={collectionProps.expandableRows}
    />
  );
}
