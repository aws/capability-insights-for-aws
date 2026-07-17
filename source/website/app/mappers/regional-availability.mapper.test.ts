import { describe, expect, it } from 'vitest';
import { ProductType, type Product } from '@capability-insights/shared/types/capability/product';
import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type { CfnResource } from '@capability-insights/shared/types/capability/cfn';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import { RegionalAvailabilityType } from '@capability-insights/shared/types/availability/regional-availability';
import { fromProducts, fromApiServices, fromCfnResources } from './regional-availability.mapper';

const AVAILABLE = { 'us-east-1': AvailabilityStatus.AVAILABLE };
const PLANNING = { 'us-east-1': AvailabilityStatus.PLANNING };

/** Mirrors the real Route 53 shape: a service whose children mix features and services. */
function route53Fixture(): Product[] {
  return [
    {
      productId: 'route-53',
      productName: 'Amazon Route 53',
      productType: ProductType.SERVICE,
      homepage: 'https://aws.amazon.com/route53/',
      regionalAvailability: AVAILABLE,
      launchDates: { 'us-east-1': '2010-12-05' },
      childProducts: [
        {
          productId: 'route-53-domains',
          productName: 'Route 53 Domains',
          productType: ProductType.FEATURE,
          regionalAvailability: AVAILABLE,
        },
        {
          productId: 'route-53-resolver-endpoints',
          productName: 'Route 53 Resolver Endpoints',
          productType: ProductType.SERVICE,
          homepage: 'https://aws.amazon.com/route53/resolver/',
          regionalAvailability: PLANNING,
          childProducts: [
            {
              productId: 'doh-endpoints',
              productName: 'DoH Endpoints',
              productType: ProductType.FEATURE,
              regionalAvailability: AVAILABLE,
            },
            {
              productId: 'ipv6-inbound',
              productName: 'Support IPv6-only Inbound Endpoints',
              productType: ProductType.FEATURE,
              regionalAvailability: PLANNING,
            },
          ],
        },
      ],
    },
  ];
}

