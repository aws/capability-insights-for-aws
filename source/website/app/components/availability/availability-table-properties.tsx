import type { TableProps } from '@cloudscape-design/components/table';
import type { PropertyFilterProps } from '@cloudscape-design/components/property-filter';
import CollectionPreferences, {
  type CollectionPreferencesProps,
} from '@cloudscape-design/components/collection-preferences';
import type { Region } from '@capability-insights/shared/types/capability/region';
import type {
  RegionalAvailability,
  RegionalAvailabilityRow,
} from '@capability-insights/shared/types/availability/regional-availability';
import type { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import AvailabilityStatusIndicator from '~/components/availability/availability-status-indicator';

export interface FilterProperty {
  key: string;
  label: string;
  isEnum?: boolean;
}

/**
 * Creates type-safe filter properties for the AvailabilityTable.
 * Only allows keys that are specific to the subtype T, not base RegionalAvailability keys.
 *
 * @example
 * createFilterProperties<ProductAvailability>([
 *   { key: 'productType', label: 'Type', isEnum: true },  // Allowed
 *   { key: 'name', label: 'Name' },                       // Typescript error
 * ]);
 */
type FilterableKeys<T extends RegionalAvailability> = Exclude<keyof T, keyof RegionalAvailability>;
export function createFilterProperties<T extends RegionalAvailability>(
  props: (Omit<FilterProperty, 'key'> & { key: FilterableKeys<T> })[],
): FilterProperty[] {
  return props.map(p => ({ ...p, key: String(p.key) }));
}

const enumOperators: PropertyFilterProps.FilteringProperty['operators'] = [
  { operator: '=', tokenType: 'enum' },
  { operator: '!=', tokenType: 'enum' },
];

export function createColumns({
  nameColumnHeader,
  regions,
  nameCell,
}: {
  nameColumnHeader: string;
  regions: Region[];
  nameCell?: (row: RegionalAvailability) => React.ReactNode;
}): TableProps.ColumnDefinition<RegionalAvailabilityRow<RegionalAvailability>>[] {
  return [
    {
      id: 'name',
      header: nameColumnHeader,
      cell: row => (nameCell ? nameCell(row) : row.name),
      sortingField: 'name',
      isRowHeader: true,
      width: 500,
    },
    ...regions.map(
      (r): TableProps.ColumnDefinition<RegionalAvailabilityRow<RegionalAvailability>> => ({
        id: r.Region,
        header: (
          <span>
            {r.RegionLongName.replace(/^.*\((.+)\)$/, '$1')}
            <br />
            <small>{r.Region}</small>
          </span>
        ),
        width: 160,
        cell: row => {
          const hasAnyRegionData = regions.some(reg => reg.Region in row);
          if (!hasAnyRegionData) return null;
          return (
            <AvailabilityStatusIndicator
              status={(row[r.Region] as AvailabilityStatus) ?? null}
              launchDate={row.regionDates?.[r.Region]}
            />
          );
        },
      }),
    ),
  ];
}

export function createFilteringProperties(
  nameColumnHeader: string,
  regions: Region[],
  extraFilterProperties: FilterProperty[],
): PropertyFilterProps.FilteringProperty[] {
  return [
    {
      key: 'name',
      propertyLabel: nameColumnHeader,
      groupValuesLabel: `${nameColumnHeader} values`,
      operators: ['=', '!=', ':', '!:'],
      group: 'properties',
    },
    ...extraFilterProperties.map(fp => ({
      key: fp.key,
      propertyLabel: fp.label,
      groupValuesLabel: `${fp.label} values`,
      operators: fp.isEnum ? enumOperators : (['=', '!=', ':', '!:'] as const),
      group: 'properties',
    })),
    ...regions.map(r => ({
      key: r.Region,
      propertyLabel: `${r.RegionLongName} (${r.Region})`,
      groupValuesLabel: `${r.RegionLongName} values`,
      operators: enumOperators,
      group: 'regions',
    })),
  ];
}

export function TablePreferences({
  columns,
  preferences,
  setPreferences,
}: {
  columns: TableProps.ColumnDefinition<RegionalAvailabilityRow<RegionalAvailability>>[];
  preferences: CollectionPreferencesProps.Preferences;
  setPreferences: (next: CollectionPreferencesProps.Preferences) => void;
}) {
  return (
    <CollectionPreferences
      title="Preferences"
      confirmLabel="Confirm"
      cancelLabel="Cancel"
      onConfirm={({ detail }) => setPreferences(detail)}
      preferences={preferences}
      contentDisplayPreference={{
        title: 'Column preferences',
        description: 'Select which columns to display',
        options: columns.map(c => ({
          id: c.id!,
          label: typeof c.header === 'string' ? c.header : c.id!,
          alwaysVisible: c.id === 'name',
        })),
      }}
      stickyColumnsPreference={{
        firstColumns: {
          title: 'First column(s)',
          description: 'Keep the first column(s) visible while horizontally scrolling table content.',
          options: [
            { label: 'None', value: 0 },
            { label: 'First column', value: 1 },
          ],
        },
      }}
    />
  );
}
