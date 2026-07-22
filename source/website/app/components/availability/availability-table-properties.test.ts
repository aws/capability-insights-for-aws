import { describe, expect, it } from 'vitest';
import type {
  PropertyFilterQuery,
  PropertyFilterToken,
  PropertyFilterTokenGroup,
} from '@cloudscape-design/collection-hooks';
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

function applyFilter(items: RegionalAvailability[], query: PropertyFilterQuery): RegionalAvailability[] {
  const filteringFunction = createFilteringFunction(items);
  return items.filter(item => filteringFunction(item, query));
}

function nameContains(value: string): PropertyFilterQuery {
  return { operation: 'and', tokens: [{ propertyKey: 'name', operator: ':', value }] };
}

describe('createFilteringFunction: per-item evaluation', () => {
  const rows = fromProducts(productsFixture());

  it('matches items whose name contains the search term', () => {
    const result = applyFilter(rows, nameContains('Amazon Route 53'));
    const matchedNames = result.map(r => r.name);
    expect(matchedNames).toContain('Amazon Route 53');
    expect(matchedNames).toContain('Amazon Route 53 Private DNS');
    expect(matchedNames).toContain('Route 53 Domains');
    expect(matchedNames).not.toContain('Amazon S3');
  });

  it('matches a grandchild feature by name', () => {
    const result = applyFilter(rows, nameContains('Geolocation'));
    expect(result.map(r => r.id)).toEqual(['geolocation-routing']);
  });

  it('does not include unrelated services', () => {
    const result = applyFilter(rows, nameContains('Route 53'));
    expect(result.some(r => r.id === 's3')).toBe(false);
  });

  it('filters by type = Service', () => {
    const result = applyFilter(rows, {
      operation: 'and',
      tokens: [{ propertyKey: 'regionalAvailabilityType', operator: '=', value: [RegionalAvailabilityType.SERVICE] }],
    });
    const ids = result.map(r => r.id);
    expect(ids).toContain('route-53');
    expect(ids).toContain('route-53:private-dns');
    expect(ids).toContain('private-dns');
    expect(ids).toContain('s3');
    // Children of matched services are included via ancestor inheritance
    expect(ids).toContain('route-53-domains');
    expect(ids).toContain('geolocation-routing');
  });

  it('filters by region availability', () => {
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
    const ids = result.map(r => r.id);
    expect(ids).toContain('geolocation-routing');
    expect(ids).toContain('s3');
    expect(ids).not.toContain('route-53');
  });

  it('matching a parent includes all its children via ancestor inheritance', () => {
    const result = applyFilter(rows, {
      operation: 'and',
      tokens: [{ propertyKey: 'name', operator: '=', value: 'Amazon Route 53' }],
    });
    const ids = result.map(r => r.id);
    expect(ids).toContain('route-53');
    expect(ids).toContain('route-53-domains');
    expect(ids).toContain('route-53:private-dns');
    expect(ids).not.toContain('s3');
  });

  it('returns every row for an empty query', () => {
    const result = applyFilter(rows, { operation: 'and', tokens: [] });
    expect(result).toHaveLength(rows.length);
  });
});

