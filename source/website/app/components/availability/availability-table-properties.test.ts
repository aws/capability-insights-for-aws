import { describe, expect, it } from 'vitest';
import type { PropertyFilterQuery } from '@cloudscape-design/collection-hooks';
import { ProductType, type Product } from '@capability-insights/shared/types/capability/product';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import {
  RegionalAvailabilityType,
  type RegionalAvailability,
} from '@capability-insights/shared/types/availability/regional-availability';
import { createFilteringFunction } from './availability-table-properties';
import { fromProducts } from '~/mappers/regional-availability.mapper';

const AVAILABLE = { 'us-east-1': AvailabilityStatus.AVAILABLE };
const NOT_AVAILABLE = { 'us-east-1': AvailabilityStatus.NOT_AVAILABLE };

function productsFixture(): Product[] {
  return [
    {
      productId: 'route-53',
      productName: 'Amazon Route 53',
      productType: ProductType.SERVICE,
      regionalAvailability: AVAILABLE,
      childProducts: [
        {
          productId: 'route-53-domains',
          productName: 'Route 53 Domains',
          productType: ProductType.FEATURE,
          regionalAvailability: AVAILABLE,
        },
        {
          productId: 'private-dns',
          productName: 'Amazon Route 53 Private DNS',
          productType: ProductType.SERVICE,
          regionalAvailability: AVAILABLE,
          childProducts: [
            {
              productId: 'geolocation-routing',
              productName: 'Geolocation Routing',
              productType: ProductType.FEATURE,
              regionalAvailability: NOT_AVAILABLE,
            },
          ],
        },
      ],
    },
    {
      productId: 's3',
      productName: 'Amazon S3',
      productType: ProductType.SERVICE,
      regionalAvailability: AVAILABLE,
    },
  ];
}

/**
 * Applies the filtering function the same way useCollection does: item by
 * item, in array order (parents are emitted before children by the mappers).
 */
function applyFilter(items: RegionalAvailability[], query: PropertyFilterQuery): RegionalAvailability[] {
  const filteringFunction = createFilteringFunction(items);
  return items.filter(item => filteringFunction(item, query));
}

function nameContains(value: string): PropertyFilterQuery {
  return { operation: 'and', tokens: [{ propertyKey: 'name', operator: ':', value }] };
}

describe('createFilteringFunction with product rows (including duplicated child services)', () => {
  const rows = fromProducts(productsFixture());

  it('matching a parent service includes all of its children, including the duplicated leaf', () => {
    const result = applyFilter(rows, nameContains('Amazon Route 53'));
    const names = result.map(r => `${r.name}${r.parentId === null ? ' (root)' : ''}`);
    expect(names).toContain('Amazon Route 53 (root)');
    expect(names).toContain('Route 53 Domains');
    // The duplicated sub-service leaf under the parent is included via ancestor match...
    expect(result.some(r => r.id === 'route-53:private-dns')).toBe(true);
    // ...and its promoted root row matches on its own name, bringing its features along.
    expect(result.some(r => r.id === 'private-dns' && r.parentId === null)).toBe(true);
    expect(result.some(r => r.id === 'geolocation-routing')).toBe(true);
  });

  it('matching a sub-service by name includes both instances and its features', () => {
    const result = applyFilter(rows, nameContains('Private DNS'));
    expect(result.map(r => r.id).sort()).toEqual(['geolocation-routing', 'private-dns', 'route-53:private-dns'].sort());
  });

  it('matching a grandchild feature returns only that row (no unrelated rows)', () => {
    const result = applyFilter(rows, nameContains('Geolocation'));
    expect(result.map(r => r.id)).toEqual(['geolocation-routing']);
  });

  it('does not leak unrelated services into filtered results', () => {
    const result = applyFilter(rows, nameContains('Route 53'));
    expect(result.some(r => r.id === 's3')).toBe(false);
  });

  it('filters by type = Service, matching duplicated leaves, promoted roots, and their descendants', () => {
    const result = applyFilter(rows, {
      operation: 'and',
      tokens: [{ propertyKey: 'regionalAvailabilityType', operator: '=', value: [RegionalAvailabilityType.SERVICE] }],
    });
    const ids = result.map(r => r.id);
    expect(ids).toContain('route-53');
    expect(ids).toContain('route-53:private-dns');
    expect(ids).toContain('private-dns');
    expect(ids).toContain('s3');
    // Children of matched services are included by ancestor cascade (existing behavior).
    expect(ids).toContain('route-53-domains');
    expect(ids).toContain('geolocation-routing');
  });

  it('filters by region availability without cascading to non-matching children', () => {
    const result = applyFilter(rows, {
      operation: 'and',
      tokens: [{ propertyKey: 'region:us-east-1', operator: '=', value: [AvailabilityStatus.NOT_AVAILABLE] }],
    });
    expect(result.map(r => r.id)).toEqual(['geolocation-routing']);
  });

  it('supports negation on names', () => {
    const result = applyFilter(rows, {
      operation: 'and',
      tokens: [{ propertyKey: 'name', operator: '!:', value: 'Route 53' }],
    });
    expect(result.map(r => r.id)).toEqual(['geolocation-routing', 's3']);
  });

  it('resets matched-ancestor state between different queries', () => {
    const filteringFunction = createFilteringFunction(rows);
    const first = nameContains('Amazon Route 53');
    const second = nameContains('Amazon S3');
    rows.forEach(item => filteringFunction(item, first));
    const result = rows.filter(item => filteringFunction(item, second));
    expect(result.map(r => r.id)).toEqual(['s3']);
  });

  it('returns every row for an empty query', () => {
    const result = applyFilter(rows, { operation: 'and', tokens: [] });
    expect(result).toHaveLength(rows.length);
  });
});

