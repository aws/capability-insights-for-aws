import { describe, it, expect, vi } from 'vitest';
import { executeTool, type ToolDataSources } from './tool-executor';
import { ToolName, ProposableWriteKind } from './tools';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import { ProductType, type Product } from '@capability-insights/shared/types/capability/product';
import type { Region } from '@capability-insights/shared/types/capability/region';
import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type { CfnResource } from '@capability-insights/shared/types/capability/cfn';
import type { UsedCapabilities } from '@capability-insights/shared/types/used-capabilities';

const A = AvailabilityStatus.AVAILABLE;
const NA = AvailabilityStatus.NOT_AVAILABLE;
const IAD = 'us-east-1';
const DUB = 'eu-west-1';

function product(
  id: string,
  name: string,
  avail: Record<string, AvailabilityStatus>,
  childProducts?: Product[],
): Product {
  return {
    productId: id,
    productName: name,
    productType: ProductType.SERVICE,
    regionalAvailability: avail,
    childProducts,
  };
}

const regions: Region[] = [
  {
    Region: IAD,
    RegionLongName: 'US East (N. Virginia)',
    Partition: 'aws',
    RegionStatus: 'ACTIVE',
    RequireRegionOptIn: false,
  },
  {
    Region: DUB,
    RegionLongName: 'Europe (Ireland)',
    Partition: 'aws',
    RegionStatus: 'ACTIVE',
    RequireRegionOptIn: false,
  },
];

const products: Product[] = [
  product('amazon-bedrock', 'Amazon Bedrock', { [IAD]: A, [DUB]: NA }),
  product('amazon-s3', 'Amazon S3', { [IAD]: A, [DUB]: A }),
];

const apis: ApiService[] = [
  {
    sdkServiceName: 's3',
    sdkServiceFullName: 'Amazon S3',
    apis: [{ apiName: 's3', apiAction: 'GetObject', homepage: '', regionalAvailability: { [IAD]: A, [DUB]: NA } }],
  },
];

const cfn: CfnResource[] = [
  {
    serviceName: 'AWS::S3',
    resourceTypes: [
      { resourceTypeName: 'AWS::S3::Bucket', resourceTypeHomepage: '', regionalAvailability: { [IAD]: A, [DUB]: A } },
    ],
  },
];

function makeSources(overrides: Partial<ToolDataSources> = {}): ToolDataSources {
  return {
    loadRegions: vi.fn(async () => regions),
    loadProducts: vi.fn(async () => products),
    loadApis: vi.fn(async () => apis),
    loadCfn: vi.fn(async () => cfn),
    loadSyncMetadata: vi.fn(async () => ({ lastSyncTime: '2026-06-19T00:00:00.000Z' })),
    loadUsedCapabilities: vi.fn(async () => null),
    loadFeatureFlags: vi.fn(async () => ({ usageAnalysisEnabled: false, policyEnforcerEnabled: true })),
    previewPolicy: vi.fn(async () => null),
    ...overrides,
  };
}

describe('executeTool — list_regions', () => {
  it('returns normalized region info', async () => {
    const { content } = await executeTool(ToolName.LIST_REGIONS, {}, makeSources());
    expect(content).toEqual([
      { code: IAD, name: 'US East (N. Virginia)', partition: 'aws' },
      { code: DUB, name: 'Europe (Ireland)', partition: 'aws' },
    ]);
  });
});

