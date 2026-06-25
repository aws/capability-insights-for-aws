import { describe, it, expect } from 'vitest';
import {
  isAvailableIn,
  availableRegions,
  flattenProducts,
  isProductAvailable,
  findProducts,
  productsAvailableInRegion,
  productsNotAvailableInRegion,
  diffRegions,
  usedButUnavailable,
} from '@capability-insights/shared/types/capability-query';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import { ProductType, type Product } from '@capability-insights/shared/types/capability/product';
import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type { CfnResource } from '@capability-insights/shared/types/capability/cfn';
import type { UsedCapabilities } from '@capability-insights/shared/types/used-capabilities';

const A = AvailabilityStatus.AVAILABLE;
const P = AvailabilityStatus.PLANNED;
const NA = AvailabilityStatus.NOT_AVAILABLE;

const IAD = 'us-east-1';
const PDX = 'us-west-2';
const DUB = 'eu-west-1';

function product(
  productId: string,
  productName: string,
  avail: Record<string, AvailabilityStatus>,
  childProducts?: Product[],
): Product {
  return { productId, productName, productType: ProductType.SERVICE, regionalAvailability: avail, childProducts };
}

describe('isAvailableIn', () => {
  it('is true only for AVAILABLE status', () => {
    expect(isAvailableIn({ [IAD]: A }, IAD)).toBe(true);
  });

  it('treats every non-AVAILABLE status as not available', () => {
    expect(isAvailableIn({ [IAD]: P }, IAD)).toBe(false);
    expect(isAvailableIn({ [IAD]: NA }, IAD)).toBe(false);
    expect(isAvailableIn({ [IAD]: AvailabilityStatus.PLANNING }, IAD)).toBe(false);
    expect(isAvailableIn({ [IAD]: AvailabilityStatus.NOT_EXPANDING }, IAD)).toBe(false);
  });

  it('treats missing region key as not available', () => {
    expect(isAvailableIn({ [IAD]: A }, PDX)).toBe(false);
  });

  it('treats missing/undefined map as not available (no throw)', () => {
    expect(isAvailableIn(undefined, IAD)).toBe(false);
    expect(isAvailableIn({}, IAD)).toBe(false);
  });
});

describe('availableRegions', () => {
  it('returns only AVAILABLE regions, sorted', () => {
    expect(availableRegions({ [PDX]: A, [IAD]: A, [DUB]: P })).toEqual([IAD, PDX]);
  });

  it('returns [] for undefined map', () => {
    expect(availableRegions(undefined)).toEqual([]);
  });
});

