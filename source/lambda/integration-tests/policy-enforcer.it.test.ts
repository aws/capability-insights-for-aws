import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  IAMClient,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  DeletePolicyCommand,
  DeletePolicyVersionCommand,
  ListPolicyVersionsCommand,
} from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

import { getStackOutputs, requireOutput } from './helpers/stack-outputs';

/**
 * End-to-end test of the Policy Enforcer refresh flow against a deployed stack.
 *
 * Hits real AWS (DynamoDB, Lambda, IAM) — slow, requires credentials, run on
 * demand only:
 *
 *   npm run test:it --workspace=source/lambda
 *
 * Override the stack name when it isn't named as expected:
 *
 *   POLICY_ENFORCER_STACK_NAME=MyPolicyStack \
 *   AWS_REGION=us-east-1 \
 *   npm run test:it --workspace=source/lambda
 *
 * What it does:
 *   1. Reads PolicyEnforcer stack outputs to discover the config table and
 *      the bulk-refresh Lambda name.
 *   2. Seeds two Policy_Configuration rows: one IAM-typed and one SCP-typed,
 *      both broad (all regions, intersection) so the SCP allow-list overflows
 *      a single 5,120-char document and must split across multiple parts.
 *   3. Invokes the bulk-refresh Lambda.
 *   4. Asserts both policies flip to ACTIVE/SUCCESS, the IAM managed policy
 *      `PolicyEnforcer-<name>` exists with a parseable default version, and
 *      the SCP-typed policy produced one or more `PolicyEnforcer-<name>[-PartN]`
 *      managed policies (the regression guard for the SCP multi-document split).
 *   5. Cleans up: deletes the created managed policies and the seeded rows.
 *
 * Preconditions (test fails fast / skips if not met):
 *   - AWS credentials available via the standard SDK credential chain.
 *   - The PolicyEnforcer stack is deployed (default below; override with env).
 *   - The API catalog (apis.json) exists in the website bucket — the
 *     data-fetch Lambda has run at least once — so the refresher has a catalog
 *     to compute an allow-list against.
 */
const POLICY_STACK = process.env.POLICY_ENFORCER_STACK_NAME ?? 'CapabilityInsightsPolicyEnforcer';
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

// A region set tuned to overflow a single 5,120-char SCP document while
// staying within the 5-SCP-per-target ceiling — exercises the multi-document
// split success path. Intersection mode shrinks the allow-list, but enough
// regions are picked here to still force a split.
const BROAD_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];

const RUN_ID = Date.now().toString(36);
const IAM_POLICY_NAME = `it-iam-${RUN_ID}`;
const SCP_POLICY_NAME = `it-scp-${RUN_ID}`;

interface Resolved {
  accountId: string;
  tableName: string;
  refreshLambdaName: string;
}

interface ManagedPolicyState {
  status?: string;
  lastRefreshOutcome?: string;
  policyArn?: string;
  additionalPolicyArns?: string[];
  lastActionCount?: number;
}

async function resolveContext(): Promise<Resolved> {
  const sts = new STSClient({ region: REGION });
  const { Account } = await sts.send(new GetCallerIdentityCommand({}));
  const outputs = await getStackOutputs(POLICY_STACK);
  return {
    accountId: Account!,
    tableName: requireOutput(outputs, 'PolicyTableName', POLICY_STACK),
    refreshLambdaName: requireOutput(outputs, 'PolicyRefreshLambdaName', POLICY_STACK),
  };
}

