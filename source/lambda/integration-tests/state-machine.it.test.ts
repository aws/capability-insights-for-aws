import { describe, expect, test, beforeAll } from 'vitest';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

import { getStackOutputs, requireOutput } from './helpers/stack-outputs';
import { pollExecution } from './helpers/poll-execution';

/**
 * End-to-end test of the analysis state machine against a deployed stack.
 *
 * Hits real AWS — slow (60–120s), requires credentials, run on demand only:
 *
 *   npm run test:it --workspace=source/lambda
 *
 * Override defaults with env vars when stacks aren't named as expected:
 *
 *   INSIGHTS_STACK_NAME=MyInsightsStack \
 *   USAGE_ANALYSIS_STACK_NAME=MyUsageStack \
 *   DAYS_TO_SCAN=30 \
 *   AWS_REGION=us-west-2 \
 *   npm run test:it --workspace=source/lambda
 *
 * What it does:
 *   1. Reads deployed CloudFormation stack outputs to discover the state
 *      machine ARN, bucket names, and lambda names.
 *   2. Captures the LastModified of each used-capabilities-account-*.json
 *      file in the website bucket.
 *   3. StartExecution on the state machine with a real input.
 *   4. Polls until terminal status (max 5 minutes).
 *   5. Asserts: status SUCCEEDED, all three used-* files have a newer
 *      LastModified, the combined file is valid JSON with the expected
 *      shape and at least one product / API / CFN resource.
 *
 * Preconditions (test fails fast if not met):
 *   - AWS credentials available via the standard SDK credential chain
 *     (env vars, ~/.aws/credentials, IAM role, IAM Identity Center, etc.).
 *   - The two stacks are deployed (defaults below; override with env vars).
 *   - Master-data files exist in the website bucket — the data-fetch lambda
 *     has run at least once.
 *   - CloudTrail bucket has at least a few days of logs.
 *   - At least one active CloudFormation stack exists in the account.
 *
 * If the test data isn't there yet, provision a CloudFormation stack with
 * a few resources, generate AWS API activity to populate CloudTrail, and
 * wait 5–15 minutes for CloudTrail logs to land in S3 before running.
 */
const INSIGHTS_STACK = process.env.INSIGHTS_STACK_NAME ?? 'CapabilityInsightsForAWS';
const USAGE_STACK = process.env.USAGE_ANALYSIS_STACK_NAME ?? 'CapabilityInsightsUsageAnalysis';
const DAYS_TO_SCAN = Number(process.env.DAYS_TO_SCAN ?? 7);

interface Resolved {
  accountId: string;
  region: string;
  stateMachineArn: string;
  websiteBucket: string;
  cloudTrailBucket: string;
  cloudtrailAnalyzerLambda: string;
  cloudformationAnalyzerLambda: string;
}

async function resolveContext(): Promise<Resolved> {
  const sts = new STSClient({});
  const { Account } = await sts.send(new GetCallerIdentityCommand({}));
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

  const insightsOutputs = await getStackOutputs(INSIGHTS_STACK);
  const usageOutputs = await getStackOutputs(USAGE_STACK);

  return {
    accountId: Account!,
    region,
    websiteBucket: requireOutput(insightsOutputs, 'WebsiteBucketName', INSIGHTS_STACK),
    stateMachineArn: requireOutput(usageOutputs, 'AnalysisStateMachineArn', USAGE_STACK),
    cloudTrailBucket: requireOutput(usageOutputs, 'ConfiguredCloudTrailBucketName', USAGE_STACK),
    cloudtrailAnalyzerLambda: requireOutput(usageOutputs, 'CloudTrailAnalyzerLambdaName', USAGE_STACK),
    cloudformationAnalyzerLambda: requireOutput(usageOutputs, 'CloudFormationAnalyzerLambdaName', USAGE_STACK),
  };
}

const USED_FILES = [
  'data/json/used-capabilities-account-deployed.json',
  'data/json/used-capabilities-account-active_usage.json',
  'data/json/used-capabilities-account-combined.json',
] as const;

describe('analysis state machine — integration', () => {
  let ctx: Resolved;
  let s3: S3Client;
  let sfn: SFNClient;

  beforeAll(async () => {
    ctx = await resolveContext();
    s3 = new S3Client({ region: ctx.region });
    sfn = new SFNClient({ region: ctx.region });
  }, 30_000);

  test(
    'runs end-to-end and refreshes all three used-capabilities files',
    async () => {
      // Capture LastModified for each used-* file pre-run so we can prove they
      // were actually rewritten by this execution (rather than reading a file
      // a previous run left behind).
      const before = await Promise.all(
        USED_FILES.map(async key => {
          try {
            const head = await s3.send(new HeadObjectCommand({ Bucket: ctx.websiteBucket, Key: key }));
            return { key, lastModified: head.LastModified };
          } catch {
            return { key, lastModified: undefined };
          }
        }),
      );

      const input = {
        scope: 'account',
        accounts: [ctx.accountId],
        analyzers: ['cloudtrail', 'cloudformation'],
        cloudTrailBucket: ctx.cloudTrailBucket,
        cloudTrailPrefix: 'AWSLogs/',
        daysToScan: DAYS_TO_SCAN,
        websiteBucket: ctx.websiteBucket,
        cloudtrailAnalyzerLambda: ctx.cloudtrailAnalyzerLambda,
        cloudformationAnalyzerLambda: ctx.cloudformationAnalyzerLambda,
        resourceExplorerAnalyzerLambda: '',
      };

      const start = await sfn.send(
        new StartExecutionCommand({
          stateMachineArn: ctx.stateMachineArn,
          input: JSON.stringify(input),
        }),
      );
      expect(start.executionArn).toBeDefined();

      const finished = await pollExecution(sfn, start.executionArn!, {
        timeoutMs: 5 * 60 * 1000,
        intervalMs: 2000,
      });
      expect(finished.status).toBe('SUCCEEDED');

      // Verify each used-* file was rewritten by this run.
      for (const { key, lastModified: priorModified } of before) {
        const head = await s3.send(new HeadObjectCommand({ Bucket: ctx.websiteBucket, Key: key }));
        expect(head.LastModified).toBeDefined();
        if (priorModified) {
          expect(head.LastModified!.getTime()).toBeGreaterThan(priorModified.getTime());
        }
      }

      // Sanity-check the combined file's shape and that it isn't empty.
      const combinedKey = 'data/json/used-capabilities-account-combined.json';
      const obj = await s3.send(new GetObjectCommand({ Bucket: ctx.websiteBucket, Key: combinedKey }));
      const body = await obj.Body!.transformToString();
      const parsed = JSON.parse(body);
      expect(parsed).toHaveProperty('products');
      expect(parsed).toHaveProperty('apis');
      expect(parsed).toHaveProperty('cfnResources');
      expect(parsed).toHaveProperty('lastAnalyzedAt');
      expect(Array.isArray(parsed.products)).toBe(true);
      expect(Array.isArray(parsed.apis)).toBe(true);
      expect(Array.isArray(parsed.cfnResources)).toBe(true);
      // At least one of the three should have content from a real account.
      const total = parsed.products.length + parsed.apis.length + parsed.cfnResources.length;
      expect(total).toBeGreaterThan(0);
    },
    6 * 60 * 1000,
  );
});
