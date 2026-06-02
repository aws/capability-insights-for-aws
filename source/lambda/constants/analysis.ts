/**
 * Lambda-local copies of the analyze API enums. Mirrors
 * `source/shared/types/analysis.ts` (which the website value-imports). They
 * are duplicated here because the lambda runtime bundle does not include the
 * shared workspace package — the existing convention in this repo is for
 * lambda code to use its own local constants and import shared definitions
 * only at the type level.
 */

export const ExecutionStatus = {
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const;

export type ExecutionStatus = (typeof ExecutionStatus)[keyof typeof ExecutionStatus];

export const AnalyzerType = {
  CLOUDTRAIL: 'cloudtrail',
  RESOURCE_EXPLORER: 'resourceExplorer',
  CLOUDFORMATION: 'cloudformation',
} as const;

export type AnalyzerType = (typeof AnalyzerType)[keyof typeof AnalyzerType];
