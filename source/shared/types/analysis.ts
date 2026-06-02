/**
 * Step Functions execution status surfaced in the analyze API response.
 * Mirrors the subset of AWS Step Functions execution states the API
 * routes return — RUNNING, SUCCEEDED, FAILED — for clients polling
 * `GET /analysis?executionArn=...`.
 */
export enum ExecutionStatus {
  RUNNING = 'RUNNING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

/**
 * Analyzers that the usage-analysis state machine can run.
 * Used in the `analyzers` array of `POST /analysis`.
 */
export enum AnalyzerType {
  CLOUDTRAIL = 'cloudtrail',
  RESOURCE_EXPLORER = 'resourceExplorer',
  CLOUDFORMATION = 'cloudformation',
}