describe('query_capabilities — available_in', () => {
  it('reports exact status for a named product in a region', async () => {
    const yes = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'available_in', entityType: 'product', name: 'Bedrock', regions: [IAD] },
      makeSources(),
    );
    expect(yes.content).toMatchObject({ mode: 'available_in', region: IAD, availableCount: 1 });
    expect((yes.content as { items: { items: { name: string; status: string }[] } }).items.items[0]).toMatchObject({
      name: 'Amazon Bedrock',
      status: A,
    });

    const no = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'available_in', entityType: 'product', name: 'Bedrock', regions: [DUB] },
      makeSources(),
    );
    expect(no.content).toMatchObject({ availableCount: 0 });
    expect((no.content as { items: { items: { status: string }[] } }).items.items[0].status).toBe(NA);
  });

  it('ranks the closest name match as primary (exact "Amazon Bedrock" over "Amazon Bedrock Integration")', async () => {
    // Catalog order deliberately puts the substring match FIRST to prove ranking, not order, wins.
    const products2: Product[] = [
      product('amazon-bedrock-integration', 'Amazon Bedrock Integration', { [IAD]: A }),
      product('amazon-bedrock', 'Amazon Bedrock', { [IAD]: A }),
    ];
    const { answer } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'available_in', entityType: 'product', name: 'Amazon Bedrock', regions: [IAD] },
      makeSources({ loadProducts: vi.fn(async () => products2) }),
    );
    expect(answer?.primary?.label).toBe('Amazon Bedrock');
    expect(answer?.alternates?.[0]?.label).toBe('Amazon Bedrock Integration');
  });

  it('a bare service token resolves to the canonical "Amazon <X>" service, not a feature that contains it', async () => {
    // "s3" is a whole word in BOTH "Amazon S3" and "S3 Tables" (tie at the
    // word-boundary tier). The canonical-service tier must lift "Amazon S3"
    // above the feature so a bare token means the SERVICE. Catalog order puts
    // the feature first to prove ranking, not order, decides.
    const products2: Product[] = [
      product('s3-tables', 'S3 Tables', { [IAD]: A }),
      product('s3-glacier', 'S3 Glacier', { [IAD]: A }),
      product('amazon-s3', 'Amazon S3', { [IAD]: A }),
    ];
    const { answer } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'where_available', entityType: 'product', name: 's3' },
      makeSources({ loadProducts: vi.fn(async () => products2) }),
    );
    expect(answer?.primary?.label).toBe('Amazon S3');
  });

  it('detail=true attaches typed facts (product launch dates) to the answer item', async () => {
    const products2: Product[] = [
      {
        productId: 'amazon-bedrock',
        productName: 'Amazon Bedrock',
        productType: ProductType.SERVICE,
        regionalAvailability: { [IAD]: A, [DUB]: AvailabilityStatus.PLANNED },
        launchDates: { [DUB]: '2026 Q3' },
        childProducts: [product('br-agents', 'Bedrock Agents', { [IAD]: A })],
      },
    ];
    const { answer } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'available_in', entityType: 'product', name: 'Amazon Bedrock', regions: [IAD], detail: true },
      makeSources({ loadProducts: vi.fn(async () => products2) }),
    );
    const facts = answer?.primary?.facts ?? [];
    const byLabel = Object.fromEntries(facts.map(f => [f.label, f.values]));
    expect(byLabel['Type']).toEqual(['SERVICE']);
    expect(byLabel['Features']).toEqual(['1']);
    expect(byLabel['Launch dates']).toEqual(['eu-west-1: 2026 Q3']);
  });

  it('returns zero matches for an unknown product (no hallucination)', async () => {
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'available_in', entityType: 'product', name: 'Totally Made Up Service', regions: [IAD] },
      makeSources(),
    );
    expect(content).toMatchObject({ matched: 0 });
  });

  it('resolves an API operation by service:Action', async () => {
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'available_in', entityType: 'api', name: 's3:GetObject', regions: [DUB] },
      makeSources(),
    );
    expect(content).toMatchObject({ matched: 1, availableCount: 0 });
  });

  it('resolves a CFN resource type by name', async () => {
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'available_in', entityType: 'cfn', name: 'AWS::S3::Bucket', regions: [IAD] },
      makeSources(),
    );
    expect(content).toMatchObject({ matched: 1, availableCount: 1 });
  });
});

describe('query_capabilities — where_available', () => {
  it('lists sorted available regions for a product, with homepage', async () => {
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'where_available', entityType: 'product', name: 'S3' },
      makeSources(),
    );
    expect(content).toMatchObject({ found: true, matched: 'Amazon S3', items: [DUB, IAD] });
  });
});

