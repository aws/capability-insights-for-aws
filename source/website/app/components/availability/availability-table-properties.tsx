import type { TableProps } from '@cloudscape-design/components/table';
import type { PropertyFilterProps } from '@cloudscape-design/components/property-filter';
import CollectionPreferences, {
  type CollectionPreferencesProps,
} from '@cloudscape-design/components/collection-preferences';
import type {
  PropertyFilterQuery,
  PropertyFilterToken,
  PropertyFilterTokenGroup,
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
    ...regions.map((r): TableProps.ColumnDefinition<RegionalAvailability> => ({
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
    })),
  ];
}

export function createFilteringProperties(
  regions: Region[],
  extraProperties?: PropertyFilterProps.FilteringProperty[],
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
    ...(extraProperties ?? []),
    ...regions.map(r => ({
      key: `region:${r.Region}`,
      propertyLabel: `${r.RegionLongName} (${r.Region})`,
      groupValuesLabel: `${r.RegionLongName} values`,
      operators: enumOperators,
      group: 'regions',
    })),
  ];
}

export function createFilteringFunction(items: RegionalAvailability[]) {
  const byId = new Map(items.map(i => [i.id, i]));

  const resolveValue = (item: RegionalAvailability, key: string): string | undefined => {
    if (key === 'name') return item.name;
    if (key === 'regionalAvailabilityType') return item.regionalAvailabilityType;
    if (key === 'stack') return item.stacks?.join(',');
    if (key.startsWith('region:')) return item.regionalAvailability?.[key.slice(7)];
    return undefined;
  };

  const tokenMatchesValue = (value: string | undefined, token: PropertyFilterToken, key: string): boolean => {
    if (key === 'stack' && value) {
      const stackValues = value.split(',');
      const tokenValues: string[] = Array.isArray(token.value) ? token.value : [token.value];
      switch (token.operator) {
        case '=':
          return stackValues.some(s => tokenValues.includes(s));
        case '!=':
          return !stackValues.some(s => tokenValues.includes(s));
        case ':':
          return stackValues.some(s => tokenValues.some(tv => s.toLowerCase().includes(tv.toLowerCase())));
        case '!:':
          return !stackValues.some(s => tokenValues.some(tv => s.toLowerCase().includes(tv.toLowerCase())));
        default:
          return false;
      }
    }

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

  const isTokenGroup = (t: PropertyFilterToken | PropertyFilterTokenGroup): t is PropertyFilterTokenGroup => {
    return 'operation' in t && 'tokens' in t;
  };

  const evaluateTokenOrGroup = (
    item: RegionalAvailability,
    tokenOrGroup: PropertyFilterToken | PropertyFilterTokenGroup,
  ): boolean => {
    if (isTokenGroup(tokenOrGroup)) {
      const { operation, tokens } = tokenOrGroup;
      if (tokens.length === 0) return true;
      return operation === 'or'
        ? tokens.some(t => evaluateTokenOrGroup(item, t))
        : tokens.every(t => evaluateTokenOrGroup(item, t));
    }

    const token = tokenOrGroup;
    if (!token.propertyKey) {
      const name = item.name?.toLowerCase() ?? '';
      const tokenValue = String(token.value).toLowerCase();
      switch (token.operator) {
        case ':':
          return name.includes(tokenValue);
        case '!:':
          return !name.includes(tokenValue);
        case '=':
          return name === tokenValue;
        case '!=':
          return name !== tokenValue;
        default:
          return name.includes(tokenValue);
      }
    }

    const value = resolveValue(item, token.propertyKey);
    return tokenMatchesValue(value, token, token.propertyKey);
  };

  const itemMatchesQuery = (item: RegionalAvailability, query: PropertyFilterQuery): boolean => {
    const entries = query.tokenGroups ?? query.tokens;
    if (!entries || entries.length === 0) return true;
    return evaluateTokenOrGroup(item, { operation: query.operation, tokens: entries });
  };

  return (item: RegionalAvailability, query: PropertyFilterQuery): boolean => {
    if (itemMatchesQuery(item, query)) return true;

    let ancestor = item.parentId ? byId.get(item.parentId) : undefined;
    while (ancestor) {
      if (itemMatchesQuery(ancestor, query)) return true;
      ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
    }

    return false;
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
