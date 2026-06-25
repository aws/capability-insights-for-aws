import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type ContentBlock as BedrockContentBlock,
  type Tool,
  type ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import type { ConverseFn, ConverseMessage, ConverseResult, ContentBlock } from './agent';
import { CHAT_TOOLS } from './tools';

/**
 * The single Bedrock touch point: adapts our SDK-agnostic ConverseMessage
 * format to the Bedrock Converse API and back. Injected into `runAgent` so the
 * loop itself stays testable without Bedrock.
 *
 * Uses a cross-region inference profile model id by default (e.g.
 * `us.anthropic.claude-...`) so it works across the commercial-US regions the
 * app is typically deployed to; see the chat stack for the configured id.
 */

const client = new BedrockRuntimeClient({});

/** Translate our content blocks into Bedrock content blocks. */
function toBedrockContent(blocks: ContentBlock[]): BedrockContentBlock[] {
  return blocks.map(block => {
    if ('text' in block) return { text: block.text } as BedrockContentBlock;
    if ('toolUse' in block) {
      return {
        toolUse: { toolUseId: block.toolUse.toolUseId, name: block.toolUse.name, input: block.toolUse.input },
      } as BedrockContentBlock;
    }
    return {
      toolResult: {
        toolUseId: block.toolResult.toolUseId,
        content: block.toolResult.content.map(c => ({ json: c.json })),
        status: block.toolResult.status,
      },
    } as BedrockContentBlock;
  });
}

/** Translate a Bedrock assistant message back into our content blocks. */
function fromBedrockContent(blocks: BedrockContentBlock[] | undefined): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks ?? []) {
    if (b.text !== undefined) out.push({ text: b.text });
    else if (b.toolUse) {
      out.push({
        toolUse: {
          toolUseId: b.toolUse.toolUseId ?? '',
          name: b.toolUse.name ?? '',
          input: (b.toolUse.input as Record<string, unknown>) ?? {},
        },
      });
    }
  }
  return out;
}

function toToolConfig(tools: typeof CHAT_TOOLS): ToolConfiguration {
  const specs: Tool[] = tools.map(
    t =>
      ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: { json: t.input_schema as Record<string, unknown> },
        },
      }) as Tool,
  );
  return { tools: specs };
}

/** Build a Bedrock-backed ConverseFn bound to a model id and token cap. */
export function makeBedrockConverse(modelId: string, maxTokens = 1024): ConverseFn {
  return async ({ system, messages, tools }): Promise<ConverseResult> => {
    const bedrockMessages: Message[] = messages.map(m => ({
      role: m.role,
      content: toBedrockContent(m.content),
    }));

    const response = await client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: system }],
        messages: bedrockMessages,
        toolConfig: toToolConfig(tools),
        inferenceConfig: { maxTokens },
      }),
    );

    const out = response.output?.message;
    const assistant: ConverseMessage = { role: 'assistant', content: fromBedrockContent(out?.content) };
    return { message: assistant, stopReason: response.stopReason ?? 'end_turn' };
  };
}