describe('query_capabilities — diff', () => {
  it('returns counts and capped only-in lists', async () => {
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'diff', entityType: 'product', regions: [IAD, DUB] },
      makeSources(),
    );
    expect(content).toMatchObject({
      regionA: IAD,
      regionB: DUB,
      counts: { onlyInA: 1, onlyInB: 0, inBoth: 1, inNeither: 0 },
    });
    expect((content as { onlyInA: { items: { name: string }[] } }).onlyInA.items[0]).toMatchObject({
      name: 'Amazon Bedrock',
    });
  });
});

describe('query_capabilities — list', () => {
  it('lists products NOT available in a region via status filter', async () => {
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'list', entityType: 'product', regions: [DUB], status: [NA] },
      makeSources(),
    );
    expect(content).toMatchObject({ region: DUB, total: 1 });
    expect((content as { items: { name: string }[] }).items[0]).toMatchObject({ name: 'Amazon Bedrock' });
  });

  it('lists products available in a region when no status filter is given', async () => {
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'list', entityType: 'product', regions: [DUB] },
      makeSources(),
    );
    // Only S3 is available in DUB
    expect(content).toMatchObject({ total: 1 });
    expect((content as { items: { name: string }[] }).items[0]).toMatchObject({ name: 'Amazon S3' });
  });

  it('lists everything NOT available via statusOp "!=" (not-yet-available)', async () => {
    // status=[Available] op=!= in DUB => everything whose status is not Available.
    // Bedrock is NOT_AVAILABLE in DUB; S3 is AVAILABLE. So only Bedrock matches.
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'list', entityType: 'product', regions: [DUB], status: [A], statusOp: '!=' },
      makeSources(),
    );
    expect(content).toMatchObject({ region: DUB, statusOp: '!=', total: 1 });
    expect((content as { items: { name: string }[] }).items[0]).toMatchObject({ name: 'Amazon Bedrock' });
  });

  it('productType=SERVICE counts services only — nested features are excluded from the count AND list', async () => {
    // A service NOT available in DUB, plus a FEATURE also not available in DUB.
    // "services only (not features) not available in DUB" must count 1, not 2.
    const mixed: Product[] = [
      {
        productId: 'svc-a',
        productName: 'Service A',
        productType: ProductType.SERVICE,
        regionalAvailability: { [IAD]: A, [DUB]: NA },
      },
      {
        productId: 'feat-a',
        productName: 'Feature A',
        productType: ProductType.FEATURE,
        regionalAvailability: { [IAD]: A, [DUB]: NA },
      },
      {
        productId: 'svc-b',
        productName: 'Service B',
        productType: ProductType.SERVICE,
        regionalAvailability: { [IAD]: A, [DUB]: A }, // available in DUB -> excluded by status
      },
    ];
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'list', entityType: 'product', regions: [DUB], status: [A], statusOp: '!=', productType: 'SERVICE' },
      makeSources({ loadProducts: vi.fn(async () => mixed) }),
    );
    // Only Service A: a SERVICE that is not Available in DUB. Feature A excluded
    // (FEATURE), Service B excluded (Available). Count reflects the filter.
    expect(content).toMatchObject({ region: DUB, productType: 'SERVICE', total: 1 });
    expect((content as { items: { name: string }[] }).items.map(i => i.name)).toEqual(['Service A']);
  });
});