describe('createFilteringFunction: OR operation (flat tokens)', () => {
  const rows = fromProducts(productsFixture());

  it('matches rows satisfying any token with OR operation', () => {
    const result = applyFilter(rows, {
      operation: 'or',
      tokens: [
        { propertyKey: 'name', operator: ':', value: 'Route 53 Domains' },
        { propertyKey: 'name', operator: ':', value: 'Amazon S3' },
      ],
    });
    const ids = result.map(r => r.id);
    expect(ids).toContain('route-53-domains');
    expect(ids).toContain('s3');
  });

  it('supports OR across different property types (name and region)', () => {
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

  it('AND requires all tokens to match', () => {
    const result = applyFilter(rows, {
      operation: 'and',
      tokens: [
        { propertyKey: 'name', operator: ':', value: 'Route 53' },
        { propertyKey: 'name', operator: ':', value: 'Domains' },
      ],
    });
    expect(result.map(r => r.id)).toEqual(['route-53-domains']);
  });

  it('AND with mutually exclusive names returns zero results', () => {
    const result = applyFilter(rows, {
      operation: 'and',
      tokens: [
        { propertyKey: 'name', operator: '=', value: 'Amazon S3' },
        { propertyKey: 'name', operator: '=', value: 'Amazon Route 53' },
      ],
    });
    expect(result).toHaveLength(0);
  });

  it('OR with region filters includes rows where at least one region matches', () => {
    const result = applyFilter(rows, {
      operation: 'or',
      tokens: [
        { propertyKey: 'region:us-east-1', operator: '=', value: [AvailabilityStatus.AVAILABLE] },
        { propertyKey: 'region:us-east-1', operator: '=', value: [AvailabilityStatus.NOT_AVAILABLE] },
      ],
    });
    expect(result).toHaveLength(rows.length);
  });
});

describe('createFilteringFunction: tokenGroups (enableTokenGroups)', () => {
  const rows = fromProducts(productsFixture());

  it('evaluates PropertyFilterTokenGroup with OR operation', () => {
    const tokenGroup: PropertyFilterTokenGroup = {
      operation: 'or',
      tokens: [
        { propertyKey: 'name', operator: '=', value: 'Amazon S3' },
        { propertyKey: 'name', operator: '=', value: 'Amazon Route 53' },
      ],
    };
    const query: PropertyFilterQuery = {
      operation: 'and',
      tokens: [],
      tokenGroups: [tokenGroup],
    };
    const result = applyFilter(rows, query);
    const ids = result.map(r => r.id);
    expect(ids).toContain('route-53');
    expect(ids).toContain('s3');
    expect(ids).toContain('route-53-domains');
  });

  it('evaluates flat tokens in tokenGroups with AND at top level', () => {
    const query: PropertyFilterQuery = {
      operation: 'and',
      tokens: [],
      tokenGroups: [
        { propertyKey: 'name', operator: ':', value: 'Route 53' } as PropertyFilterToken,
        {
          propertyKey: 'region:us-east-1',
          operator: '=',
          value: [AvailabilityStatus.AVAILABLE],
        } as PropertyFilterToken,
      ],
    };
    const result = applyFilter(rows, query);
    const ids = result.map(r => r.id);
    expect(ids).toContain('route-53');
    expect(ids).toContain('route-53:private-dns');
    expect(ids).toContain('private-dns');
    expect(ids).not.toContain('s3');
  });

  it('handles mixed flat tokens and nested token groups', () => {
    const query: PropertyFilterQuery = {
      operation: 'or',
      tokens: [],
      tokenGroups: [
        { propertyKey: 'name', operator: '=', value: 'Amazon S3' } as PropertyFilterToken,
        {
          operation: 'and',
          tokens: [{ propertyKey: 'region:us-east-1', operator: '=', value: [AvailabilityStatus.NOT_AVAILABLE] }],
        } as PropertyFilterTokenGroup,
      ],
    };
    const result = applyFilter(rows, query);
    expect(result.map(r => r.id).sort()).toEqual(['geolocation-routing', 's3'].sort());
  });

  it('prefers tokenGroups over tokens when both are present', () => {
    const query: PropertyFilterQuery = {
      operation: 'and',
      tokens: [{ propertyKey: 'name', operator: '=', value: 'NONEXISTENT' }],
      tokenGroups: [{ propertyKey: 'name', operator: '=', value: 'Amazon S3' } as PropertyFilterToken],
    };
    const result = applyFilter(rows, query);
    expect(result.map(r => r.id)).toContain('s3');
  });

  it('returns every row for empty tokenGroups', () => {
    const result = applyFilter(rows, { operation: 'and', tokens: [], tokenGroups: [] });
    expect(result).toHaveLength(rows.length);
  });
});

describe('createFilteringFunction: free-text tokens', () => {
  const rows = fromProducts(productsFixture());

  it('free-text token matches against item name', () => {
    const result = applyFilter(rows, {
      operation: 'and',
      tokens: [{ operator: ':', value: 'Route 53' }],
    });
    const names = result.map(r => r.name);
    expect(names).toContain('Amazon Route 53');
    expect(names).toContain('Route 53 Domains');
    expect(names).toContain('Amazon Route 53 Private DNS');
    // Children of matched parents are included via ancestor inheritance
    expect(names).toContain('Geolocation Routing');
    expect(names).not.toContain('Amazon S3');
  });

  it('free-text negation excludes matching names', () => {
    const result = applyFilter(rows, {
      operation: 'and',
      tokens: [{ operator: '!:', value: 'Route 53' }],
    });
    const names = result.map(r => r.name);
    expect(names).not.toContain('Amazon Route 53');
    expect(names).toContain('Geolocation Routing');
    expect(names).toContain('Amazon S3');
  });
});

describe('createFilteringFunction: stack property', () => {
  it('matches items by stack value', () => {
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
    // Parent matches directly, child included via ancestor inheritance
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