describe('fromProducts', () => {
  it('returns an empty array for empty input', () => {
    expect(fromProducts([])).toEqual([]);
  });

  it('maps a childless top-level service to a single root row', () => {
    const rows = fromProducts([
      {
        productId: 's3',
        productName: 'Amazon S3',
        productType: ProductType.SERVICE,
        regionalAvailability: AVAILABLE,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 's3',
      parentId: null,
      name: 'Amazon S3',
      regionalAvailabilityType: RegionalAvailabilityType.SERVICE,
    });
  });

  it('maps feature children under their parent, keeping their productId as row id', () => {
    const rows = fromProducts(route53Fixture());
    const domains = rows.find(r => r.name === 'Route 53 Domains');
    expect(domains).toMatchObject({
      id: 'route-53-domains',
      parentId: 'route-53',
      regionalAvailabilityType: RegionalAvailabilityType.FEATURE,
    });
  });

  it('emits a child service twice: as a leaf under its parent and as its own root row', () => {
    const rows = fromProducts(route53Fixture());
    const instances = rows.filter(r => r.name === 'Route 53 Resolver Endpoints');
    expect(instances).toHaveLength(2);

    const leaf = instances.find(r => r.parentId === 'route-53');
    const root = instances.find(r => r.parentId === null);

    // Leaf instance under the parent uses a synthetic id so row ids stay unique.
    expect(leaf).toMatchObject({
      id: 'route-53:route-53-resolver-endpoints',
      regionalAvailabilityType: RegionalAvailabilityType.SERVICE,
    });
    // Root instance keeps the canonical productId so its children can attach to it.
    expect(root).toMatchObject({ id: 'route-53-resolver-endpoints' });
  });

  it('attaches grandchild features to the promoted root row, not to the leaf instance', () => {
    const rows = fromProducts(route53Fixture());
    const doh = rows.find(r => r.name === 'DoH Endpoints');
    const ipv6 = rows.find(r => r.name === 'Support IPv6-only Inbound Endpoints');
    expect(doh?.parentId).toBe('route-53-resolver-endpoints');
    expect(ipv6?.parentId).toBe('route-53-resolver-endpoints');
    // Nothing is parented to the synthetic leaf id.
    expect(rows.some(r => r.parentId === 'route-53:route-53-resolver-endpoints')).toBe(false);
  });

  it('copies availability data onto both instances of a duplicated child service', () => {
    const rows = fromProducts(route53Fixture());
    const instances = rows.filter(r => r.name === 'Route 53 Resolver Endpoints');
    for (const instance of instances) {
      expect(instance.regionalAvailability).toEqual(PLANNING);
      expect(instance.homepageUrl).toBe('https://aws.amazon.com/route53/resolver/');
    }
  });

  it('produces globally unique row ids', () => {
    const rows = fromProducts(route53Fixture());
    const ids = rows.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never produces more than two visual levels (every parentId points at a root row)', () => {
    const rows = fromProducts(route53Fixture());
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const row of rows) {
      if (row.parentId === null) continue;
      const parent = byId.get(row.parentId);
      expect(parent, `parent of ${row.id} must exist in the row set`).toBeDefined();
      expect(parent?.parentId, `parent of ${row.id} must be a root row`).toBeNull();
    }
  });

  it('promotes a childless child service to a root row as well', () => {
    const rows = fromProducts([
      {
        productId: 'dynamodb',
        productName: 'Amazon DynamoDB',
        productType: ProductType.SERVICE,
        regionalAvailability: AVAILABLE,
        childProducts: [
          {
            productId: 'dax',
            productName: 'Amazon DynamoDB Accelerator',
            productType: ProductType.SERVICE,
            regionalAvailability: AVAILABLE,
          },
        ],
      },
    ]);
    const instances = rows.filter(r => r.name === 'Amazon DynamoDB Accelerator');
    expect(instances.map(r => ({ id: r.id, parentId: r.parentId }))).toEqual(
      expect.arrayContaining([
        { id: 'dynamodb:dax', parentId: 'dynamodb' },
        { id: 'dax', parentId: null },
      ]),
    );
  });

  it('handles services nested more than three levels deep by promoting recursively', () => {
    const rows = fromProducts([
      {
        productId: 'a',
        productName: 'A',
        productType: ProductType.SERVICE,
        regionalAvailability: AVAILABLE,
        childProducts: [
          {
            productId: 'b',
            productName: 'B',
            productType: ProductType.SERVICE,
            regionalAvailability: AVAILABLE,
            childProducts: [
              {
                productId: 'c',
                productName: 'C',
                productType: ProductType.SERVICE,
                regionalAvailability: AVAILABLE,
                childProducts: [
                  {
                    productId: 'd',
                    productName: 'D',
                    productType: ProductType.FEATURE,
                    regionalAvailability: AVAILABLE,
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    // Every service becomes a root row; deepest feature hangs off its direct parent.
    expect(rows.filter(r => r.parentId === null).map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(rows.find(r => r.id === 'd')?.parentId).toBe('c');
    // Leaf context rows exist for each nested service.
    expect(rows.find(r => r.id === 'a:b')?.parentId).toBe('a');
    expect(rows.find(r => r.id === 'b:c')?.parentId).toBe('b');
    const ids = rows.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps root-level ordering: promoted services appear after their former parent', () => {
    const rows = fromProducts(route53Fixture());
    const rootIds = rows.filter(r => r.parentId === null).map(r => r.id);
    expect(rootIds).toEqual(['route-53', 'route-53-resolver-endpoints']);
  });
});

describe('fromApiServices (API Operations tab regression)', () => {
  const fixture: ApiService[] = [
    {
      sdkServiceName: 's3',
      sdkServiceFullName: 'Amazon Simple Storage Service',
      productName: 'Amazon S3',
      apis: [
        {
          apiName: 's3:GetObject',
          apiAction: 'GetObject',
          homepage: 'https://docs.aws.amazon.com/s3/GetObject',
          regionalAvailability: AVAILABLE,
        },
        {
          apiName: 's3:PutObject',
          apiAction: 'PutObject',
          homepage: 'https://docs.aws.amazon.com/s3/PutObject',
          regionalAvailability: PLANNING,
        },
      ],
    },
  ];

  it('maps services to prefixed root rows and operations to child rows', () => {
    const rows = fromApiServices(fixture);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      id: 'svc-s3',
      parentId: null,
      name: 'Amazon Simple Storage Service',
      regionalAvailabilityType: RegionalAvailabilityType.SDK_SERVICE,
      sdkServiceName: 's3',
      productName: 'Amazon S3',
    });
    expect(rows[1]).toMatchObject({
      id: 's3:GetObject',
      parentId: 'svc-s3',
      name: 'GetObject',
      regionalAvailabilityType: RegionalAvailabilityType.OPERATION,
      regionalAvailability: AVAILABLE,
    });
    expect(rows[2]).toMatchObject({ id: 's3:PutObject', parentId: 'svc-s3' });
  });

  it('produces exactly two levels with unique ids', () => {
    const rows = fromApiServices(fixture);
    const ids = rows.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const row of rows) {
      if (row.parentId !== null) expect(byId.get(row.parentId)?.parentId).toBeNull();
    }
  });
});

describe('fromCfnResources (CloudFormation Resources tab regression)', () => {
  const fixture: CfnResource[] = [
    {
      serviceName: 'EC2',
      resourceTypes: [
        {
          resourceTypeName: 'AWS::EC2::Instance',
          resourceTypeHomepage: 'https://docs.aws.amazon.com/ec2-instance',
          regionalAvailability: AVAILABLE,
          resourceProperties: [
            {
              resourcePropertyName: 'InstanceType',
              resourceConfigurations: [
                {
                  resourceConfigurationName: 't3.medium',
                  regionalAvailability: AVAILABLE,
                  stacks: ['my-stack'],
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  it('maps the full four-level hierarchy: service, resource type, property, configuration', () => {
    const rows = fromCfnResources(fixture);
    expect(rows.map(r => ({ id: r.id, parentId: r.parentId }))).toEqual([
      { id: 'cfn-EC2', parentId: null },
      { id: 'cfn-EC2-AWS::EC2::Instance', parentId: 'cfn-EC2' },
      { id: 'cfn-EC2-AWS::EC2::Instance-InstanceType', parentId: 'cfn-EC2-AWS::EC2::Instance' },
      {
        id: 'cfn-EC2-AWS::EC2::Instance-InstanceType-t3.medium',
        parentId: 'cfn-EC2-AWS::EC2::Instance-InstanceType',
      },
    ]);
  });

  it('preserves row types and stack attribution', () => {
    const rows = fromCfnResources(fixture);
    expect(rows.map(r => r.regionalAvailabilityType)).toEqual([
      RegionalAvailabilityType.SERVICE,
      RegionalAvailabilityType.RESOURCE_TYPE,
      RegionalAvailabilityType.PROPERTY,
      RegionalAvailabilityType.CONFIGURATION,
    ]);
    expect(rows[3].stacks).toEqual(['my-stack']);
  });

  it('handles resource types without properties', () => {
    const rows = fromCfnResources([
      {
        serviceName: 'SQS',
        resourceTypes: [
          {
            resourceTypeName: 'AWS::SQS::Queue',
            resourceTypeHomepage: 'https://docs.aws.amazon.com/sqs-queue',
            regionalAvailability: AVAILABLE,
          },
        ],
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ id: 'cfn-SQS-AWS::SQS::Queue', parentId: 'cfn-SQS' });
  });
});