describe('query_capabilities — orderBy (rank/superlative over the FULL set, before the cap)', () => {
  // Many region codes so regionCount can vary across a wide range.
  const REGION_POOL = Array.from({ length: 60 }, (_, i) => `r-${i}`);
  const allRegions: Region[] = REGION_POOL.map(code => ({
    Region: code,
    RegionLongName: code,
    Partition: 'aws',
    RegionStatus: 'ACTIVE',
    RequireRegionOptIn: false,
  }));

  // 60 products (> MAX_ITEMS=50). availability in the FIRST k regions, where k is
  // engineered so the TRUE max-coverage and min-coverage products sit OUTSIDE the
  // first 50 in catalog order — proving the sort runs over the full set, not a
  // truncated slice. Product i (0-based) is available in (i % 7) + 1 regions...
  // except product 58 is available in ALL 60 (the true max) and product 55 in
  // exactly 1 (a min), both beyond index 50.
  function coverage(i: number): number {
    if (i === 58) return 60; // unique global max, late in catalog order
    if (i === 55) return 1; // a min, late in catalog order
    return (i % 5) + 2; // 2..6 regions for everyone else
  }
  const manyProducts: Product[] = Array.from({ length: 60 }, (_, i) => {
    const avail: Record<string, AvailabilityStatus> = {};
    for (let r = 0; r < coverage(i); r++) avail[REGION_POOL[r]] = A;
    return product(`prod-${String(i).padStart(2, '0')}`, `Product ${String(i).padStart(2, '0')}`, avail);
  });

  it('regionCount desc surfaces the widest-coverage product even though it is beyond the cap', async () => {
    const { content, answer } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'list', entityType: 'product', orderBy: 'regionCount', order: 'desc' },
      makeSources({ loadRegions: vi.fn(async () => allRegions), loadProducts: vi.fn(async () => manyProducts) }),
    );
    // total is the exact full count; the answer's primary is the true argmax.
    expect(content).toMatchObject({ total: 60, orderBy: 'regionCount', order: 'desc' });
    expect(answer?.primary?.label).toBe('Product 58'); // available in all 60 regions
    expect((content as { items: { name: string }[] }).items[0]).toMatchObject({ name: 'Product 58' });
  });

  it('decouples the caps: model content is capped at 50, the browser answer carries the FULL list', async () => {
    const { content, answer } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'list', entityType: 'product', orderBy: 'name', order: 'asc' },
      makeSources({ loadRegions: vi.fn(async () => allRegions), loadProducts: vi.fn(async () => manyProducts) }),
    );
    // Model-facing content: capped (50 items) + truncated flag + exact total.
    const c = content as { items: unknown[]; total: number; truncated: boolean };
    expect(c.items.length).toBe(50);
    expect(c.truncated).toBe(true);
    expect(c.total).toBe(60);
    // Browser-facing answer: primary + ALL remaining as alternates (60 total),
    // so the paginated card shows every row — no "showing 50 of 60".
    expect((answer?.alternates?.length ?? 0) + (answer?.primary ? 1 : 0)).toBe(60);
  });

  it('regionCount asc surfaces the narrowest-coverage product (true argmin, beyond the cap)', async () => {
    const { answer } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'list', entityType: 'product', orderBy: 'regionCount', order: 'asc' },
      makeSources({ loadRegions: vi.fn(async () => allRegions), loadProducts: vi.fn(async () => manyProducts) }),
    );
    expect(answer?.primary?.label).toBe('Product 55'); // available in exactly 1 region
  });

  it('soonestLaunch asc returns the earliest UPCOMING planned quarter; entities with no launch date are EXCLUDED (not candidates)', async () => {
    const dated: Product[] = [
      {
        productId: 'p-late',
        productName: 'Late Svc',
        productType: ProductType.SERVICE,
        regionalAvailability: { [IAD]: AvailabilityStatus.PLANNED },
        launchDates: { [IAD]: '2027 Q3' },
      },
      {
        productId: 'p-soon',
        productName: 'Soon Svc',
        productType: ProductType.SERVICE,
        regionalAvailability: { [IAD]: AvailabilityStatus.PLANNED },
        launchDates: { [IAD]: '2026 Q1', [DUB]: '2026 Q4' },
      },
      {
        productId: 'p-none',
        productName: 'No Date Svc',
        productType: ProductType.SERVICE,
        regionalAvailability: { [IAD]: A },
      },
    ];
    const { content, answer } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'list', entityType: 'product', orderBy: 'soonestLaunch', order: 'asc' },
      makeSources({ loadProducts: vi.fn(async () => dated) }),
    );
    // p-soon's earliest quarter is 2026 Q1 (min over its dates) -> first.
    expect(answer?.primary?.label).toBe('Soon Svc');
    // The dateless product is EXCLUDED from the ranking, not name-sorted to the end.
    expect(content).toMatchObject({ total: 2, unranked: 1 });
    expect((answer?.alternates ?? []).map(a => a.label)).not.toContain('No Date Svc');
    // The ranked-by value is surfaced so the model can cite the quarter.
    expect(answer?.primary?.facts?.some(f => f.label === 'Soonest launch' && f.values[0] === '2026 Q1')).toBe(true);
  });

  it('an ALL-null-keyed set yields an EMPTY ranking (no bogus winner) — usedCount over products', async () => {
    // products have no usage.count, so usedCount is null for every entity.
    const { content, answer } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'list', entityType: 'product', orderBy: 'usedCount', order: 'desc' },
      makeSources(),
    );
    // Nothing is rankable -> total 0, all entities reported as unranked, no primary.
    expect(content).toMatchObject({ total: 0, unranked: 2 });
    expect(answer?.primary).toBeUndefined();
  });

  it('regionCount surfaces the count as a citable fact (regionCount has no entityFact otherwise)', async () => {
    const { answer } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'list', entityType: 'product', orderBy: 'regionCount', order: 'desc' },
      makeSources(),
    );
    // Amazon S3 is available in both regions (2) -> ranked first, with the count visible.
    expect(answer?.primary?.label).toBe('Amazon S3');
    expect(answer?.primary?.facts?.some(f => f.label === 'Available regions' && f.values[0] === '2')).toBe(true);
  });

  it('usedCount desc on usage_summary ranks the most-used CFN resource type first', async () => {
    const used: UsedCapabilities = {
      products: [],
      apis: [],
      cfnResources: [
        {
          serviceName: 'AWS::EC2',
          resourceTypes: [
            {
              resourceTypeName: 'Instance',
              resourceTypeHomepage: '',
              regionalAvailability: { [IAD]: A },
              usage: { stacks: ['s'], properties: {}, count: 3 },
            },
          ],
        },
        {
          serviceName: 'AWS::S3',
          resourceTypes: [
            {
              resourceTypeName: 'Bucket',
              resourceTypeHomepage: '',
              regionalAvailability: { [IAD]: A },
              usage: { stacks: ['s'], properties: {}, count: 99 },
            },
          ],
        },
      ] as unknown as UsedCapabilities['cfnResources'],
      lastAnalyzedAt: '2026-06-22T00:00:00.000Z',
    };
    const { answer } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'usage_summary', entityType: 'cfn', usedOnly: true, orderBy: 'usedCount', order: 'desc' },
      makeSources({
        loadFeatureFlags: vi.fn(async () => ({ usageAnalysisEnabled: true, policyEnforcerEnabled: false })),
        loadUsedCapabilities: vi.fn(async () => used),
      }),
    );
    expect(answer?.primary?.label).toBe('Bucket'); // count 99 > 3
  });

  it('without orderBy, list preserves catalog order (no behavior change)', async () => {
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'list', entityType: 'product' },
      makeSources(),
    );
    expect((content as { items: { name: string }[] }).items[0]).toMatchObject({ name: 'Amazon Bedrock' });
    expect(content).toMatchObject({ orderBy: null, order: null });
  });
});

