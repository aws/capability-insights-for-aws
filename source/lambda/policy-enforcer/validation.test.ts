import { describe, it, expect } from 'vitest';
import { validateExceptionEntry, validatePolicyConfiguration, validatePolicyUpdate } from './validation';
import type { CreatePolicyRequest } from '@capability-insights/shared/types/policy-enforcer/policy-api';

describe('validateExceptionEntry', () => {
  it('accepts service:Action format', () => {
    expect(validateExceptionEntry('s3:GetObject')).toBe(true);
    expect(validateExceptionEntry('ec2:DescribeInstances')).toBe(true);
    expect(validateExceptionEntry('elasticloadbalancing:CreateLoadBalancer')).toBe(true);
    expect(validateExceptionEntry('rds-data:ExecuteStatement')).toBe(true);
  });

  it('accepts service:* wildcard', () => {
    expect(validateExceptionEntry('s3:*')).toBe(true);
    expect(validateExceptionEntry('ec2:*')).toBe(true);
  });

  it('rejects lowercase action names', () => {
    expect(validateExceptionEntry('s3:getObject')).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(validateExceptionEntry('')).toBe(false);
    expect(validateExceptionEntry('s3:')).toBe(false);
    expect(validateExceptionEntry(':GetObject')).toBe(false);
  });

  it('rejects missing colon', () => {
    expect(validateExceptionEntry('s3GetObject')).toBe(false);
  });

  it('rejects multiple colons', () => {
    expect(validateExceptionEntry('s3:Get:Object')).toBe(false);
  });
});

const validRequest: CreatePolicyRequest = {
  policyName: 'Test',
  regions: ['us-east-1'],
  mode: 'intersection',
  policyType: 'IAM',
};

describe('validatePolicyConfiguration', () => {
  it('accepts a minimal valid request', () => {
    const result = validatePolicyConfiguration(validRequest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('requires non-empty policyName', () => {
    const result = validatePolicyConfiguration({ ...validRequest, policyName: '' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('policyName is required');
  });

  it('requires non-empty regions', () => {
    const result = validatePolicyConfiguration({ ...validRequest, regions: [] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/regions/);
  });

  it('rejects invalid mode', () => {
    const result = validatePolicyConfiguration({
      ...validRequest,
      mode: 'invalid' as 'intersection',
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/mode/);
  });

  it('rejects invalid policyType', () => {
    const result = validatePolicyConfiguration({
      ...validRequest,
      policyType: 'foo' as 'IAM',
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/policyType/);
  });

  it('rejects malformed exception action', () => {
    const result = validatePolicyConfiguration({
      ...validRequest,
      exceptions: [{ action: 's3:getObject', addedAt: '2026-01-01T00:00:00Z' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid exception action/);
  });

  it('rejects empty tag keys', () => {
    const result = validatePolicyConfiguration({
      ...validRequest,
      tags: [{ key: '', value: 'foo' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Tag keys/);
  });
});

describe('validatePolicyUpdate', () => {
  it('accepts an empty update', () => {
    const result = validatePolicyUpdate({});
    expect(result.valid).toBe(true);
  });

  it('only validates fields that are provided', () => {
    const result = validatePolicyUpdate({ description: 'updated' });
    expect(result.valid).toBe(true);
  });

  it('rejects empty regions array when provided', () => {
    const result = validatePolicyUpdate({ regions: [] });
    expect(result.valid).toBe(false);
  });
});
