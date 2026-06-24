import { describe, it, expect, vi } from 'vitest';
import { runAgent, MAX_TURNS, type ConverseFn, type ConverseResult } from './agent';
import { ToolName, ProposableWriteKind } from './tools';
import type { ToolDataSources } from './tool-executor';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import { ProductType, type Product } from '@capability-insights/shared/types/capability/product';
import type { Region } from '@capability-insights/shared/types/capability/region';

const A = AvailabilityStatus.AVAILABLE;
const IAD = 'us-east-1';

const regions: Region[] = [
  {
    Region: IAD,
    RegionLongName: 'US East (N. Virginia)',
    Partition: 'aws',
    RegionStatus: 'ACTIVE',
    RequireRegionOptIn: false,
  },
];
const products: Product[] = [
  {
    productId: 'amazon-bedrock',
    productName: 'Amazon Bedrock',
    productType: ProductType.SERVICE,
    regionalAvailability: { [IAD]: A },
  },
];

function sources(overrides: Partial<ToolDataSources> = {}): ToolDataSources {
  return {
    loadRegions: vi.fn(async () => regions),
    loadProducts: vi.fn(async () => products),
    loadApis: vi.fn(async () => []),
    loadCfn: vi.fn(async () => []),
    loadSyncMetadata: vi.fn(async () => ({ lastSyncTime: '2026-06-19T00:00:00.000Z' })),
    loadUsedCapabilities: vi.fn(async () => null),
    loadFeatureFlags: vi.fn(async () => ({ usageAnalysisEnabled: false, policyEnforcerEnabled: true })),
    previewPolicy: vi.fn(async () => null),
    ...overrides,
  };
}

/** Build a fake Converse that returns a scripted sequence of results, one per call. */
function scriptedConverse(script: ConverseResult[]): ConverseFn {
  let i = 0;
  return vi.fn(async () => {
    if (i >= script.length) throw new Error('scriptedConverse: ran out of scripted turns');
    return script[i++];
  });
}

