import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import createWrapper from '@cloudscape-design/components/test-utils/dom';
import type { TableWrapper } from '@cloudscape-design/components/test-utils/dom';
import { ProductType, type Product } from '@capability-insights/shared/types/capability/product';
import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type { CfnResource } from '@capability-insights/shared/types/capability/cfn';
import type { Region } from '@capability-insights/shared/types/capability/region';
import type { RegionalAvailability } from '@capability-insights/shared/types/availability/regional-availability';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import { fromProducts, fromApiServices, fromCfnResources } from '~/mappers/regional-availability.mapper';
import AvailabilityTable from './availability-table';

const REGIONS: Region[] = [
  {
    Region: 'us-east-1',
    RegionLongName: 'US East (N. Virginia)',
    Partition: 'aws',
    RegionStatus: 'AVAILABLE',
    RequireRegionOptIn: false,
  },
];

const AVAILABLE = { 'us-east-1': AvailabilityStatus.AVAILABLE };

const DOWNLOAD_URLS = { json: '/data/json/test.json', csv: '/data/csv/test.csv' };

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
              regionalAvailability: AVAILABLE,
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

function renderTable(rows: RegionalAvailability[], title = 'Services'): TableWrapper {
  const { container } = render(
    <AvailabilityTable
      title={title}
      nameHeader="Name"
      nameCell={row => row.name}
      regions={REGIONS}
      regionalAvailability={rows}
      downloadUrls={DOWNLOAD_URLS}
    />,
  );
  const table = createWrapper(container).findTable();
  expect(table).not.toBeNull();
  return table!;
}

function rowNames(table: TableWrapper): string[] {
  return table.findRows().map((_row, i) => table.findBodyCell(i + 1, 1)!.getElement().textContent ?? '');
}

function expandRow(table: TableWrapper, rowIndex: number): void {
  act(() => {
    table.findExpandToggle(rowIndex)!.click();
  });
}

describe('AvailabilityTable with product rows', () => {
  it('initially shows only root rows, including promoted child services', () => {
    const table = renderTable(fromProducts(productsFixture()));
    expect(rowNames(table)).toEqual(['Amazon Route 53', 'Amazon Route 53 Private DNS', 'Amazon S3']);
  });

  it('expanding a parent reveals features and the duplicated sub-service leaf', () => {
    const table = renderTable(fromProducts(productsFixture()));
    expandRow(table, 1);
    expect(rowNames(table)).toEqual([
      'Amazon Route 53',
      'Route 53 Domains',
      'Amazon Route 53 Private DNS', // leaf context row under Route 53
      'Amazon Route 53 Private DNS', // promoted root row
      'Amazon S3',
    ]);
  });

  it('the duplicated leaf is not expandable, but the promoted root is', () => {
    const table = renderTable(fromProducts(productsFixture()));
    expandRow(table, 1);
    // Row 3 is the leaf instance under Amazon Route 53: no expand toggle.
    expect(table.findExpandToggle(3)).toBeNull();
    // Row 4 is the promoted root: expandable, revealing its features.
    expect(table.findExpandToggle(4)).not.toBeNull();
    expandRow(table, 4);
    expect(rowNames(table)).toContain('Geolocation Routing');
  });

  it('features of a sub-service stay hidden until its promoted root row is expanded', () => {
    const table = renderTable(fromProducts(productsFixture()));
    expandRow(table, 1);
    expect(rowNames(table)).not.toContain('Geolocation Routing');
  });

  it('expand all reveals every level of the two-layer hierarchy', () => {
    const table = renderTable(fromProducts(productsFixture()));
    const expandAll = createWrapper(table.getElement().parentElement as HTMLElement)
      .findAllButtons()
      .find(b => b.getElement().textContent === 'Expand all');
    act(() => {
      expandAll!.click();
    });
    const names = rowNames(table);
    expect(names).toContain('Route 53 Domains');
    expect(names).toContain('Geolocation Routing');
    // Duplicated service appears exactly twice: leaf + root.
    expect(names.filter(n => n === 'Amazon Route 53 Private DNS')).toHaveLength(2);
  });

  it('counts promoted child services in the header counter as top-level items', () => {
    const rows = fromProducts(productsFixture());
    const table = renderTable(rows);
    // Three root rows: Amazon Route 53, promoted Private DNS, Amazon S3.
    expect(table.findHeaderSlot()!.getElement().textContent).toContain('(3)');
  });
});

describe('AvailabilityTable with API operation rows (API Operations tab regression)', () => {
  const apiFixture: ApiService[] = [
    {
      sdkServiceName: 's3',
      sdkServiceFullName: 'Amazon Simple Storage Service',
      apis: [
        {
          apiName: 's3:GetObject',
          apiAction: 'GetObject',
          homepage: 'https://docs.aws.amazon.com/s3',
          regionalAvailability: AVAILABLE,
        },
      ],
    },
  ];

  it('renders service root rows and expands to operations', () => {
    const table = renderTable(fromApiServices(apiFixture), 'API Operations');
    expect(rowNames(table)).toEqual(['Amazon Simple Storage Service']);
    expandRow(table, 1);
    expect(rowNames(table)).toEqual(['Amazon Simple Storage Service', 'GetObject']);
  });
});

describe('AvailabilityTable with CFN resource rows (CloudFormation Resources tab regression)', () => {
  const cfnFixture: CfnResource[] = [
    {
      serviceName: 'EC2',
      resourceTypes: [
        {
          resourceTypeName: 'AWS::EC2::Instance',
          resourceTypeHomepage: 'https://docs.aws.amazon.com/ec2',
          regionalAvailability: AVAILABLE,
          resourceProperties: [
            {
              resourcePropertyName: 'InstanceType',
              resourceConfigurations: [{ resourceConfigurationName: 't3.medium', regionalAvailability: AVAILABLE }],
            },
          ],
        },
      ],
    },
  ];

  it('renders and expands the full four-level hierarchy', () => {
    const table = renderTable(fromCfnResources(cfnFixture), 'CloudFormation Resources');
    expect(rowNames(table)).toEqual(['EC2']);
    expandRow(table, 1);
    expect(rowNames(table)).toEqual(['EC2', 'AWS::EC2::Instance']);
    expandRow(table, 2);
    expect(rowNames(table)).toContain('InstanceType');
    expandRow(table, 3);
    expect(rowNames(table)).toContain('t3.medium');
  });
});