describe('query_capabilities — CFN service-name matching (APS bug)', () => {
  const apsCfn: CfnResource[] = [
    {
      serviceName: 'AWS::APS',
      resourceTypes: [
        { resourceTypeName: 'AnomalyDetector', resourceTypeHomepage: '', regionalAvailability: { [IAD]: A } },
        { resourceTypeName: 'Workspace', resourceTypeHomepage: '', regionalAvailability: { [IAD]: A } },
        { resourceTypeName: 'RuleGroupsNamespace', resourceTypeHomepage: '', regionalAvailability: { [IAD]: A } },
        { resourceTypeName: 'Scraper', resourceTypeHomepage: '', regionalAvailability: { [IAD]: A } },
        { resourceTypeName: 'QueryLoggingConfiguration', resourceTypeHomepage: '', regionalAvailability: { [IAD]: A } },
      ],
    },
  ];

  it('bare "APS" matches all 5 APS resource types via service name', async () => {
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'list', entityType: 'cfn', name: 'APS' },
      makeSources({ loadCfn: vi.fn(async () => apsCfn) }),
    );
    expect(content).toMatchObject({ total: 5 });
  });

  it('"APS Service" (noise word) still matches all 5 — stopword tolerant', async () => {
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'list', entityType: 'cfn', name: 'APS Service' },
      makeSources({ loadCfn: vi.fn(async () => apsCfn) }),
    );
    expect(content).toMatchObject({ total: 5 });
  });

  it('AWS::S3::Bucket still resolves exactly (matched:1) — no regression', async () => {
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'available_in', entityType: 'cfn', name: 'AWS::S3::Bucket', regions: [IAD] },
      makeSources(),
    );
    expect(content).toMatchObject({ matched: 1, availableCount: 1 });
  });

  it('s3:GetObject still resolves by id (matched:1) — no regression', async () => {
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'available_in', entityType: 'api', name: 's3:GetObject', regions: [DUB] },
      makeSources(),
    );
    expect(content).toMatchObject({ matched: 1, availableCount: 0 });
  });

  it('product ranking unchanged: exact "Amazon Bedrock" outranks "Amazon Bedrock Integration"', async () => {
    const products2: Product[] = [
      product('amazon-bedrock-integration', 'Amazon Bedrock Integration', { [IAD]: A }),
      product('amazon-bedrock', 'Amazon Bedrock', { [IAD]: A }),
    ];
    const { answer } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'available_in', entityType: 'product', name: 'Amazon Bedrock', regions: [IAD] },
      makeSources({ loadProducts: vi.fn(async () => products2) }),
    );
    expect(answer?.primary?.label).toBe('Amazon Bedrock');
    expect(answer?.alternates?.[0]?.label).toBe('Amazon Bedrock Integration');
  });
});

