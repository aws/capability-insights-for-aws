import { logger } from '../util/logger';
import { CHAT_TOOLS } from './tools';
import { executeTool, type ToolDataSources, type WriteProposal } from './tool-executor';
import { SYSTEM_PROMPT } from './system-prompt';
import type { AnswerPayload } from '@capability-insights/shared/types/chat-answer';

/**
 * Bedrock-agnostic agent loop.
 *
 * The loop drives a tool-use conversation: it calls an injected `converse`
 * function (the only Bedrock touch point, supplied by the Lambda entrypoint),
 * executes any requested tools via the deterministic tool-executor, feeds the
 * results back, and repeats until the model stops requesting tools or the
 * iteration cap is hit. Keeping `converse` injected makes the whole loop
 * unit-testable with a scripted fake model.
 */

/** A content block in a Converse message: assistant text, a tool request, or a tool result. */
export type ContentBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | { toolResult: { toolUseId: string; content: { json: unknown }[]; status?: 'success' | 'error' } };

export interface ConverseMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

/** What the model returns each turn. `stopReason` 'tool_use' means it wants tools. */
export interface ConverseResult {
  message: ConverseMessage;
  stopReason: 'tool_use' | 'end_turn' | 'max_tokens' | 'stop_sequence' | string;
}

/** The injected model call. Given the running transcript + tool schemas, returns one assistant turn. */
export type ConverseFn = (args: {
  system: string;
  messages: ConverseMessage[];
  tools: typeof CHAT_TOOLS;
}) => Promise<ConverseResult>;

export interface AgentResult {
  /** Final assistant text shown to the user. */
  reply: string;
  /** Any write the agent proposed (surfaced to the browser for confirmation). */
  writeProposal?: WriteProposal;
  /** The most recent structured answer (rendered on the companion canvas). */
  answer?: AnswerPayload;
  /** Number of model turns taken (for observability). */
  turns: number;
}

/**
 * Max model round-trips before we stop. This bounds the COMMON case under the
 * REST API Gateway ~29s integration ceiling — it is not a hard guarantee, since
 * a single turn's Bedrock latency is variable. The Chat Lambda's own 29s timeout
 * is the hard backstop; this cap keeps typical turns comfortably under it.
 * Tune against the ChatLatency / MaxTurnsHit metrics emitted per invocation.
 */
export const MAX_TURNS = 6;

function textOf(message: ConverseMessage): string {
  return message.content
    .filter((b): b is { text: string } => 'text' in b)
    .map(b => b.text)
    .join('\n')
    .trim();
}

function toolUsesOf(message: ConverseMessage): { toolUseId: string; name: string; input: Record<string, unknown> }[] {
  return message.content
    .filter((b): b is Extract<ContentBlock, { toolUse: unknown }> => 'toolUse' in b)
    .map(b => b.toolUse);
}

/**
 * Run one user turn through the agent loop.
 *
 * @param userMessage  the user's text for this turn
 * @param history      prior conversation messages (Converse format)
 * @param converse     injected model call (Bedrock in prod, fake in tests)
 * @param sources      tool data sources (catalog loaders + previewPolicy)
 */
export async function runAgent(
  userMessage: string,
  history: ConverseMessage[],
  converse: ConverseFn,
  sources: ToolDataSources,
): Promise<AgentResult> {
  const messages: ConverseMessage[] = [...history, { role: 'user', content: [{ text: userMessage }] }];
  let writeProposal: WriteProposal | undefined;
  // Most recent structured answer across all tool calls this turn — the canvas
  // renders this. Last definitive answer wins (sticky on the client side).
  let answer: AnswerPayload | undefined;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const { message, stopReason } = await converse({ system: SYSTEM_PROMPT, messages, tools: CHAT_TOOLS });
    messages.push(message);

    if (stopReason !== 'tool_use') {
      return { reply: textOf(message), writeProposal, answer, turns: turn };
    }

    const toolUses = toolUsesOf(message);
    if (toolUses.length === 0) {
      // Model signalled tool_use but emitted no tool block — treat as final.
      return { reply: textOf(message), writeProposal, answer, turns: turn };
    }

    const toolResults: ContentBlock[] = [];
    for (const use of toolUses) {
      try {
        const result = await executeTool(use.name, use.input, sources);
        if (result.writeProposal) writeProposal = result.writeProposal;
        if (result.answer) answer = result.answer;
        // Bedrock's toolResult.content[].json MUST be a JSON object — a
        // top-level array or scalar is rejected. Wrap anything that isn't a
        // plain object so every tool result is valid regardless of its shape.
        const json =
          result.content !== null && typeof result.content === 'object' && !Array.isArray(result.content)
            ? result.content
            : { result: result.content };
        toolResults.push({
          toolResult: { toolUseId: use.toolUseId, content: [{ json }], status: 'success' },
        });
      } catch (e) {
        logger.warn('chat tool execution failed', { tool: use.name, error: String(e) });
        toolResults.push({
          toolResult: {
            toolUseId: use.toolUseId,
            content: [{ json: { error: String(e) } }],
            status: 'error',
          },
        });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Hit the turn cap without a natural end — return the last assistant text we have.
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  logger.warn('chat agent hit MAX_TURNS', { turns: MAX_TURNS });
  return {
    reply: lastAssistant ? textOf(lastAssistant) : 'I was unable to complete that request within the step limit.',
    writeProposal,
    answer,
    turns: MAX_TURNS,
  };
}