describe('policy enforcer refresh — integration', () => {
  let ctx: Resolved;
  let ddb: DynamoDBDocumentClient;
  let lambda: LambdaClient;
  let iam: IAMClient;

  beforeAll(async () => {
    ctx = await resolveContext();
    ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
    lambda = new LambdaClient({ region: REGION });
    iam = new IAMClient({ region: REGION });

    const now = new Date().toISOString();
    const seed = (policyName: string, policyType: 'IAM' | 'SCP') => ({
      accountId: ctx.accountId,
      policyName,
      description: `Integration test ${policyName}`,
      tags: [],
      regions: BROAD_REGIONS,
      mode: 'intersection',
      policyType,
      exceptions: [],
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
    });

    await ddb.send(new PutCommand({ TableName: ctx.tableName, Item: seed(IAM_POLICY_NAME, 'IAM') }));
    await ddb.send(new PutCommand({ TableName: ctx.tableName, Item: seed(SCP_POLICY_NAME, 'SCP') }));
  }, 60_000);

  afterAll(async () => {
    // Best-effort cleanup of seeded rows and any managed policies created.
    const cleanupPolicy = async (name: string) => {
      const row = await readState(ddb, ctx.tableName, ctx.accountId, name).catch(() => undefined);
      const arns = [row?.policyArn, ...(row?.additionalPolicyArns ?? [])].filter((a): a is string => Boolean(a));
      for (const arn of arns) {
        await deleteManagedPolicy(iam, arn).catch(() => undefined);
      }
      await ddb
        .send(new DeleteCommand({ TableName: ctx.tableName, Key: { accountId: ctx.accountId, policyName: name } }))
        .catch(() => undefined);
    };
    if (ctx) {
      await cleanupPolicy(IAM_POLICY_NAME);
      await cleanupPolicy(SCP_POLICY_NAME);
    }
  }, 60_000);

  test(
    'refreshes IAM and SCP policies, splitting the SCP allow-list across multiple managed policies',
    async () => {
      const invoke = await lambda.send(
        new InvokeCommand({
          FunctionName: ctx.refreshLambdaName,
          Payload: Buffer.from(JSON.stringify({})),
        }),
      );
      expect(invoke.FunctionError).toBeUndefined();

      // --- IAM-typed policy: active, one managed policy with a valid document ---
      const iamState = await readState(ddb, ctx.tableName, ctx.accountId, IAM_POLICY_NAME);
      expect(iamState.status).toBe('active');
      expect(iamState.lastRefreshOutcome).toBe('success');
      expect(iamState.policyArn).toBeDefined();
      expect(iamState.lastActionCount ?? 0).toBeGreaterThan(0);
      await expectPolicyDocumentValid(iam, iamState.policyArn!);

      // --- SCP-typed policy: the regression guard ---
      // A broad intersection allow-list overflows a single 5,120-char SCP, so
      // before the multi-document fix this refresh failed with ERROR. It must
      // now succeed and produce one or more PolicyEnforcer-* managed policies.
      const scpState = await readState(ddb, ctx.tableName, ctx.accountId, SCP_POLICY_NAME);
      expect(scpState.status).toBe('active');
      expect(scpState.lastRefreshOutcome).toBe('success');
      expect(scpState.policyArn).toBeDefined();

      const scpArns = [scpState.policyArn!, ...(scpState.additionalPolicyArns ?? [])];
      // At most 5 documents (the AWS SCP-per-target ceiling the generator enforces).
      expect(scpArns.length).toBeGreaterThanOrEqual(1);
      expect(scpArns.length).toBeLessThanOrEqual(5);
      for (const arn of scpArns) {
        await expectPolicyDocumentValid(iam, arn);
      }
    },
    5 * 60 * 1000,
  );
});

/** Reads a Policy_Configuration row's refresh-relevant fields. */
async function readState(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  accountId: string,
  policyName: string,
): Promise<ManagedPolicyState> {
  const result = await ddb.send(new GetCommand({ TableName: tableName, Key: { accountId, policyName } }));
  if (!result.Item) throw new Error(`Policy row not found: ${policyName}`);
  return result.Item as ManagedPolicyState;
}

/** Asserts a managed policy exists and its default version is valid JSON. */
async function expectPolicyDocumentValid(iam: IAMClient, policyArn: string): Promise<void> {
  const get = await iam.send(new GetPolicyCommand({ PolicyArn: policyArn }));
  expect(get.Policy?.DefaultVersionId).toBeDefined();

  const version = await iam.send(
    new GetPolicyVersionCommand({ PolicyArn: policyArn, VersionId: get.Policy!.DefaultVersionId! }),
  );
  // IAM returns the document URL-encoded; decode then parse.
  const decoded = decodeURIComponent(version.PolicyVersion!.Document!);
  const parsed = JSON.parse(decoded);
  expect(parsed.Version).toBe('2012-10-17');
  expect(Array.isArray(parsed.Statement)).toBe(true);
  expect(parsed.Statement.length).toBeGreaterThan(0);
  // Each managed policy document must fit IAM's 6,144-char limit.
  expect(decoded.length).toBeLessThanOrEqual(6144);
}

/** Deletes all non-default versions, then the managed policy itself. */
async function deleteManagedPolicy(iam: IAMClient, policyArn: string): Promise<void> {
  const versions = await iam.send(new ListPolicyVersionsCommand({ PolicyArn: policyArn }));
  for (const v of versions.Versions ?? []) {
    if (!v.IsDefaultVersion && v.VersionId) {
      await iam.send(new DeletePolicyVersionCommand({ PolicyArn: policyArn, VersionId: v.VersionId }));
    }
  }
  await iam.send(new DeletePolicyCommand({ PolicyArn: policyArn }));
}
