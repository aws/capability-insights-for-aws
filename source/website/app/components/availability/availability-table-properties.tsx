import type { TableProps } from '@cloudscape-design/components/table';
import type { PropertyFilterProps } from '@cloudscape-design/components/property-filter';
import CollectionPreferences, {
  type CollectionPreferencesProps,
} from '@cloudscape-design/components/collection-preferences';
import type {
  PropertyFilterQuery,
  PropertyFilterToken,
} from '@cloudscape-design/collection-hooks';
import type { Region } from '@capability-insights/shared/types/capability/region';
import type { RegionalAvailability } from '@capability-insights/shared/types/availability/regional-availability';
import type { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import AvailabilityStatusIndicator from '~/components/availability/availability-status-indicator';

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
}): TableProps.ColumnDefinition<RegionalAvailability>[] {
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
      (r): TableProps.ColumnDefinition<RegionalAvailability> => ({
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
          if (!row.regionalAvailability) return null;
          return (
            <AvailabilityStatusIndicator
              status={(row.regionalAvailability[r.Region] as AvailabilityStatus) ?? null}
              launchDate={row.regionDates?.[r.Region]}
            />
          );
        },
      }),
    ),
  ];
}

export function createFilteringProperties(
  regions: Region[],
): PropertyFilterProps.FilteringProperty[] {
  return [
    {
      key: 'name',
      propertyLabel: 'Name',
      groupValuesLabel: 'Name values',
      operators: ['=', '!=', ':', '!:'],
      group: 'properties',
    },
    {
      key: 'regionalAvailabilityType',
      propertyLabel: 'Type',
      groupValuesLabel: 'Type values',
      operators: enumOperators,
      group: 'properties',
    },
    ...regions.map(r => ({
      key: `region:${r.Region}`,
      propertyLabel: `${r.RegionLongName} (${r.Region})`,
      groupValuesLabel: `${r.RegionLongName} values`,
      operators: enumOperators,
      group: 'regions',
    })),
  ];
}

/**
 * Known property keys on RegionalAvailability that the filter can resolve
 * directly, without needing a generic record cast.
 */
const KNOWN_KEYS: ReadonlySet<string> = new Set<keyof RegionalAvailability>([
  'name',
  'regionalAvailabilityType',
]);

/**
 * Creates a filtering function that handles regular properties, region
 * availability lookups (keys prefixed with "region:"), and parent-chain
 * inheritance. When a parent matches, its children are included too.
 */
export function createFilteringFunction(items: RegionalAvailability[]) {
  const byId = new Map(items.map(i => [i.id, i]));
  const matchedIds = new Set<string>();

  const resolveKnownKey = (item: RegionalAvailability, key: string): string | undefined => {
    if (key === 'name') return item.name;
    if (key === 'regionalAvailabilityType') return item.regionalAvailabilityType;
    return undefined;
  };

  const resolve = (item: RegionalAvailability, key: string): string | undefined => {
    let current: RegionalAvailability | undefined = item;
    while (current) {
      const value = resolveKnownKey(current, key);
      if (value !== undefined) return value;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return undefined;
  };

  const tokenMatches = (value: string | undefined, token: PropertyFilterToken): boolean => {
    const tokenValues: string[] = Array.isArray(token.value) ? token.value : [token.value];
    const stringValue = value ?? '';

    switch (token.operator) {
      case '=':
        return tokenValues.includes(stringValue);
      case '!=':
        return !tokenValues.includes(stringValue);
      case ':':
        return tokenValues.some(tv => stringValue.toLowerCase().includes(tv.toLowerCase()));
      case '!:':
        return !tokenValues.some(tv => stringValue.toLowerCase().includes(tv.toLowerCase()));
      default:
        return false;
    }
  };

  const matchesTokens = (item: RegionalAvailability, tokens: readonly PropertyFilterToken[]): boolean => {
    for (const token of tokens) {
      if (!token.propertyKey) continue;

      const isRegion = token.propertyKey.startsWith('region:');
      const value = isRegion
        ? item.regionalAvailability?.[token.propertyKey.slice(7)]
        : resolve(item, token.propertyKey);

      if (!tokenMatches(value, token)) return false;
    }
    return true;
  };

  const hasMatchedAncestor = (item: RegionalAvailability): boolean => {
    let current = item.parentId ? byId.get(item.parentId) : undefined;
    while (current) {
      if (matchedIds.has(current.id)) return true;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  };

  let lastQuery: PropertyFilterQuery | null = null;

  return (item: RegionalAvailability, query: PropertyFilterQuery): boolean => {
    if (query !== lastQuery) {
      matchedIds.clear();
      lastQuery = query;
    }

    const tokens = query.tokenGroups ?? query.tokens;

    if (matchesTokens(item, tokens as readonly PropertyFilterToken[])) {
      matchedIds.add(item.id);
      return true;
    }

    return hasMatchedAncestor(item);
  };
}

export function TablePreferences({
  columns,
  preferences,
  setPreferences,
}: {
  columns: TableProps.ColumnDefinition<RegionalAvailability>[];
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
