import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SFNClient, ListExecutionsCommand } from '@aws-sdk/client-sfn';
import { sdkStreamMixin } from '@smithy/util-stream';
import { Readable } from 'stream';
import { getFeaturesRoute, _resetFeaturesCacheForTests } from './features-route';
import type { FeatureFlags } from '@capability-insights/shared/types/feature-flags';

const sfnMock = mockClient(SFNClient);
const s3Mock = mockClient(S3Client);

const STATE_MACHINE_ARN = 'arn:aws:states:us-east-1:123:stateMachine:test';

/**
 * Builds a tiny S3 GetObject response so the probe succeeds. The route does
 * not parse the body — just needs the call to resolve without throwing.
 */
function makeS3Body(): ReturnType<typeof sdkStreamMixin> {
  return sdkStreamMixin(Readable.from(Buffer.from('{}')));
}

async function callRoute(): Promise<FeatureFlags> {
  const result = await getFeaturesRoute();
  expect(result.statusCode).toBe(200);
  return JSON.parse(result.body) as FeatureFlags;
}

describe('features-route', () => {
  beforeEach(() => {
    sfnMock.reset();
    s3Mock.reset();
    _resetFeaturesCacheForTests();
    vi.unstubAllEnvs();
    vi.stubEnv('WEBSITE_BUCKET_NAME', 'capability-insights-website-test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('usageAnalysis', () => {
    it('returns enabled=false when ANALYSIS_STATE_MACHINE_ARN is unset', async () => {
      // No state machine env var set. Other Usage Analysis fields should be absent.
      const flags = await callRoute();
      expect(flags.usageAnalysis).toEqual({ enabled: false });
      expect(sfnMock.commandCalls(ListExecutionsCommand)).toHaveLength(0);
    });

    it('returns enabled=false when ANALYSIS_STATE_MACHINE_ARN is empty string', async () => {
      // Stack-output parameter is wired through as "" before the optional stack is deployed.
      vi.stubEnv('ANALYSIS_STATE_MACHINE_ARN', '');

      const flags = await callRoute();
      expect(flags.usageAnalysis).toEqual({ enabled: false });
      expect(sfnMock.commandCalls(ListExecutionsCommand)).toHaveLength(0);
    });

    it('returns last execution metadata when ANALYSIS_STATE_MACHINE_ARN is set', async () => {
      vi.stubEnv('ANALYSIS_STATE_MACHINE_ARN', STATE_MACHINE_ARN);
      const stopDate = new Date('2026-06-08T16:00:00.000Z');
      sfnMock.on(ListExecutionsCommand).resolves({
        executions: [
          {
            executionArn: `${STATE_MACHINE_ARN}:run-1`,
            stateMachineArn: STATE_MACHINE_ARN,
            name: 'run-1',
            status: 'SUCCEEDED',
            startDate: new Date('2026-06-08T15:55:00.000Z'),
            stopDate,
          },
        ],
      });
      s3Mock.on(GetObjectCommand).resolves({ Body: makeS3Body() });

      const flags = await callRoute();
      expect(flags.usageAnalysis).toEqual({
        enabled: true,
        lastExecutionStatus: 'SUCCEEDED',
        lastExecutionTime: stopDate.toISOString(),
        hasResults: true,
      });
    });

    it('falls back to startDate when stopDate is absent (running execution)', async () => {
      vi.stubEnv('ANALYSIS_STATE_MACHINE_ARN', STATE_MACHINE_ARN);
      const startDate = new Date('2026-06-08T16:10:00.000Z');
      sfnMock.on(ListExecutionsCommand).resolves({
        executions: [
          {
            executionArn: `${STATE_MACHINE_ARN}:run-2`,
            stateMachineArn: STATE_MACHINE_ARN,
            name: 'run-2',
            status: 'RUNNING',
            startDate,
          },
        ],
      });
      s3Mock.on(GetObjectCommand).resolves({ Body: makeS3Body() });

      const flags = await callRoute();
      expect(flags.usageAnalysis.lastExecutionStatus).toBe('RUNNING');
      expect(flags.usageAnalysis.lastExecutionTime).toBe(startDate.toISOString());
    });

    it('omits last-execution fields when no executions have ever run', async () => {
      vi.stubEnv('ANALYSIS_STATE_MACHINE_ARN', STATE_MACHINE_ARN);
      sfnMock.on(ListExecutionsCommand).resolves({ executions: [] });
      s3Mock.on(GetObjectCommand).resolves({ Body: makeS3Body() });

      const flags = await callRoute();
      expect(flags.usageAnalysis.enabled).toBe(true);
      expect(flags.usageAnalysis.lastExecutionStatus).toBeUndefined();
      expect(flags.usageAnalysis.lastExecutionTime).toBeUndefined();
      expect(flags.usageAnalysis.hasResults).toBe(true);
    });

    it('reports enabled=true even when ListExecutions throws', async () => {
      // Tolerant behavior: SFN failure should not break the response. The
      // UI's My Stuff toggle still gets enabled state; "last sync" just
      // shows blank until a later refresh succeeds.
      vi.stubEnv('ANALYSIS_STATE_MACHINE_ARN', STATE_MACHINE_ARN);
      sfnMock.on(ListExecutionsCommand).rejects(new Error('Throttling'));
      s3Mock.on(GetObjectCommand).resolves({ Body: makeS3Body() });

      const flags = await callRoute();
      expect(flags.usageAnalysis.enabled).toBe(true);
      expect(flags.usageAnalysis.lastExecutionTime).toBeUndefined();
      expect(flags.usageAnalysis.lastExecutionStatus).toBeUndefined();
      expect(flags.usageAnalysis.hasResults).toBe(true);
    });

    it('reports hasResults=false when the used-capabilities probe object is missing', async () => {
      // Scenario B from design: stack deployed, no analysis run yet.
      vi.stubEnv('ANALYSIS_STATE_MACHINE_ARN', STATE_MACHINE_ARN);
      sfnMock.on(ListExecutionsCommand).resolves({ executions: [] });
      s3Mock.on(GetObjectCommand).rejects(new Error('NoSuchKey'));

      const flags = await callRoute();
      expect(flags.usageAnalysis.enabled).toBe(true);
      expect(flags.usageAnalysis.hasResults).toBe(false);
    });

    it('reports hasResults=false when the website bucket env var is unset', async () => {
      vi.unstubAllEnvs();
      vi.stubEnv('ANALYSIS_STATE_MACHINE_ARN', STATE_MACHINE_ARN);
      // Intentionally no WEBSITE_BUCKET_NAME — degenerate state but should not throw.
      sfnMock.on(ListExecutionsCommand).resolves({ executions: [] });

      const flags = await callRoute();
      expect(flags.usageAnalysis.enabled).toBe(true);
      expect(flags.usageAnalysis.hasResults).toBe(false);
      // S3 client should not have been called at all when the bucket is unset.
      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    });
  });

  describe('policyEnforcer', () => {
    it('returns enabled=false when POLICY_TABLE_NAME is unset', async () => {
      const flags = await callRoute();
      expect(flags.policyEnforcer).toEqual({ enabled: false });
    });

    it('returns enabled=true when POLICY_TABLE_NAME is set', async () => {
      vi.stubEnv('POLICY_TABLE_NAME', 'CapabilityInsightsPolicyConfiguration');

      const flags = await callRoute();
      expect(flags.policyEnforcer).toEqual({ enabled: true });
    });
  });

  describe('caching', () => {
    it('serves cached response on subsequent calls within TTL', async () => {
      vi.stubEnv('ANALYSIS_STATE_MACHINE_ARN', STATE_MACHINE_ARN);
      sfnMock.on(ListExecutionsCommand).resolves({ executions: [] });
      s3Mock.on(GetObjectCommand).resolves({ Body: makeS3Body() });

      // Call the route a few times; only the first should hit SFN/S3.
      await callRoute();
      await callRoute();
      await callRoute();

      expect(sfnMock.commandCalls(ListExecutionsCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
    });

    it('refetches after TTL expires', async () => {
      vi.stubEnv('ANALYSIS_STATE_MACHINE_ARN', STATE_MACHINE_ARN);
      sfnMock.on(ListExecutionsCommand).resolves({ executions: [] });
      s3Mock.on(GetObjectCommand).resolves({ Body: makeS3Body() });

      vi.useFakeTimers();
      try {
        // First call populates cache.
        await callRoute();
        // Advance past the 60-second TTL.
        vi.advanceTimersByTime(61_000);
        // Second call should miss cache and re-fetch.
        await callRoute();

        expect(sfnMock.commandCalls(ListExecutionsCommand)).toHaveLength(2);
        expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('caches across feature changes — env-var changes are visible only after TTL', async () => {
      // Documents intentional caching behavior: a deploy that flips a feature
      // from disabled→enabled mid-cache window will still report disabled
      // until the cache expires. Acceptable trade-off for 60s cache.
      const flags1 = await callRoute();
      expect(flags1.usageAnalysis.enabled).toBe(false);

      vi.stubEnv('ANALYSIS_STATE_MACHINE_ARN', STATE_MACHINE_ARN);
      sfnMock.on(ListExecutionsCommand).resolves({ executions: [] });
      s3Mock.on(GetObjectCommand).resolves({ Body: makeS3Body() });

      // Cache hit; still reports disabled despite env var now set.
      const flags2 = await callRoute();
      expect(flags2.usageAnalysis.enabled).toBe(false);

      // After explicit cache reset, picks up the new state.
      _resetFeaturesCacheForTests();
      const flags3 = await callRoute();
      expect(flags3.usageAnalysis.enabled).toBe(true);
    });
  });
});
