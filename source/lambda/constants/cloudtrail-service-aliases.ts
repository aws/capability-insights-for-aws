/**
 * Known mismatches between CloudTrail event source names and the
 * sdkServiceName values in apis.json.
 *
 * CloudTrail uses "public slug" style names (e.g., `monitoring.amazonaws.com`)
 * while apis.json uses SDK client names (e.g., `CloudWatch`). This map
 * bridges the most common mismatches so usage decoration can resolve them.
 *
 * Keys: the cleaned CloudTrail event source (lowercase, `.amazonaws.com` stripped)
 * Values: the corresponding sdkServiceName as used in apis.json, lowercased
 *
 * Services omitted: services that have no entry in apis.json at all
 * (e.g., Auto Scaling, EventBridge, STS) can't be mapped here — adding
 * them wouldn't help until apis.json gains matching entries.
 *
 * Maintenance: when a new CloudTrail source is observed that doesn't
 * resolve, check apis.json for the matching sdkServiceName and add an
 * entry here. A build-time generator sourced from AWS SDK metadata is
 * tracked as a follow-up (see PR #11 discussion).
 */
export const CLOUDTRAIL_SERVICE_ALIASES: Record<string, string> = {
  // Compute / application
  elasticloadbalancing: 'elastic load balancing',
  elasticmapreduce: 'emr',
  elasticfilesystem: 'efs',

  // Observability / management
  monitoring: 'cloudwatch',
  logs: 'cloudwatch logs',
  states: 'sfn',
  config: 'config service',

  // Database
  dms: 'database migration service',

  // Security / identity
  'cognito-identity': 'cognito identity',
  'cognito-idp': 'cognito identity', // same product as cognito-identity

  // Networking
  route53: 'route 53',

  // Messaging
  amazonmq: 'mq',

  // Data
  es: 'elasticsearch service', // CloudTrail uses "es" for OpenSearch (formerly Elasticsearch)
  airflow: 'mwaa',
  inspector: 'inspector2',
};