describe('query_capabilities — usage modes feature gating', () => {
  it('usage_summary returns notEnabled when Usage Analysis is off', async () => {
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'usage_summary', entityType: 'product', usedOnly: true },
      makeSources({
        loadFeatureFlags: vi.fn(async () => ({ usageAnalysisEnabled: false, policyEnforcerEnabled: false })),
      }),
    );
    expect(content).toMatchObject({ notEnabled: true });
  });

  it('usage_summary lists used products (region-less) when enabled', async () => {
    const used: UsedCapabilities = {
      products: [
        product('amazon-bedrock', 'Amazon Bedrock', { [IAD]: A }, [
          product('br-agents', 'Bedrock Agents', { [IAD]: A }),
        ]),
      ],
      apis,
      cfnResources: [],
      lastAnalyzedAt: '2026-06-22T14:21:21.000Z',
    };
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'usage_summary', entityType: 'product', usedOnly: true },
      makeSources({
        loadFeatureFlags: vi.fn(async () => ({ usageAnalysisEnabled: true, policyEnforcerEnabled: false })),
        loadUsedCapabilities: vi.fn(async () => used),
      }),
    );
    expect(content).toMatchObject({ mode: 'usage_summary', lastAnalyzedAt: '2026-06-22T14:21:21.000Z', total: 2 });
    expect((content as { items: { name: string }[] }).items.map(i => i.name)).toEqual([
      'Amazon Bedrock',
      'Bedrock Agents',
    ]);
  });

  it('usage_detail surfaces the used property values (EC2 instance types) + stacks', async () => {
    const used: UsedCapabilities = {
      products: [],
      apis: [],
      cfnResources: [
        {
          serviceName: 'AWS::EC2',
          resourceTypes: [
            {
              resourceTypeName: 'AWS::EC2::Instance',
              resourceTypeHomepage: 'https://docs.aws.amazon.com/ec2',
              regionalAvailability: { [IAD]: A },
              usage: {
                stacks: ['test-assets-a', 'sample-env'],
                properties: { InstanceType: ['t3.micro', 'm5.large'] },
                count: 4,
              },
            },
          ],
        } as unknown as UsedCapabilities['cfnResources'][number],
      ],
      lastAnalyzedAt: '2026-06-22T14:21:21.000Z',
    };
    const { content, answer } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'usage_detail', entityType: 'cfn', usedOnly: true, name: 'EC2' },
      makeSources({
        loadFeatureFlags: vi.fn(async () => ({ usageAnalysisEnabled: true, policyEnforcerEnabled: false })),
        loadUsedCapabilities: vi.fn(async () => used),
      }),
    );
    // usage_detail now renders typed FACTS (hierarchical definition list), not a flat string.
    expect(answer?.primary?.label).toBe('AWS::EC2::Instance');
    const facts = answer?.primary?.facts ?? [];
    const byLabel = Object.fromEntries(facts.map(f => [f.label, f.values]));
    expect(byLabel['InstanceType']).toEqual(['t3.micro', 'm5.large']);
    expect(byLabel['Stacks']).toEqual(['test-assets-a', 'sample-env']);
    expect(byLabel['Used count']).toEqual(['4']);
    // Content still carries the facts for the model.
    const rows = (content as { items: Array<{ resourceType: string; facts: { label: string; values: string[] }[] }> })
      .items;
    expect(rows[0].resourceType).toBe('AWS::EC2::Instance');
  });

  it('usage_gaps reports per-target-region missing used products', async () => {
    const used: UsedCapabilities = {
      products: [product('amazon-bedrock', 'Amazon Bedrock', { [IAD]: A, [DUB]: NA })],
      apis,
      cfnResources: [],
      lastAnalyzedAt: '2026-06-19T00:00:00.000Z',
    };
    const { content } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'usage_gaps', entityType: 'product', usedOnly: true, regions: [DUB] },
      makeSources({
        loadFeatureFlags: vi.fn(async () => ({ usageAnalysisEnabled: true, policyEnforcerEnabled: false })),
        loadUsedCapabilities: vi.fn(async () => used),
      }),
    );
    const gaps = (content as { gaps: Array<{ targetRegion: string; missingCount: number; items: { name: string }[] }> })
      .gaps;
    expect(gaps[0]).toMatchObject({ targetRegion: DUB, missingCount: 1 });
    expect(gaps[0].items[0]).toMatchObject({ name: 'Amazon Bedrock' });
  });
});

