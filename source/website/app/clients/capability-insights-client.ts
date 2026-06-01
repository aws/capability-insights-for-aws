import type { Region } from '@capability-insights/shared/types/capability/region';
import type { Product } from '@capability-insights/shared/types/capability/product';
import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type { CfnResource } from '@capability-insights/shared/types/capability/cfn';
import type { SyncMetadata } from '@capability-insights/shared/types/sync-metadata';
import type { UsedCapabilities } from '@capability-insights/shared/types/used-capabilities';
import { AnalyzerType, ExecutionStatus } from '@capability-insights/shared/types/analysis';
import { Scope } from '@capability-insights/shared/types/scope';
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

export class AnalysisNotEnabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisNotEnabledError';
  }
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

  /**
   * Triggers a usage analysis run. Returns the executionArn so callers can
   * poll status via {@link getAnalysisStatus}. The CloudTrail bucket comes
   * from the API Lambda's deploy-time configuration; pass `cloudTrailBucket`
   * to override.
   */
  async triggerAnalysis(opts?: { cloudTrailBucket?: string; daysToScan?: number }): Promise<string> {
    const baseUrl = await this.getApiBaseUrl();
    const body: Record<string, unknown> = {
      scope: Scope.ACCOUNT,
      analyzers: [AnalyzerType.CLOUDTRAIL, AnalyzerType.CLOUDFORMATION],
    };
    if (opts?.cloudTrailBucket || opts?.daysToScan) {
      body.analyzerParams = {
        cloudtrail: {
          ...(opts.cloudTrailBucket ? { bucket: opts.cloudTrailBucket } : {}),
          ...(opts.daysToScan ? { daysToScan: opts.daysToScan } : {}),
        },
      };
    }
    const res = await fetch(`${baseUrl}/analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsedMessage = '';
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string };
        parsedMessage = parsed.message || parsed.error || '';
      } catch {
        // text wasn't JSON; fall through with empty parsedMessage
      }
      if (res.status === 503) {
        throw new AnalysisNotEnabledError(
          parsedMessage || 'Usage Analysis is not enabled. Re-run deploy with --enable-usage-analysis.',
        );
      }
      throw new Error(`Analysis request failed: ${res.status}${parsedMessage ? ` ${parsedMessage}` : ''}`);
    }
    const data = (await res.json()) as { executionArn: string };
    return data.executionArn;
  }

  /**
   * Polls the status of a previously-triggered analysis. Returns one of:
   * - `{ status: ExecutionStatus.RUNNING }` while still in progress
   * - the final result object on success (matches the decorator output shape)
   * - `{ status: ExecutionStatus.FAILED, error }` on failure.
   */
  async getAnalysisStatus(
    executionArn: string,
  ): Promise<{ status: ExecutionStatus.RUNNING | ExecutionStatus.FAILED; error?: string } | Record<string, unknown>> {
    const baseUrl = await this.getApiBaseUrl();
    const res = await fetch(`${baseUrl}/analysis?executionArn=${encodeURIComponent(executionArn)}`);
    if (!res.ok) {
      throw new Error(`Status request failed: ${res.status}`);
    }
    return await res.json();
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

  async getLastSyncTime(): Promise<SyncMetadata | null> {
    return await s3Client.fetchJson<SyncMetadata>('/data/sync-metadata.json');
  }

  async getUsedCapabilities(
    scope: 'account' | 'organization' = 'account',
    usageFilter: 'deployed' | 'active_usage' | 'combined' = 'combined',
  ): Promise<UsedCapabilities | null> {
    try {
      const baseUrl = await this.getApiBaseUrl();
      const res = await fetch(`${baseUrl}/capabilities?scope=${scope}&usageFilter=${usageFilter}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
}

export const capabilityInsightsClient = new CapabilityInsightsClient();
