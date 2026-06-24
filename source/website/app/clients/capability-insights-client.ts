import type { Region } from '@capability-insights/shared/types/capability/region';
import type { Product } from '@capability-insights/shared/types/capability/product';
import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type { CfnResource } from '@capability-insights/shared/types/capability/cfn';
import type { SyncMetadata } from '@capability-insights/shared/types/sync-metadata';
import type { UsedCapabilities } from '@capability-insights/shared/types/used-capabilities';
import type { FeatureFlags } from '@capability-insights/shared/types/feature-flags';
import type { PolicyConfiguration } from '@capability-insights/shared/types/policy-enforcer/policy-configuration';
import type {
  RefreshResponse,
  CreatePolicyRequest,
  PreviewResponse,
} from '@capability-insights/shared/types/policy-enforcer/policy-api';
import { AnalyzerType, ExecutionStatus } from '@capability-insights/shared/types/analysis';
import { Scope } from '@capability-insights/shared/types/scope';
import type { ConverseTurn, ChatResponse } from '~/types/chat';
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

export class ChatNotEnabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatNotEnabledError';
  }
}

export class PolicyEnforcerNotEnabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyEnforcerNotEnabledError';
  }
}

export class PolicyNameConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyNameConflictError';
  }
}

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyValidationError';
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

  async refreshAllPolicies(): Promise<{ message: string; total: number }> {
    const baseUrl = await this.getApiBaseUrl();
    const res = await fetch(`${baseUrl}/policies/refresh-all`, { method: 'POST' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsedMessage = '';
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string };
        parsedMessage = parsed.message || parsed.error || '';
      } catch {
        // text wasn't JSON; fall through
      }
      if (res.status === 503) {
        throw new PolicyEnforcerNotEnabledError(
          parsedMessage || 'Policy Enforcer is not enabled. Re-run deploy with --enable-policy-enforcer.',
        );
      }
      throw new Error(`Refresh-all request failed: ${res.status}${parsedMessage ? ` ${parsedMessage}` : ''}`);
    }
    return (await res.json()) as { message: string; total: number };
  }

  /**
   * Lists all policies.
   */
  async listPolicies(params?: {
    search?: string;
    tagKey?: string;
    tagValue?: string;
    status?: string;
  }): Promise<PolicyConfiguration[]> {
    const baseUrl = await this.getApiBaseUrl();
    const url = new URL(`${baseUrl}/policies`);
    if (params?.search) url.searchParams.set('search', params.search);
    if (params?.tagKey) url.searchParams.set('tagKey', params.tagKey);
    if (params?.tagValue) url.searchParams.set('tagValue', params.tagValue);
    if (params?.status) url.searchParams.set('status', params.status);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`List policies failed: ${res.status}`);
    const data = (await res.json()) as { policies: PolicyConfiguration[] };
    return data.policies;
  }

  async refreshPolicy(policyName: string): Promise<RefreshResponse> {
    const baseUrl = await this.getApiBaseUrl();
    const res = await fetch(`${baseUrl}/policies/${encodeURIComponent(policyName)}/refresh`, { method: 'POST' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Refresh failed: ${res.status}${text ? ` ${text}` : ''}`);
    }
    return (await res.json()) as RefreshResponse;
  }

  /**
   * Creates a new policy. Returns the created policy configuration.
   * Throws on 400 (validation) or 409 (name conflict).
   */
  async createPolicy(
    request: CreatePolicyRequest,
  ): Promise<{ policy: PolicyConfiguration; refresh?: RefreshResponse }> {
    const baseUrl = await this.getApiBaseUrl();
    const res = await fetch(`${baseUrl}/policies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsedMessage = '';
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string };
        parsedMessage = parsed.message || parsed.error || '';
      } catch {
        // not JSON
      }
      if (res.status === 409) {
        throw new PolicyNameConflictError(parsedMessage || 'A policy with this name already exists.');
      }
      if (res.status === 400) {
        throw new PolicyValidationError(parsedMessage || 'Invalid policy configuration.');
      }
      throw new Error(`Create policy failed: ${res.status}${parsedMessage ? ` ${parsedMessage}` : ''}`);
    }
    return (await res.json()) as { policy: PolicyConfiguration; refresh?: RefreshResponse };
  }

  async getPolicy(policyName: string): Promise<PolicyConfiguration> {
    const baseUrl = await this.getApiBaseUrl();
    const res = await fetch(`${baseUrl}/policies/${encodeURIComponent(policyName)}`);
    if (!res.ok) throw new Error(`Get policy failed: ${res.status}`);
    const data = (await res.json()) as { policy: PolicyConfiguration };
    return data.policy;
  }

  async previewPolicy(policyName: string): Promise<PreviewResponse> {
    const baseUrl = await this.getApiBaseUrl();
    const res = await fetch(`${baseUrl}/policies/${encodeURIComponent(policyName)}/preview`);
    if (!res.ok) throw new Error(`Preview failed: ${res.status}`);
    return (await res.json()) as PreviewResponse;
  }

  async deletePolicy(policyName: string): Promise<void> {
    const baseUrl = await this.getApiBaseUrl();
    const res = await fetch(`${baseUrl}/policies/${encodeURIComponent(policyName)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
  }

  /**
   * Returns the deploy-time state of every opt-in feature in one fetch.
   *
   * Used by the UI to decide whether to surface feature controls (e.g. the
   * My Stuff toggle, Policy Enforcer nav link). The backend caches the
   * response for 60s, so calling this on every page mount is cheap.
   *
   * Returns `null` if the API is unreachable. Callers should treat null as
   * "all features unknown" and render a conservative fallback (typically:
   * disabled controls until the next refresh).
   */
  async getFeatureFlags(): Promise<FeatureFlags | null> {
    try {
      const baseUrl = await this.getApiBaseUrl();
      const res = await fetch(`${baseUrl}/features`);
      if (!res.ok) return null;
      return (await res.json()) as FeatureFlags;
    } catch {
      return null;
    }
  }

  /**
   * Sends one chat turn to the conversational assistant. `history` is the
   * prior turns (text only); the server runs the Bedrock agent loop and may
   * return a `writeProposal` the UI must confirm. Throws ChatNotEnabledError
   * on 503 (Chat stack not deployed).
   */
  async chat(message: string, history: ConverseTurn[] = [], pageName?: string): Promise<ChatResponse> {
    const baseUrl = await this.getApiBaseUrl();
    const res = await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history, pageName }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsedMessage = '';
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string };
        parsedMessage = parsed.message || parsed.error || '';
      } catch {
        // not JSON
      }
      if (res.status === 503) {
        throw new ChatNotEnabledError(parsedMessage || 'Chat is not enabled. Re-run deploy with --enable-chat.');
      }
      throw new Error(`Chat request failed: ${res.status}${parsedMessage ? ` ${parsedMessage}` : ''}`);
    }
    return (await res.json()) as ChatResponse;
  }
}

export const capabilityInsightsClient = new CapabilityInsightsClient();