describe('query_capabilities — answer payload (drawer answer card)', () => {
  it('available_in emits an availability answer with primary + alternates + docs link', async () => {
    const products2: Product[] = [
      {
        productId: 'amazon-bedrock',
        productName: 'Amazon Bedrock',
        productType: ProductType.SERVICE,
        homepage: 'https://aws.amazon.com/bedrock',
        regionalAvailability: { [IAD]: A },
      },
      {
        productId: 'br-agents',
        productName: 'Bedrock Agents',
        productType: ProductType.FEATURE,
        regionalAvailability: { [IAD]: A },
      },
    ];
    const { answer } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'available_in', entityType: 'product', name: 'Bedrock', regions: [IAD] },
      makeSources({ loadProducts: vi.fn(async () => products2) }),
    );
    expect(answer).toBeDefined();
    expect(answer).toMatchObject({ kind: 'availability', total: 2 });
    expect(answer?.primary).toMatchObject({ label: 'Amazon Bedrock', status: A });
    expect(answer?.primary?.links?.[0]).toMatchObject({ href: 'https://aws.amazon.com/bedrock', external: true });
    expect(answer?.alternates?.[0]).toMatchObject({ label: 'Bedrock Agents' });
  });

  it('the answer is self-contained — it does not drive the main pane (no navigateTo)', async () => {
    // The drawer renders the answer card in place; it never navigates or filters
    // the search-results table, so the chat's count can never diverge from what
    // the page would render. The AnswerPayload carries no main-pane routing.
    const { answer } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'available_in', entityType: 'product', name: 'Bedrock', regions: [IAD] },
      makeSources(),
    );
    expect(answer).not.toHaveProperty('navigateTo');
  });

  it('diff emits a region-diff answer rendered in the drawer (no internal app link)', async () => {
    const { answer } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'diff', entityType: 'product', regions: [IAD, DUB] },
      makeSources(),
    );
    expect(answer).toMatchObject({ kind: 'region-diff' });
    // No internal app-route links — only external docs links may appear on items.
    expect((answer?.links ?? []).every(l => l.external)).toBe(true);
  });

  it('usage_summary emits a usage-summary answer with notEnabled when disabled', async () => {
    const { answer } = await executeTool(
      ToolName.QUERY_CAPABILITIES,
      { mode: 'usage_summary', usedOnly: true },
      makeSources({
        loadFeatureFlags: vi.fn(async () => ({ usageAnalysisEnabled: false, policyEnforcerEnabled: false })),
      }),
    );
    expect(answer).toMatchObject({ kind: 'usage-summary', notEnabled: true });
  });
});

