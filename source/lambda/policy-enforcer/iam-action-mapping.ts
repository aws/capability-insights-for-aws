/**
 * Maps catalog `(sdkServiceName, apiAction)` pairs to their IAM action strings
 * (`prefix:Action`). The IAM service prefix usually doesn't equal the SDK
 * service name, so we resolve in three stages:
 *
 * 1. Override table — explicit mappings for services where neither the SDK
 *    name nor the homepage URL gives the right IAM prefix.
 * 2. AWS CLI documentation URL — most catalog entries include a `homepage`
 *    of the form `…/reference/{prefix}/…` where `{prefix}` is canonically
 *    the IAM prefix.
 * 3. Lowercased SDK name — last-resort fallback, normalized to a
 *    valid prefix shape (no spaces).
 *
 * Override is checked first because for some services (notably CloudWatch /
 * CloudWatch Logs / CloudWatch Events) the homepage points at the SDK group
 * (`monitoring`, `logs`, `events`) but the IAM prefix is something else
 * (`cloudwatch`, `logs`, `events`). The override carries our knowledge of
 * those mismatches.
 */
export const IAM_SERVICE_PREFIX_OVERRIDES: Record<string, string> = {
  // CloudWatch metrics SDK is named "monitoring" but the IAM prefix is "cloudwatch".
  CloudWatch: 'cloudwatch',
  // The catalog "elasticloadbalancingv2" sdkServiceName lives under the same
  // IAM prefix as classic ELB.
  elasticloadbalancingv2: 'elasticloadbalancing',
  // Add more as we discover mismatches in the wild.
};

const HOMEPAGE_PREFIX_PATTERN = /\/reference\/([^/]+)\//;

/**
 * Last-resort normalization: lowercased and with whitespace turned into hyphens
 * so that names like `"ACM PCA"` produce `"acm-pca"` instead of `"acm pca"`.
 * Won't fix every IAM-prefix mismatch but at least produces a syntactically
 * valid IAM action shape.
 */
function normalize(sdkServiceName: string): string {
  return sdkServiceName.toLowerCase().replace(/\s+/g, '-');
}

/**
 * Returns the IAM service prefix for a given catalog entry.
 *
 * Resolution order: override table → homepage URL → normalized SDK name.
 */
export function toIamServicePrefix(sdkServiceName: string, homepage?: string): string {
  const override = IAM_SERVICE_PREFIX_OVERRIDES[sdkServiceName];
  if (override) return override;

  if (homepage) {
    const match = homepage.match(HOMEPAGE_PREFIX_PATTERN);
    if (match) return match[1];
  }

  return normalize(sdkServiceName);
}

/**
 * Returns the IAM action string for a catalog `(sdkServiceName, apiAction)`
 * pair, optionally guided by a `homepage` URL extracted from the API entry.
 *
 * Examples:
 *   toIamAction('s3', 'GetObject') → 's3:GetObject'
 *   toIamAction('CloudWatch', 'PutMetricData', '…/reference/monitoring/…')
 *     → 'cloudwatch:PutMetricData'   // override wins
 *   toIamAction('ACM PCA', 'CreateCertificateAuthority',
 *     '…/reference/acm-pca/create-certificate-authority.html')
 *     → 'acm-pca:CreateCertificateAuthority'  // homepage wins
 */
export function toIamAction(sdkServiceName: string, apiAction: string, homepage?: string): string {
  return `${toIamServicePrefix(sdkServiceName, homepage)}:${apiAction}`;
}
