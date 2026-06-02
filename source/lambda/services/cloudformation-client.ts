import {
  CloudFormationClient,
  ListStacksCommand,
  GetTemplateCommand,
  StackSummary,
} from '@aws-sdk/client-cloudformation';
import * as yaml from 'js-yaml';
import { ACTIVE_STACK_STATUSES, TemplateStage } from '../constants/cloudformation';
import { logger } from '../util/logger';

/**
 * CloudFormation YAML templates use custom intrinsic function tags (!Ref,
 * !GetAtt, !Sub, etc.) that standard YAML parsers reject. This schema
 * accepts them as opaque values so templates parse; downstream code only
 * inspects resource types and scalar properties, so the intrinsic payloads
 * don't need to be interpreted.
 *
 * Tags are constructed into the long-form `{ Fn::TAG: data }` shape so
 * YAML and JSON inputs produce the same in-memory tree. Note `!Ref`'s
 * canonical long form is `{ Ref: data }` (not `{ Fn::Ref: data }`); we
 * normalize it to the prefixed form for consistency. The analyzer never
 * inspects intrinsic payloads, so this asymmetry is invisible downstream.
 */
const CFN_INTRINSIC_TAGS = [
  'Ref',
  'GetAtt',
  'Sub',
  'Join',
  'Select',
  'Split',
  'GetAZs',
  'FindInMap',
  'If',
  'Equals',
  'And',
  'Or',
  'Not',
  'Base64',
  'Cidr',
  'ImportValue',
  'Transform',
  'Condition',
  'Length',
  'ToJsonString',
];

const CFN_YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend(
  CFN_INTRINSIC_TAGS.flatMap(tag => [
    new yaml.Type(`!${tag}`, { kind: 'scalar', construct: data => ({ [`Fn::${tag}`]: data }) }),
    new yaml.Type(`!${tag}`, { kind: 'sequence', construct: data => ({ [`Fn::${tag}`]: data }) }),
    new yaml.Type(`!${tag}`, { kind: 'mapping', construct: data => ({ [`Fn::${tag}`]: data }) }),
  ]),
);

/**
 * Parses a CloudFormation template body, which may be JSON or YAML.
 * CloudFormation's GetTemplate returns the template in whatever format
 * it was submitted, so analyzers must handle both.
 */
function parseTemplateBody(body: string): Record<string, unknown> {
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{')) {
    return JSON.parse(body);
  }
  return yaml.load(body, { schema: CFN_YAML_SCHEMA }) as Record<string, unknown>;
}

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
 * Returns the parsed template (from JSON or YAML), or null if it can't be retrieved.
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
    return parseTemplateBody(response.TemplateBody);
  } catch (e) {
    logger.warn(`Failed to get template for stack ${stackName}`, { error: String(e) });
    return null;
  }
}
