import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

/**
 * Reads a deployed CloudFormation stack's outputs into a typed map.
 *
 * The integration test layer self-discovers everything (state-machine ARN,
 * bucket names, lambda names) from these outputs so the test runner only
 * needs the stack name(s) — not a long list of env vars to keep in sync
 * with the CDK construct.
 */
export async function getStackOutputs(stackName: string): Promise<Record<string, string>> {
  const cfn = new CloudFormationClient({});
  const result = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = result.Stacks?.[0];
  if (!stack) throw new Error(`Stack not found: ${stackName}`);
  const outputs: Record<string, string> = {};
  for (const o of stack.Outputs ?? []) {
    if (o.OutputKey && o.OutputValue !== undefined) outputs[o.OutputKey] = o.OutputValue;
  }
  return outputs;
}

export function requireOutput(outputs: Record<string, string>, key: string, stackName: string): string {
  const value = outputs[key];
  if (!value) throw new Error(`Stack ${stackName} is missing output: ${key}`);
  return value;
}
