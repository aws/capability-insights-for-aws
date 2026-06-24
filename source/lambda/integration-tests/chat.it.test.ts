import { describe, expect, test, beforeAll } from 'vitest';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

import { getStackOutputs, requireOutput } from './helpers/stack-outputs';
import type { ChatInvokeRequest, ChatInvokeResponse } from '../chat-lambda-main';
import { MAX_TURNS } from '../chat/agent';

/**
 * End-to-end test of the Chat assistant against a deployed stack.
 *
 * This is the only test that exercises the REAL Bedrock Converse path —
 * `bedrock-converse.ts` (content-block translation + stopReason mapping) and
 * the live tool-use loop. The unit tests drive the agent loop with a scripted
 * model, so the SDK adapter and a real model's tool-calling behavior are
 * otherwise uncovered.
 *
 * Hits real AWS (Lambda + Bedrock) — slow, requires credentials and Bedrock
 * model access in the deploy region. Run on demand only:
 *
 *   npm run test:it --workspace=source/lambda
 *
 * Override defaults with env vars when the stack isn't named as expected:
 *
 *   CHAT_STACK_NAME=MyChatStack \
 *   AWS_REGION=us-east-1 \
 *   npm run test:it --workspace=source/lambda
 *
 * What it does:
 *   1. Reads the Chat stack outputs to discover the Chat Lambda name.
 *   2. Invokes it with a real availability question — the same payload shape
 *      the API Lambda forwards (message + accountId).
 *   3. Asserts the agent ran the Bedrock tool-use loop (turns > 1, since the
 *      system prompt mandates a list_regions / query_capabilities call before
 *      any availability answer), returned non-empty prose, a structured answer
 *      payload, and — proving the no-write model end-to-end — NO writeProposal.
 *
 * The Chat Lambda is read-only, so there is nothing to clean up.
 *
 * Preconditions (test fails fast if not met):
 *   - AWS credentials available via the standard SDK credential chain.
 *   - The Chat stack is deployed (default below; override with env).
 *   - Amazon Bedrock + the configured Claude model are accessible in the region.
 *   - The capability catalog exists in the website bucket — the data-fetch
 *     Lambda has run at least once — so the tools have data to query.
 */
const CHAT_STACK = process.env.CHAT_STACK_NAME ?? 'CapabilityInsightsChat';
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

interface Resolved {
  accountId: string;
  chatLambdaName: string;
}

async function resolveContext(): Promise<Resolved> {
  const sts = new STSClient({ region: REGION });
  const { Account } = await sts.send(new GetCallerIdentityCommand({}));
  const outputs = await getStackOutputs(CHAT_STACK);
  return {
    accountId: Account!,
    chatLambdaName: requireOutput(outputs, 'ChatLambdaName', CHAT_STACK),
  };
}

/** Invoke the Chat Lambda with a real request and parse its response. */
async function invokeChat(lambda: LambdaClient, name: string, req: ChatInvokeRequest): Promise<ChatInvokeResponse> {
  const res = await lambda.send(new InvokeCommand({ FunctionName: name, Payload: Buffer.from(JSON.stringify(req)) }));
  expect(res.FunctionError).toBeUndefined();
  const text = res.Payload ? new TextDecoder().decode(res.Payload) : '';
  return JSON.parse(text) as ChatInvokeResponse;
}

describe('chat assistant — integration', () => {
  let ctx: Resolved;
  let lambda: LambdaClient;

  beforeAll(async () => {
    ctx = await resolveContext();
    lambda = new LambdaClient({ region: REGION });
  }, 30_000);

  test(
    'answers an availability question via the real Bedrock tool-use loop',
    async () => {
      const result = await invokeChat(lambda, ctx.chatLambdaName, {
        message: 'Which AWS regions is Amazon S3 available in?',
        accountId: ctx.accountId,
      });

      // The agent ran the Bedrock loop and produced prose grounded in tool
      // results. The system prompt mandates a tool call before answering, so a
      // real answer takes more than one turn — turns === 1 would mean the model
      // replied from training knowledge without calling a tool (a grounding
      // regression), or the adapter never surfaced the tool_use stopReason.
      expect(result.turns).toBeGreaterThan(1);
      expect(result.turns).toBeLessThanOrEqual(MAX_TURNS);
      expect(typeof result.reply).toBe('string');
      expect(result.reply.trim().length).toBeGreaterThan(0);

      // A "where available" question yields a structured regions answer for the
      // companion card — confirms the tool result flowed back through the loop.
      expect(result.answer).toBeDefined();
      expect(result.answer!.kind).toBe('regions');

      // The no-write model, proven end-to-end: a read-only question never
      // produces a write proposal.
      expect(result.writeProposal).toBeUndefined();
    },
    5 * 60 * 1000,
  );
});
