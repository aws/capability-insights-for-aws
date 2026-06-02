import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handler } from './cloudformation-analyzer';
import { CloudFormationClient, StackSummary } from '@aws-sdk/client-cloudformation';
import { S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import * as cloudformationClient from './services/cloudformation-client';

const cfnMock = mockClient(CloudFormationClient);
const s3Mock = mockClient(S3Client);

const stack = (name: string, status = 'CREATE_COMPLETE'): StackSummary => ({
  StackName: name,
  StackStatus: status as StackSummary['StackStatus'],
  CreationTime: new Date('2024-01-01T00:00:00Z'),
});

describe('cloudformation-analyzer', () => {
  beforeEach(() => {
    cfnMock.reset();
    s3Mock.reset();
    vi.clearAllMocks();
    vi.stubEnv('AWS_REGION', 'us-east-1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('handler', () => {
    it('returns flat records with stack/service/resourceType metadata', async () => {
      vi.spyOn(cloudformationClient, 'listActiveStacks').mockResolvedValue([stack('AppStack')]);
      vi.spyOn(cloudformationClient, 'getProcessedTemplate').mockResolvedValue({
        Resources: {
          MyFunction: {
            Type: 'AWS::Lambda::Function',
            Properties: { Runtime: 'python3.11', MemorySize: 256 },
          },
          MyInstance: {
            Type: 'AWS::EC2::Instance',
            Properties: { InstanceType: 't3.medium' },
          },
        },
      });

      const result = await handler({ accountId: '123456789012', websiteBucket: 'test-bucket' });

      expect(result.accountId).toBe('123456789012');
      expect(result.region).toBe('us-east-1');
      expect(result.records).toHaveLength(2);

      const lambdaRecord = result.records.find(r => r.serviceName === 'Lambda');
      expect(lambdaRecord).toMatchObject({
        stackName: 'AppStack',
        serviceName: 'Lambda',
        resourceTypeName: 'Function',
        properties: { Runtime: ['python3.11'], MemorySize: ['256'] },
      });

      const ec2Record = result.records.find(r => r.serviceName === 'EC2');
      expect(ec2Record).toMatchObject({
        stackName: 'AppStack',
        serviceName: 'EC2',
        resourceTypeName: 'Instance',
        properties: { InstanceType: ['t3.medium'] },
      });
    });

    it('dedupes property values within the same stack + resource type', async () => {
      vi.spyOn(cloudformationClient, 'listActiveStacks').mockResolvedValue([stack('Stack1')]);
      vi.spyOn(cloudformationClient, 'getProcessedTemplate').mockResolvedValue({
        Resources: {
          Fn1: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'python3.11' } },
          Fn2: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'python3.11' } },
          Fn3: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'nodejs18.x' } },
        },
      });

      const result = await handler({ accountId: '123456789012' });

      expect(result.records).toHaveLength(1);
      expect(result.records[0].properties.Runtime.sort()).toEqual(['nodejs18.x', 'python3.11']);
    });

    it('produces separate records per stack', async () => {
      vi.spyOn(cloudformationClient, 'listActiveStacks').mockResolvedValue([
        stack('Stack1'),
        stack('Stack2', 'UPDATE_COMPLETE'),
      ]);
      const getTemplateSpy = vi.spyOn(cloudformationClient, 'getProcessedTemplate');
      getTemplateSpy.mockResolvedValueOnce({
        Resources: {
          Fn1: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'python3.11' } },
        },
      });
      getTemplateSpy.mockResolvedValueOnce({
        Resources: {
          Fn2: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'nodejs20.x' } },
        },
      });

      const result = await handler({ accountId: '123456789012' });

      expect(result.records).toHaveLength(2);
      const stackNames = result.records.map(r => r.stackName).sort();
      expect(stackNames).toEqual(['Stack1', 'Stack2']);
    });

    it('skips non-AWS resource types', async () => {
      vi.spyOn(cloudformationClient, 'listActiveStacks').mockResolvedValue([stack('AppStack')]);
      vi.spyOn(cloudformationClient, 'getProcessedTemplate').mockResolvedValue({
        Resources: {
          CustomThing: { Type: 'Custom::MyResource', Properties: { Foo: 'bar' } },
          LambdaFn: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'python3.11' } },
        },
      });

      const result = await handler({ accountId: '123456789012' });

      expect(result.records).toHaveLength(1);
      expect(result.records[0].serviceName).toBe('Lambda');
    });

    it('handles stacks with missing templates', async () => {
      vi.spyOn(cloudformationClient, 'listActiveStacks').mockResolvedValue([stack('BrokenStack')]);
      vi.spyOn(cloudformationClient, 'getProcessedTemplate').mockResolvedValue(null);

      const result = await handler({ accountId: '123456789012' });

      expect(result.records).toEqual([]);
    });

    it('handles empty stack list', async () => {
      vi.spyOn(cloudformationClient, 'listActiveStacks').mockResolvedValue([]);

      const result = await handler({ accountId: '123456789012' });

      expect(result).toEqual({ accountId: '123456789012', region: 'us-east-1', records: [] });
    });

    it('skips non-scalar property values', async () => {
      vi.spyOn(cloudformationClient, 'listActiveStacks').mockResolvedValue([stack('AppStack')]);
      vi.spyOn(cloudformationClient, 'getProcessedTemplate').mockResolvedValue({
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {
              BucketName: 'my-bucket',
              VersioningConfiguration: { Status: 'Enabled' }, // object — should be skipped
              Tags: [{ Key: 'env', Value: 'prod' }], // array — should be skipped
            },
          },
        },
      });

      const result = await handler({ accountId: '123456789012' });

      expect(result.records[0].properties).toEqual({ BucketName: ['my-bucket'] });
    });
  });
});
