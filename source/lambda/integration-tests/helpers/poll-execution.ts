import { SFNClient, DescribeExecutionCommand } from '@aws-sdk/client-sfn';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED']);

export interface FinishedExecution {
  status: string;
  output?: string;
  error?: string;
  cause?: string;
}

/**
 * Polls a Step Functions execution until it reaches a terminal status, or
 * the deadline is hit. Returns the final DescribeExecution shape.
 */
export async function pollExecution(
  sfn: SFNClient,
  executionArn: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<FinishedExecution> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const intervalMs = options.intervalMs ?? 2000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    const status = result.status ?? 'UNKNOWN';
    if (TERMINAL.has(status)) {
      return { status, output: result.output, error: result.error, cause: result.cause };
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Execution ${executionArn} did not reach terminal status within ${timeoutMs}ms`);
}
