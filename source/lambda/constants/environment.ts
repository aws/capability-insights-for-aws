export const EnvironmentKey = {
  WEBSITE_BUCKET_NAME: 'WEBSITE_BUCKET_NAME',
  DATA_BUCKET_NAME: 'DATA_BUCKET_NAME',
  DATA_BUCKET_PATH: 'DATA_BUCKET_PATH',
  SOURCE_ACCESS_POINT_ARN: 'SOURCE_ACCESS_POINT_ARN',
  SOURCE_FOLDERS: 'SOURCE_FOLDERS',
  DATA_FETCH_LAMBDA_NAME: 'DATA_FETCH_LAMBDA_NAME',
} as const;

export type EnvironmentKey = (typeof EnvironmentKey)[keyof typeof EnvironmentKey];

export function getEnv(key: EnvironmentKey): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}
