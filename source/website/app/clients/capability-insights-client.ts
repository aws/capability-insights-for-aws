import type { Region } from '@capability-insights/shared/types/capability/region';
import type { Product } from '@capability-insights/shared/types/capability/product';
import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type { CfnResource } from '@capability-insights/shared/types/capability/cfn';
import { s3Client } from './s3-client';

export enum DataFormat {
  JSON = 'json',
  CSV = 'csv',
}

export enum DataFile {
  REGIONS = 'regions',
  PRODUCTS = 'products',
  APIS = 'apis',
  CFN_RESOURCES = 'cfn_resources',
}

export interface ExportUrls {
  json: string;
  csv: string;
}

export class CapabilityInsightsClient {
  private cachedBaseUrl: string | null = null;

  private getDataUrl(name: DataFile, format: DataFormat): string {
    return `/data/${format}/${name}.${format}`;
  }

  private async getApiBaseUrl(): Promise<string> {
    if (this.cachedBaseUrl) return this.cachedBaseUrl;
    const config = await s3Client.fetchJson<{ apiBaseUrl: string }>('/api-config.json');
    this.cachedBaseUrl = config.apiBaseUrl;
    return this.cachedBaseUrl;
  }

  exportUrls(name: DataFile): ExportUrls {
    return {
      json: this.getDataUrl(name, DataFormat.JSON),
      csv: this.getDataUrl(name, DataFormat.CSV),
    };
  }

  async syncCapabilityData(): Promise<void> {
    const baseUrl = await this.getApiBaseUrl();
    const res = await fetch(`${baseUrl}/syncCapabilityData`, { method: 'POST' });
    if (!res.ok) throw new Error(`Sync request failed: ${res.status}`);
  }

  async listRegions(): Promise<Region[]> {
    return s3Client.fetchJson(this.getDataUrl(DataFile.REGIONS, DataFormat.JSON));
  }

  async listProducts(): Promise<Product[]> {
    return s3Client.fetchJson(this.getDataUrl(DataFile.PRODUCTS, DataFormat.JSON));
  }

  async listApiOperations(): Promise<ApiService[]> {
    return s3Client.fetchJson(this.getDataUrl(DataFile.APIS, DataFormat.JSON));
  }

  async listCfnResources(): Promise<CfnResource[]> {
    return s3Client.fetchJson(this.getDataUrl(DataFile.CFN_RESOURCES, DataFormat.JSON));
  }
}

export const capabilityInsightsClient = new CapabilityInsightsClient();
