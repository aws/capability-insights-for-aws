import { describe, it, expect } from 'vitest';
import { toIamAction, toIamServicePrefix, IAM_SERVICE_PREFIX_OVERRIDES } from './iam-action-mapping';

describe('toIamServicePrefix — resolution order', () => {
  it('uses the override when one exists, even if the homepage disagrees', () => {
    // CloudWatch's homepage points at "monitoring" but IAM prefix is "cloudwatch".
    expect(
      toIamServicePrefix(
        'CloudWatch',
        'https://awscli.amazonaws.com/v2/documentation/api/latest/reference/monitoring/put-metric-data.html',
      ),
    ).toBe('cloudwatch');
  });

  it('falls back to the homepage when no override exists', () => {
    expect(
      toIamServicePrefix(
        'ACM PCA',
        'https://awscli.amazonaws.com/v2/documentation/api/latest/reference/acm-pca/create-certificate-authority.html',
      ),
    ).toBe('acm-pca');
  });

  it('falls back to the normalized SDK name when neither override nor homepage matches', () => {
    expect(toIamServicePrefix('s3')).toBe('s3');
    expect(toIamServicePrefix('rds-data')).toBe('rds-data');
  });

  it('normalizes spaces to hyphens in the last-resort fallback', () => {
    expect(toIamServicePrefix('ACM PCA')).toBe('acm-pca');
    expect(toIamServicePrefix('Application Auto Scaling')).toBe('application-auto-scaling');
  });
});

describe('toIamAction', () => {
  it('passes through service names that have no override or homepage', () => {
    expect(toIamAction('s3', 'GetObject')).toBe('s3:GetObject');
    expect(toIamAction('ec2', 'DescribeInstances')).toBe('ec2:DescribeInstances');
  });

  it('uses the override even if a homepage is provided', () => {
    expect(
      toIamAction(
        'CloudWatch',
        'PutMetricData',
        'https://awscli.amazonaws.com/v2/documentation/api/latest/reference/monitoring/put-metric-data.html',
      ),
    ).toBe('cloudwatch:PutMetricData');
  });

  it('extracts the IAM prefix from the homepage URL when no override matches', () => {
    expect(
      toIamAction(
        'ACM PCA',
        'CreateCertificateAuthority',
        'https://awscli.amazonaws.com/v2/documentation/api/latest/reference/acm-pca/create-certificate-authority.html',
      ),
    ).toBe('acm-pca:CreateCertificateAuthority');
  });

  it('preserves the action name verbatim', () => {
    expect(toIamAction('s3', 'X')).toBe('s3:X');
    expect(toIamAction('ec2', 'AssociateIamInstanceProfile')).toBe('ec2:AssociateIamInstanceProfile');
  });
});

describe('IAM_SERVICE_PREFIX_OVERRIDES', () => {
  it('has expected known overrides', () => {
    expect(IAM_SERVICE_PREFIX_OVERRIDES.CloudWatch).toBe('cloudwatch');
    expect(IAM_SERVICE_PREFIX_OVERRIDES.elasticloadbalancingv2).toBe('elasticloadbalancing');
  });
});