describe('createFilteringFunction OR operation', () => {
  const rows = fromProducts(productsFixture());

  it('matches rows satisfying any token, not all tokens', () => {
    const result = applyFilter(rows, {
      operation: 'or',
      tokens: [
        { propertyKey: 'name', operator: ':', value: 'Route 53 Domains' },
        { propertyKey: 'name', operator: ':', value: 'Amazon S3' },
      ],
    });
    // Under the old AND-only behavior this returned nothing: no row contains both strings.
    expect(result.map(r => r.id).sort()).toEqual(['route-53-domains', 's3'].sort());
  });

  it('OR-matched parents still cascade to their children, including duplicated sub-services', () => {
    const result = applyFilter(rows, {
      operation: 'or',
      tokens: [
        { propertyKey: 'name', operator: '=', value: 'Amazon Route 53' },
        { propertyKey: 'name', operator: '=', value: 'Amazon S3' },
      ],
    });
    const ids = result.map(r => r.id);
    // Both exact-name matches...
    expect(ids).toContain('route-53');
    expect(ids).toContain('s3');
    // ...and all of Route 53's children via ancestor cascade.
    expect(ids).toContain('route-53-domains');
    expect(ids).toContain('route-53:private-dns');
    // The promoted root's own name did not match, and its parent (none) did not match.
    expect(ids).not.toContain('private-dns');
  });

  it('supports OR across different property types (name and region availability)', () => {
    const result = applyFilter(rows, {
      operation: 'or',
      tokens: [
        { propertyKey: 'name', operator: '=', value: 'Amazon S3' },
        { propertyKey: 'region:us-east-1', operator: '=', value: [AvailabilityStatus.NOT_AVAILABLE] },
      ],
    });
    expect(result.map(r => r.id).sort()).toEqual(['geolocation-routing', 's3'].sort());
  });

  it('behaves identically to AND for a single token', () => {
    const orResult = applyFilter(rows, {
      operation: 'or',
      tokens: [{ propertyKey: 'name', operator: ':', value: 'Private DNS' }],
    });
    const andResult = applyFilter(rows, nameContains('Private DNS'));
    expect(orResult).toEqual(andResult);
  });

  it('returns every row when no token is evaluable (free-text-only query)', () => {
    const result = applyFilter(rows, {
      operation: 'or',
      tokens: [{ operator: ':', value: 'Route 53' }],
    });
    expect(result).toHaveLength(rows.length);
  });

  it('does not change AND semantics: all tokens must still match', () => {
    const result = applyFilter(rows, {
      operation: 'and',
      tokens: [
        { propertyKey: 'name', operator: ':', value: 'Route 53' },
        { propertyKey: 'name', operator: ':', value: 'Domains' },
      ],
    });
    expect(result.map(r => r.id)).toEqual(['route-53-domains']);
  });
});

describe('createFilteringFunction value inheritance', () => {
  it('children inherit stack values from their parent chain', () => {
    const items: RegionalAvailability[] = [
      {
        id: 'parent',
        parentId: null,
        name: 'Parent',
        regionalAvailabilityType: RegionalAvailabilityType.RESOURCE_TYPE,
        stacks: ['stack-a'],
      },
      {
        id: 'child',
        parentId: 'parent',
        name: 'Child',
        regionalAvailabilityType: RegionalAvailabilityType.PROPERTY,
      },
    ];
    const result = applyFilter(items, {
      operation: 'and',
      tokens: [{ propertyKey: 'stack', operator: '=', value: ['stack-a'] }],
    });
    expect(result.map(r => r.id)).toEqual(['parent', 'child']);
  });

  it('tolerates rows whose parentId is missing from the row set', () => {
    const items: RegionalAvailability[] = [
      {
        id: 'orphan',
        parentId: 'missing-parent',
        name: 'Orphan',
        regionalAvailabilityType: RegionalAvailabilityType.FEATURE,
      },
    ];
    expect(() => applyFilter(items, nameContains('Orphan'))).not.toThrow();
    expect(applyFilter(items, nameContains('Orphan')).map(r => r.id)).toEqual(['orphan']);
  });
});