describe('runAgent', () => {
  it('returns the reply directly when the model ends without tools', async () => {
    const converse = scriptedConverse([
      { stopReason: 'end_turn', message: { role: 'assistant', content: [{ text: 'Hello!' }] } },
    ]);
    const result = await runAgent('hi', [], converse, sources());
    expect(result.reply).toBe('Hello!');
    expect(result.turns).toBe(1);
    expect(converse).toHaveBeenCalledTimes(1);
  });

  it('executes a requested tool, feeds the result back, then returns the final answer', async () => {
    const converse = scriptedConverse([
      {
        stopReason: 'tool_use',
        message: {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: 't1',
                name: ToolName.QUERY_CAPABILITIES,
                input: { mode: 'available_in', entityType: 'product', name: 'Bedrock', regions: [IAD] },
              },
            },
          ],
        },
      },
      {
        stopReason: 'end_turn',
        message: { role: 'assistant', content: [{ text: 'Yes, Amazon Bedrock is available in us-east-1.' }] },
      },
    ]);
    const result = await runAgent('is bedrock in us-east-1?', [], converse, sources());
    expect(result.reply).toContain('Bedrock');
    expect(result.turns).toBe(2);
    expect(converse).toHaveBeenCalledTimes(2);
    // The second converse call must have received the tool result in the transcript.
    const secondCallMessages = (converse as unknown as { mock: { calls: { 0: { messages: unknown[] } }[] } }).mock
      .calls[1][0].messages;
    const flat = JSON.stringify(secondCallMessages);
    expect(flat).toContain('toolResult');
    // query_capabilities available_in result: Bedrock matched + available in us-east-1.
    expect(flat).toContain('"availableCount":1');
    expect(flat).toContain('Amazon Bedrock');
    // The structured answer is surfaced to the client for the companion canvas.
    expect(result.answer).toMatchObject({ kind: 'availability' });
    expect(result.answer?.primary?.label).toBe('Amazon Bedrock');
  });

  it('wraps array-shaped tool results as a JSON object (Bedrock toolResult.json must be an object)', async () => {
    // list_regions returns a top-level ARRAY content; Bedrock rejects a non-object json.
    const converse = scriptedConverse([
      {
        stopReason: 'tool_use',
        message: {
          role: 'assistant',
          content: [{ toolUse: { toolUseId: 'r1', name: ToolName.LIST_REGIONS, input: {} } }],
        },
      },
      { stopReason: 'end_turn', message: { role: 'assistant', content: [{ text: 'There is 1 region.' }] } },
    ]);
    await runAgent('list regions', [], converse, sources());
    const secondCallMessages = (converse as unknown as { mock: { calls: { 0: { messages: unknown[] } }[] } }).mock
      .calls[1][0].messages;
    // Find the toolResult block and assert its json is a plain object (wrapped), not an array.
    const toolResultMsg = (
      secondCallMessages as Array<{ content: Array<{ toolResult?: { content: { json: unknown }[] } }> }>
    )
      .flatMap(m => m.content)
      .find(b => b.toolResult);
    const json = toolResultMsg!.toolResult!.content[0].json;
    expect(Array.isArray(json)).toBe(false);
    expect(typeof json).toBe('object');
    // The array is preserved under a `result` key.
    expect((json as { result: unknown[] }).result).toHaveLength(1);
  });

  it('surfaces a writeProposal when the model calls propose_write (no mutation)', async () => {
    const converse = scriptedConverse([
      {
        stopReason: 'tool_use',
        message: {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: 'w1',
                name: ToolName.PROPOSE_WRITE,
                input: {
                  kind: ProposableWriteKind.CREATE_POLICY,
                  summary: 'Create policy denying eu-west-1',
                  payload: { policyName: 'p' },
                },
              },
            },
          ],
        },
      },
      {
        stopReason: 'end_turn',
        message: { role: 'assistant', content: [{ text: 'I drafted a policy — please confirm.' }] },
      },
    ]);
    const result = await runAgent('block eu-west-1', [], converse, sources());
    expect(result.writeProposal).toEqual({
      kind: ProposableWriteKind.CREATE_POLICY,
      summary: 'Create policy denying eu-west-1',
      payload: { policyName: 'p' },
    });
    expect(result.reply).toContain('confirm');
  });

  it('feeds a tool error back to the model rather than throwing', async () => {
    const converse = scriptedConverse([
      {
        stopReason: 'tool_use',
        message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'x', name: 'not_a_tool', input: {} } }] },
      },
      { stopReason: 'end_turn', message: { role: 'assistant', content: [{ text: 'Sorry, I could not do that.' }] } },
    ]);
    const result = await runAgent('do something weird', [], converse, sources());
    expect(result.reply).toContain('could not');
    const secondCallMessages = (converse as unknown as { mock: { calls: { 0: { messages: unknown[] } }[] } }).mock
      .calls[1][0].messages;
    expect(JSON.stringify(secondCallMessages)).toContain('"status":"error"');
  });

  it('stops at MAX_TURNS if the model keeps requesting tools', async () => {
    // Always ask for a tool — never ends.
    const neverEnds: ConverseFn = vi.fn(
      async () =>
        ({
          stopReason: 'tool_use',
          message: { role: 'assistant', content: [{ text: 'thinking…', toolUse: undefined } as never] },
        }) as ConverseResult,
    );
    // The above has no real toolUse block, so the loop treats it as final on turn 1;
    // instead script a genuine tool loop:
    const looping: ConverseFn = vi.fn(async () => ({
      stopReason: 'tool_use',
      message: {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 'l', name: ToolName.LIST_REGIONS, input: {} } }],
      },
    }));
    void neverEnds;
    const result = await runAgent('loop forever', [], looping, sources());
    expect(result.turns).toBe(MAX_TURNS);
    expect(looping).toHaveBeenCalledTimes(MAX_TURNS);
  });

  it('prepends history before the new user message', async () => {
    const converse = scriptedConverse([
      { stopReason: 'end_turn', message: { role: 'assistant', content: [{ text: 'ok' }] } },
    ]);
    await runAgent('second question', [{ role: 'user', content: [{ text: 'first question' }] }], converse, sources());
    const firstCallMessages = (
      converse as unknown as { mock: { calls: { 0: { messages: { content: { text?: string }[] }[] } }[] } }
    ).mock.calls[0][0].messages;
    expect(JSON.stringify(firstCallMessages)).toContain('first question');
    expect(JSON.stringify(firstCallMessages)).toContain('second question');
  });
});
