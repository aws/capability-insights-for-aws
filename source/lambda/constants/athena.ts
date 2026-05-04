/** Default Athena database and table names for CloudTrail analysis. */
export const AthenaDefaults = {
  DATABASE: 'cloudtrail_analysis',
  TABLE_NAME: 'cloudtrail_logs',
} as const;

/** Athena query execution statuses. */
export const AthenaQueryStatus = {
  RUNNING: 'RUNNING',
  QUEUED: 'QUEUED',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const;
