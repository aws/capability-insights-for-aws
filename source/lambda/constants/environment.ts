export const EnvironmentKey = {
  WEBSITE_BUCKET_NAME: 'WEBSITE_BUCKET_NAME',
  DATA_BUCKET_NAME: 'DATA_BUCKET_NAME',
  DATA_BUCKET_PATH: 'DATA_BUCKET_PATH',
  SOURCE_ACCESS_POINT_ARN: 'SOURCE_ACCESS_POINT_ARN',
  SOURCE_FOLDERS: 'SOURCE_FOLDERS',
  DATA_FETCH_LAMBDA_NAME: 'DATA_FETCH_LAMBDA_NAME',
  CLOUDTRAIL_ANALYZER_LAMBDA_NAME: 'CLOUDTRAIL_ANALYZER_LAMBDA_NAME',
  // TODO: Add these to the usage-analysis-stack and insights stack env vars once the analyzers are implemented
  RESOURCE_EXPLORER_ANALYZER_LAMBDA_NAME: 'RESOURCE_EXPLORER_ANALYZER_LAMBDA_NAME',
  CLOUDFORMATION_ANALYZER_LAMBDA_NAME: 'CLOUDFORMATION_ANALYZER_LAMBDA_NAME',
  ANALYSIS_STATE_MACHINE_ARN: 'ANALYSIS_STATE_MACHINE_ARN',
} as const;

export type EnvironmentKey = (typeof EnvironmentKey)[keyof typeof EnvironmentKey];

export function getEnv(key: EnvironmentKey): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

/** Returns the environment variable value or a fallback if not set. */
export function getOptionalEnv(key: EnvironmentKey, fallback = ''): string {
  return process.env[key] ?? fallback;
}