describe('flattenProducts', () => {
  it('includes nested child products (features) depth-first', () => {
    const feature = product('p2', 'Feature', { [IAD]: A });
    const svc = product('p1', 'Service', { [IAD]: A }, [feature]);
    const flat = flattenProducts([svc]);
    expect(flat.map(p => p.productId)).toEqual(['p1', 'p2']);
  });

  it('handles multiple levels of nesting', () => {
    const grandchild = product('p3', 'GC', { [IAD]: A });
    const child = product('p2', 'C', { [IAD]: A }, [grandchild]);
    const root = product('p1', 'R', { [IAD]: A }, [child]);
    expect(flattenProducts([root]).map(p => p.productId)).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('isProductAvailable', () => {
  it('reflects the product regionalAvailability', () => {
    const p = product('p1', 'S3', { [IAD]: A, [PDX]: P });
    expect(isProductAvailable(p, IAD)).toBe(true);
    expect(isProductAvailable(p, PDX)).toBe(false);
  });
});

describe('findProducts', () => {
  const products = [
    product('amazon-s3', 'Amazon S3', { [IAD]: A }),
    product('amazon-ec2', 'Amazon EC2', { [IAD]: A }, [product('ec2-spot', 'EC2 Spot', { [IAD]: A })]),
  ];

  it('matches by case-insensitive name substring', () => {
    expect(findProducts(products, 's3').map(p => p.productId)).toEqual(['amazon-s3']);
    expect(
      findProducts(products, 'AMAZON')
        .map(p => p.productId)
        .sort(),
    ).toEqual(['amazon-ec2', 'amazon-s3']);
  });

  it('matches features in the nested tree', () => {
    expect(findProducts(products, 'spot').map(p => p.productId)).toEqual(['ec2-spot']);
  });

  it('matches by exact productId', () => {
    expect(findProducts(products, 'amazon-ec2').map(p => p.productId)).toEqual(['amazon-ec2']);
  });

  it('returns [] for blank query rather than everything', () => {
    expect(findProducts(products, '   ')).toEqual([]);
    expect(findProducts(products, '')).toEqual([]);
  });
});

describe('productsAvailableInRegion / productsNotAvailableInRegion', () => {
  const products = [
    product('a', 'A', { [IAD]: A, [PDX]: NA }),
    product('b', 'B', { [IAD]: P, [PDX]: A }),
    product('c', 'C', { [IAD]: A }, [product('c1', 'C1', { [PDX]: A })]),
  ];

  it('partitions correctly and is exhaustive (available + not = all flattened)', () => {
    const avail = productsAvailableInRegion(products, IAD)
      .map(p => p.productId)
      .sort();
    const notAvail = productsNotAvailableInRegion(products, IAD)
      .map(p => p.productId)
      .sort();
    expect(avail).toEqual(['a', 'c']);
    expect(notAvail).toEqual(['b', 'c1']);
    // exhaustiveness: every flattened product is in exactly one bucket
    expect([...avail, ...notAvail].sort()).toEqual(['a', 'b', 'c', 'c1']);
  });
});

describe('diffRegions', () => {
  const items = [
    { id: 'both', regionalAvailability: { [IAD]: A, [PDX]: A } },
    { id: 'onlyA', regionalAvailability: { [IAD]: A, [PDX]: P } },
    { id: 'onlyB', regionalAvailability: { [IAD]: NA, [PDX]: A } },
    { id: 'neither', regionalAvailability: { [IAD]: P, [PDX]: NA } },
    { id: 'emptyMap', regionalAvailability: {} },
  ];

  it('partitions items into the four buckets', () => {
    const d = diffRegions(items, IAD, PDX);
    expect(d.regionA).toBe(IAD);
    expect(d.regionB).toBe(PDX);
    expect(d.inBoth.map(i => i.id)).toEqual(['both']);
    expect(d.onlyInA.map(i => i.id)).toEqual(['onlyA']);
    expect(d.onlyInB.map(i => i.id)).toEqual(['onlyB']);
    expect(d.inNeither.map(i => i.id).sort()).toEqual(['emptyMap', 'neither']);
  });

  it('is exhaustive — every item lands in exactly one bucket', () => {
    const d = diffRegions(items, IAD, PDX);
    const total = d.inBoth.length + d.onlyInA.length + d.onlyInB.length + d.inNeither.length;
    expect(total).toBe(items.length);
  });

  it('works generically for empty input', () => {
    const d = diffRegions([], IAD, PDX);
    expect(d.inBoth).toEqual([]);
    expect(d.inNeither).toEqual([]);
  });
});

describe('usedButUnavailable', () => {
  const used: UsedCapabilities = {
    products: [
      product('used-svc', 'Used Service', { [IAD]: A, [DUB]: NA }, [
        product('used-feat', 'Used Feature', { [IAD]: A, [DUB]: A }),
      ]),
    ],
    apis: [
      {
        sdkServiceName: 's3',
        sdkServiceFullName: 'Amazon S3',
        apis: [
          { apiName: 's3', apiAction: 'GetObject', homepage: '', regionalAvailability: { [IAD]: A, [DUB]: A } },
          { apiName: 's3', apiAction: 'NewFancyOp', homepage: '', regionalAvailability: { [IAD]: A, [DUB]: P } },
        ],
      } as ApiService,
    ],
    cfnResources: [
      {
        serviceName: 'AWS::S3',
        resourceTypes: [
          {
            resourceTypeName: 'AWS::S3::Bucket',
            resourceTypeHomepage: '',
            regionalAvailability: { [IAD]: A, [DUB]: NA },
          },
        ],
      } as CfnResource,
    ],
    lastAnalyzedAt: '2026-06-19T00:00:00.000Z',
  };

  it('finds nothing unavailable in a fully-covered region', () => {
    const [gap] = usedButUnavailable(used, [IAD]);
    expect(gap.targetRegion).toBe(IAD);
    expect(gap.unavailableProducts).toEqual([]);
    expect(gap.unavailableApis).toEqual([]);
    expect(gap.unavailableCfnResourceTypes).toEqual([]);
  });

  it('reports the specific gaps for a partially-covered target region', () => {
    const [gap] = usedButUnavailable(used, [DUB]);
    expect(gap.targetRegion).toBe(DUB);
    // parent service is NA in DUB (the nested feature IS available, so only the parent)
    expect(gap.unavailableProducts.map(p => p.productId)).toEqual(['used-svc']);
    // only the planned op is a gap
    expect(gap.unavailableApis.map(a => a.operation.apiAction)).toEqual(['NewFancyOp']);
    expect(gap.unavailableApis[0].service.sdkServiceName).toBe('s3');
    // the bucket resource type is NA in DUB
    expect(gap.unavailableCfnResourceTypes.map(c => c.resourceType.resourceTypeName)).toEqual(['AWS::S3::Bucket']);
  });

  it('returns one gap entry per target region, in order', () => {
    const gaps = usedButUnavailable(used, [IAD, DUB]);
    expect(gaps.map(g => g.targetRegion)).toEqual([IAD, DUB]);
  });
});
