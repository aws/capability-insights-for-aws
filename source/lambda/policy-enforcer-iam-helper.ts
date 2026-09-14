import {
  IAMClient,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  DeletePolicyCommand,
  DeletePolicyVersionCommand,
  ListPolicyVersionsCommand,
} from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { logger } from './util/logger';

const MAX_POLICY_VERSIONS = 5;
const client = new IAMClient({});
const stsClient = new STSClient({});

/** Account id and partition, resolved via STS GetCallerIdentity on first use and cached. */
let cachedIdentity: { accountId: string; partition: string } | undefined;

/**
 * IAM Policy Helper Lambda — runs OUTSIDE the VPC because IAM is a global
 * service with no VPC endpoint. The in-VPC API Lambda invokes this helper
 * over the Lambda VPC endpoint.
 *
 * All actions are scoped to `arn:aws:iam::<account>:policy/PolicyEnforcer-*`
 * by the IAM policy attached to this Lambda's role (defined in the
 * PolicyEnforcer CDK stack), keeping the blast radius minimal.
 */

interface CreateRequest {
  action: 'create';
  policyName: string;
  policyDocument: string;
  description?: string;
}

interface UpdateRequest {
  action: 'update';
  policyArn: string;
  policyDocument: string;
}

interface DeleteRequest {
  action: 'delete';
  policyArn: string;
}

type IamHelperRequest = CreateRequest | UpdateRequest | DeleteRequest;

export interface IamHelperResponse {
  success: boolean;
  policyArn?: string;
  error?: string;
}

export const handler = async (event: IamHelperRequest): Promise<IamHelperResponse> => {
  logger.info('iam-helper invoked', { action: event.action });
  try {
    switch (event.action) {
      case 'create': {
        try {
          const result = await client.send(
            new CreatePolicyCommand({
              PolicyName: event.policyName,
              PolicyDocument: event.policyDocument,
              Description: event.description,
            }),
          );
          const arn = result.Policy?.Arn;
          if (!arn) throw new Error('CreatePolicy returned no ARN');
          logger.info('iam-helper created policy', { policyArn: arn });
          return { success: true, policyArn: arn };
        } catch (e) {
          // Adopt: a `PolicyEnforcer-*` policy with this name already exists
          // — most likely an orphan from a previously failed create. The
          // PolicyEnforcer-* prefix is reserved by this feature (the helper's
          // IAM policy scopes every action to it), so taking it over is safe.
          // Reset its document to the one the caller asked for and return its
          // ARN as if we'd just created it.
          if (!isAlreadyExistsError(e)) throw e;
          const arn = await deriveExistingArn(event.policyName);
          logger.warn('iam-helper adopting existing policy with same name', {
            policyName: event.policyName,
            policyArn: arn,
          });
          await trimPolicyVersions(arn);
          await client.send(
            new CreatePolicyVersionCommand({
              PolicyArn: arn,
              PolicyDocument: event.policyDocument,
              SetAsDefault: true,
            }),
          );
          return { success: true, policyArn: arn };
        }
      }
      case 'update': {
        // Trim before create — IAM rejects CreatePolicyVersion when at the
        // 5-version limit. If trimming partially succeeds and Create then
        // fails, the policy is left with 1-2 fewer non-default versions but
        // no new version applied. That is a recoverable state — the next
        // update attempt will trim again (idempotent) and create cleanly.
        // Any error here bubbles up to the outer catch below as
        // `{ success: false }`, prompting the caller to retry.
        await trimPolicyVersions(event.policyArn);
        await client.send(
          new CreatePolicyVersionCommand({
            PolicyArn: event.policyArn,
            PolicyDocument: event.policyDocument,
            SetAsDefault: true,
          }),
        );
        logger.info('iam-helper updated policy', { policyArn: event.policyArn });
        return { success: true, policyArn: event.policyArn };
      }
      case 'delete': {
        try {
          const versions = await client.send(new ListPolicyVersionsCommand({ PolicyArn: event.policyArn }));
          for (const v of versions.Versions ?? []) {
            if (v.IsDefaultVersion || !v.VersionId) continue;
            await client.send(new DeletePolicyVersionCommand({ PolicyArn: event.policyArn, VersionId: v.VersionId }));
          }
        } catch (e) {
          logger.warn('iam-helper failed to list/clean versions before delete', {
            policyArn: event.policyArn,
            error: String(e),
          });
        }
        await client.send(new DeletePolicyCommand({ PolicyArn: event.policyArn }));
        logger.info('iam-helper deleted policy', { policyArn: event.policyArn });
        return { success: true };
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('iam-helper failed', { action: event.action, error: message });
    return { success: false, error: message };
  }
};

/** Detect the IAM `EntityAlreadyExists` error across SDK shapes. */
function isAlreadyExistsError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { name?: string; Code?: string; message?: string };
  return (
    err.name === 'EntityAlreadyExistsException' ||
    err.Code === 'EntityAlreadyExists' ||
    Boolean(err.message?.includes('already exists'))
  );
}

/**
 * Build the ARN of an existing managed policy from its name. Managed-policy
 * ARNs follow a deterministic shape:
 *   arn:<partition>:iam::<account>:policy/<name>
 *
 * Account and partition are resolved via STS GetCallerIdentity on first call
 * and cached thereafter. We avoid relying on `AWS_LAMBDA_FUNCTION_ARN` because the
 * Lambda runtime does not set that env var by default — only fields like
 * `AWS_LAMBDA_FUNCTION_NAME` and `AWS_REGION` are exposed.
 */
async function deriveExistingArn(policyName: string): Promise<string> {
  const { partition, accountId } = await getCallerIdentity();
  return `arn:${partition}:iam::${accountId}:policy/${policyName}`;
}

async function getCallerIdentity(): Promise<{ accountId: string; partition: string }> {
  if (cachedIdentity) return cachedIdentity;
  const result = await stsClient.send(new GetCallerIdentityCommand({}));
  if (!result.Account) throw new Error('STS GetCallerIdentity returned no Account');
  // Arn has the form arn:<partition>:sts::<account>:...; segment 1 is the
  // partition, so ARNs are built correctly in aws, aws-cn and aws-us-gov.
  const partition = result.Arn?.split(':')[1];
  if (!partition) throw new Error('STS GetCallerIdentity returned no usable Arn');
  cachedIdentity = { accountId: result.Account, partition };
  return cachedIdentity;
}

async function trimPolicyVersions(arn: string): Promise<void> {
  const result = await client.send(new ListPolicyVersionsCommand({ PolicyArn: arn }));
  const versions = result.Versions ?? [];
  if (versions.length < MAX_POLICY_VERSIONS) return;

  const nonDefault = versions
    .filter(v => !v.IsDefaultVersion)
    .sort((a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0));

  const toDelete = nonDefault.slice(0, versions.length - (MAX_POLICY_VERSIONS - 1));
  for (const v of toDelete) {
    if (!v.VersionId) continue;
    await client.send(new DeletePolicyVersionCommand({ PolicyArn: arn, VersionId: v.VersionId }));
  }
}
