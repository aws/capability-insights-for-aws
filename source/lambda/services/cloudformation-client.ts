import {
  CloudFormationClient,
  ListStacksCommand,
  GetTemplateCommand,
  StackSummary,
} from '@aws-sdk/client-cloudformation';
import { ACTIVE_STACK_STATUSES, TemplateStage } from '../constants/cloudformation';
import { logger } from '../util/logger';

/**
 * Lists all active CloudFormation stacks in the account.
 * Paginates through all results.
 */
export async function listActiveStacks(client: CloudFormationClient): Promise<StackSummary[]> {
  const stacks: StackSummary[] = [];
  let nextToken: string | undefined;

  do {
    const response = await client.send(
      new ListStacksCommand({
        StackStatusFilter: [...ACTIVE_STACK_STATUSES],
        NextToken: nextToken,
      }),
    );
    stacks.push(...(response.StackSummaries || []));
    nextToken = response.NextToken;
  } while (nextToken);

  return stacks;
}

/**
 * Fetches the processed CloudFormation template for a stack.
 * Returns the parsed JSON template, or null if the template can't be retrieved.
 */
export async function getProcessedTemplate(
  client: CloudFormationClient,
  stackName: string,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await client.send(
      new GetTemplateCommand({
        StackName: stackName,
        TemplateStage: TemplateStage.PROCESSED,
      }),
    );
    if (!response.TemplateBody) return null;
    return JSON.parse(response.TemplateBody);
  } catch (e) {
    logger.warn(`Failed to get template for stack ${stackName}`, { error: String(e) });
    return null;
  }
}
