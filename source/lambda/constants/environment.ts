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
  /**
   * Configured CloudTrail bucket from the Usage Analysis stack. When set, the
   * analyze route uses it as a fallback if the request body omits
   * `analyzerParams.cloudtrail.bucket`. This lets the UI trigger analysis
   * without re-prompting for the bucket every time.
   */
  CONFIGURED_CLOUDTRAIL_BUCKET: 'CONFIGURED_CLOUDTRAIL_BUCKET',
  /**
   * When `"true"` (default), the usage decorator includes all `childProducts`
   * (features) for every service kept in the personalized view — even features
   * not individually detected as used. Set to `"false"` to narrow each service
   * to only the features directly observed in usage data.
   */
  INCLUDE_ALL_FEATURES_PER_SERVICE: 'INCLUDE_ALL_FEATURES_PER_SERVICE',
  /**
   * DynamoDB table name for the Policy Enforcer's `PolicyConfiguration`
   * records. Set by the `CapabilityInsightsPolicyEnforcerStack` when the
   * `--enable-policy-enforcer` deploy flag is used. Absent otherwise.
   */
  POLICY_TABLE_NAME: 'POLICY_TABLE_NAME',
  /**
   * Name of the out-of-VPC IAM Helper Lambda that performs `iam:*Policy*`
   * mutations on behalf of the in-VPC API Lambda. IAM has no VPC endpoint,
   * so the helper exists outside the VPC and is invoked over the Lambda VPC
   * endpoint. Set by the Policy Enforcer stack.
   */
  IAM_HELPER_LAMBDA_NAME: 'IAM_HELPER_LAMBDA_NAME',
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
