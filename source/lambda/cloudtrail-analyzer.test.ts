import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handler } from './cloudtrail-analyzer';
import { AthenaClient } from '@aws-sdk/client-athena';
import { S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import * as athenaClient from './services/athena-client';

const athenaMock = mockClient(AthenaClient);
const s3Mock = mockClient(S3Client);

describe('cloudtrail-analyzer', () => {
  beforeEach(() => {
    athenaMock.reset();
    s3Mock.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handler', () => {
    it('processes CloudTrail data and returns usage with apis and regionApis', async () => {
      const mockQueryResults = [
        ['s3.amazonaws.com', 'GetObject', 'us-east-1', '123456789012'],
        ['s3.amazonaws.com', 'PutObject', 'us-east-1', '123456789012'],
        ['s3.amazonaws.com', 'GetObject', 'us-west-2', '123456789012'],
        ['ec2.amazonaws.com', 'DescribeInstances', 'us-east-1', '123456789012'],
      ];

      vi.spyOn(athenaClient, 'queryCloudTrailUsage').mockResolvedValue(mockQueryResults);

      const result = await handler({
        cloudTrailBucket: 'test-bucket',
        cloudTrailPrefix: 'AWSLogs/',
        daysToScan: 7,
        websiteBucket: 'website-bucket',
      });

      expect(result).toHaveProperty('123456789012');
      expect(result['123456789012']).toHaveProperty('s3');
      expect(result['123456789012']).toHaveProperty('ec2');

      // Check s3 service
      const s3Service = result['123456789012'].s3;
      expect(s3Service.apis).toEqual(['GetObject', 'PutObject']);
      expect(s3Service.regionApis).toEqual({
        'us-east-1': ['GetObject', 'PutObject'],
        'us-west-2': ['GetObject'],
      });

      // Check ec2 service
      const ec2Service = result['123456789012'].ec2;
      expect(ec2Service.apis).toEqual(['DescribeInstances']);
      expect(ec2Service.regionApis).toEqual({
        'us-east-1': ['DescribeInstances'],
      });
    });

    it('handles multiple accounts', async () => {
      const mockQueryResults = [
        ['lambda.amazonaws.com', 'Invoke', 'us-east-1', '123456789012'],
        ['lambda.amazonaws.com', 'ListFunctions', 'us-west-2', '987654321098'],
      ];

      vi.spyOn(athenaClient, 'queryCloudTrailUsage').mockResolvedValue(mockQueryResults);

      const result = await handler({
        cloudTrailBucket: 'test-bucket',
        cloudTrailPrefix: 'AWSLogs/',
      });

      expect(Object.keys(result)).toEqual(['123456789012', '987654321098']);
      expect(result['123456789012'].lambda.apis).toEqual(['Invoke']);
      expect(result['987654321098'].lambda.apis).toEqual(['ListFunctions']);
    });

    it('aggregates same API across multiple regions', async () => {
      const mockQueryResults = [
        ['dynamodb.amazonaws.com', 'Query', 'us-east-1', '123456789012'],
        ['dynamodb.amazonaws.com', 'Query', 'eu-west-1', '123456789012'],
        ['dynamodb.amazonaws.com', 'PutItem', 'us-east-1', '123456789012'],
      ];

      vi.spyOn(athenaClient, 'queryCloudTrailUsage').mockResolvedValue(mockQueryResults);

      const result = await handler({
        cloudTrailBucket: 'test-bucket',
        cloudTrailPrefix: 'AWSLogs/',
      });

      const dynamodb = result['123456789012'].dynamodb;
      expect(dynamodb.apis).toEqual(['Query', 'PutItem']);
      expect(dynamodb.regionApis).toEqual({
        'us-east-1': ['Query', 'PutItem'],
        'eu-west-1': ['Query'],
      });
    });

    it('handles empty results', async () => {
      vi.spyOn(athenaClient, 'queryCloudTrailUsage').mockResolvedValue([]);

      const result = await handler({
        cloudTrailBucket: 'test-bucket',
        cloudTrailPrefix: 'AWSLogs/',
      });

      expect(result).toEqual({});
    });

    it('strips .amazonaws.com from service names', async () => {
      const mockQueryResults = [
        ['s3.amazonaws.com', 'GetObject', 'us-east-1', '123456789012'],
        ['lambda.amazonaws.com', 'Invoke', 'us-east-1', '123456789012'],
      ];

      vi.spyOn(athenaClient, 'queryCloudTrailUsage').mockResolvedValue(mockQueryResults);

      const result = await handler({
        cloudTrailBucket: 'test-bucket',
        cloudTrailPrefix: 'AWSLogs/',
      });

      expect(result['123456789012']).toHaveProperty('s3');
      expect(result['123456789012']).toHaveProperty('lambda');
      expect(result['123456789012']).not.toHaveProperty('s3.amazonaws.com');
    });

    it('uses default values for optional parameters', async () => {
      const queryUsageSpy = vi.spyOn(athenaClient, 'queryCloudTrailUsage').mockResolvedValue([]);

      await handler({
        cloudTrailBucket: 'test-bucket',
        cloudTrailPrefix: 'AWSLogs/',
      });

      expect(queryUsageSpy).toHaveBeenCalledWith(
        expect.any(AthenaClient),
        'cloudtrail_analysis',
        'cloudtrail_logs',
        expect.stringContaining('athena-results/'),
        30,
      );
    });
  });
});