describe('executeTool — get_last_sync_time / get_feature_flags', () => {
  it('get_last_sync_time returns the freshness metadata', async () => {
    const { content } = await executeTool(ToolName.GET_LAST_SYNC_TIME, {}, makeSources());
    expect(content).toMatchObject({ lastSyncTime: '2026-06-19T00:00:00.000Z' });
  });

  it('get_feature_flags returns the deploy-time state', async () => {
    const { content } = await executeTool(ToolName.GET_FEATURE_FLAGS, {}, makeSources());
    expect(content).toEqual({ usageAnalysisEnabled: false, policyEnforcerEnabled: true });
  });
});

describe('executeTool — preview_policy (read-only)', () => {
  it('returns found:false for a missing policy', async () => {
    const { content } = await executeTool(ToolName.PREVIEW_POLICY, { policyName: 'nope' }, makeSources());
    expect(content).toMatchObject({ found: false, policyName: 'nope' });
  });

  it('returns the preview payload when present', async () => {
    const { content } = await executeTool(
      ToolName.PREVIEW_POLICY,
      { policyName: 'p1' },
      makeSources({ previewPolicy: vi.fn(async () => ({ actions: ['s3:GetObject'] })) }),
    );
    expect(content).toMatchObject({ found: true, preview: { actions: ['s3:GetObject'] } });
  });
});

describe('executeTool — propose_write is a NON-mutating gate', () => {
  it('echoes a writeProposal and performs no write', async () => {
    const sources = makeSources();
    const result = await executeTool(
      ToolName.PROPOSE_WRITE,
      {
        kind: ProposableWriteKind.CREATE_POLICY,
        summary: 'Create policy denying eu-west-1',
        payload: { policyName: 'p' },
      },
      sources,
    );
    expect(result.writeProposal).toEqual({
      kind: ProposableWriteKind.CREATE_POLICY,
      summary: 'Create policy denying eu-west-1',
      payload: { policyName: 'p' },
    });
    expect(result.content).toMatchObject({ proposed: true });
    // No data source other than read paths should ever be a mutation — there are none.
    // Assert the executor did not call any loader as a side effect of proposing.
    expect(sources.loadProducts).not.toHaveBeenCalled();
  });
});

describe('executeTool — unknown tool', () => {
  it('throws on an unrecognized tool name', async () => {
    await expect(executeTool('not_a_tool', {}, makeSources())).rejects.toThrow(/Unknown tool/);
  });
});
