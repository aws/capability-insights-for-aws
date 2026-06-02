import type { RegionCode } from '@capability-insights/shared/types/capability/region';

/**
 * Shared types for usage analyzer outputs. These shapes are produced by the
 * CloudTrail and CloudFormation analyzer Lambdas and consumed by downstream
 * Lambdas (e.g., the usage decorator).
 */

/**
 * CloudTrail usage data keyed by account ID, then service event source.
 * Produced by the CloudTrail Analyzer Lambda via Athena queries.
 */
export interface CloudTrailUsage {
  [accountId: string]: {
    [eventSource: string]: {
      apis: string[];
      regionApis: Record<RegionCode, string[]>;
    };
  };
}

/**
 * CloudFormation usage data as a flat list of resource records.
 * Produced by the CloudFormation Analyzer Lambda.
 */
export interface CloudFormationUsage {
  accountId: string;
  region: RegionCode;
  records: CloudFormationUsageRecord[];
}

export interface CloudFormationUsageRecord {
  stackName: string;
  serviceName: string;
  resourceTypeName: string;
  properties: Record<string, string[]>;
}
