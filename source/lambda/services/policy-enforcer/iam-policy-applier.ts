import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { logger } from '../../util/logger';
import { EnvironmentKey, getEnv } from '../../constants/environment';
import type { GeneratedPolicy } from '../../policy-enforcer/policy-document-generator';

/** Prefix applied to every IAM Managed Policy created by the Policy Enforcer.
 *
 * This prefix is **load-bearing** for IAM resource scoping — the helper Lambda's
 * execution role only grants `iam:*Policy*` actions on
 * `arn:aws:iam::<account>:policy/PolicyEnforcer-*`. Changing this prefix
 * without updating the CDK IAM policy will break the feature.
 */
export const POLICY_NAME_PREFIX = 'PolicyEnforcer-';

const lambdaClient = new LambdaClient({});

/** Sanitizes a user-provided policy name to fit AWS Managed Policy naming rules. */
export function sanitizePolicyName(name: string): string {
  return name
    .replace(/[^\w+=,.@-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Builds the AWS Managed Policy name for a given configuration name + part. */
export function buildPolicyName(configName: string, part?: number): string {
  const base = `${POLICY_NAME_PREFIX}${sanitizePolicyName(configName)}`;
  return part !== undefined ? `${base}-Part${part}` : base;
}

interface IamHelperResponse {
  success: boolean;
  policyArn?: string;
  error?: string;
}

export interface ApplyPolicyResult {
  policyArn: string;
  additionalPolicyArns: string[];
}

/**
 * Wraps the out-of-VPC IAM helper Lambda. The helper exists because IAM has
 * no VPC endpoint — the in-VPC API Lambda can't reach `iam.amazonaws.com`
 * directly. Every IAM mutation goes through this invoke.
 */
export class IamPolicyApplier {
  private readonly helperFunctionName: string;

  constructor(helperFunctionName?: string) {
    this.helperFunctionName = helperFunctionName ?? getEnv(EnvironmentKey.IAM_HELPER_LAMBDA_NAME);
  }

  async apply(
    configName: string,
    description: string | undefined,
    generated: GeneratedPolicy,
    existingArns: string[],
  ): Promise<ApplyPolicyResult> {
    const newArns: string[] = [];

    for (let i = 0; i < generated.documents.length; i++) {
      const doc = JSON.stringify(generated.documents[i]);
      const part = generated.documents.length > 1 ? i + 1 : undefined;
      const policyName = buildPolicyName(configName, part);
      const existing = existingArns[i];

      if (!existing) {
        const result = await this.invoke({
          action: 'create',
          policyName,
          policyDocument: doc,
          description,
        });
        if (!result.success || !result.policyArn) {
          throw new Error(`IAM helper failed to create ${policyName}: ${result.error ?? 'unknown'}`);
        }
        newArns.push(result.policyArn);
      } else {
        const result = await this.invoke({
          action: 'update',
          policyArn: existing,
          policyDocument: doc,
        });
        if (!result.success) {
          throw new Error(`IAM helper failed to update ${existing}: ${result.error ?? 'unknown'}`);
        }
        newArns.push(existing);
      }
    }

    // Delete orphan policies if this refresh has fewer parts than the previous one.
    for (let i = generated.documents.length; i < existingArns.length; i++) {
      const result = await this.invoke({ action: 'delete', policyArn: existingArns[i] });
      if (!result.success) {
        logger.warn('Failed to delete orphan policy; leaving for next refresh', {
          policyArn: existingArns[i],
          error: result.error,
        });
      }
    }

    return {
      policyArn: newArns[0],
      additionalPolicyArns: newArns.slice(1),
    };
  }

  /** Deletes all managed policies associated with a configuration. */
  async deleteAll(arns: string[]): Promise<void> {
    for (const arn of arns) {
      const result = await this.invoke({ action: 'delete', policyArn: arn });
      if (!result.success) {
        logger.warn('Failed to delete policy', { policyArn: arn, error: result.error });
      }
    }
  }

  private async invoke(payload: Record<string, unknown>): Promise<IamHelperResponse> {
    const result = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: this.helperFunctionName,
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
    if (result.FunctionError) {
      return {
        success: false,
        error: `Helper Lambda function error: ${result.FunctionError}`,
      };
    }
    const responseText = Buffer.from(result.Payload ?? new Uint8Array()).toString();
    return JSON.parse(responseText) as IamHelperResponse;
  }
}
