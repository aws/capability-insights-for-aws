import { describe, it, expect, vi, afterEach } from 'vitest';
import { emitMetrics } from './logger';

/**
 * EMF is a contract with CloudWatch's log-to-metric extractor: a malformed
 * `_aws` block silently yields NO metrics (the dashboard just stays empty), so
 * these tests pin the exact structure rather than just "it logged something".
 */
describe('emitMetrics (EMF)', () => {
  afterEach(() => vi.restoreAllMocks());

  function captureEmit(namespace: string, metrics: Parameters<typeof emitMetrics>[1]) {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitMetrics(namespace, metrics);
    expect(spy).toHaveBeenCalledTimes(1);
    return JSON.parse(spy.mock.calls[0][0] as string);
  }

  it('emits a valid EMF document with values at the top level', () => {
    const doc = captureEmit('CapabilityInsights/Chat', {
      AgentTurns: { value: 3 },
      ChatLatency: { value: 1200, unit: 'Milliseconds' },
    });

    // Metric values live at the root, not nested.
    expect(doc.AgentTurns).toBe(3);
    expect(doc.ChatLatency).toBe(1200);

    const meta = doc._aws.CloudWatchMetrics[0];
    expect(meta.Namespace).toBe('CapabilityInsights/Chat');
    // Dimensionless: [[]] means "aggregate across all invocations".
    expect(meta.Dimensions).toEqual([[]]);
    expect(meta.Metrics).toEqual([
      { Name: 'AgentTurns', Unit: 'Count' }, // unit defaults to Count
      { Name: 'ChatLatency', Unit: 'Milliseconds' },
    ]);
    expect(typeof doc._aws.Timestamp).toBe('number');
  });

  it('preserves a zero metric value (the MaxTurnsHit=0 case)', () => {
    const doc = captureEmit('CapabilityInsights/Chat', { MaxTurnsHit: { value: 0 } });
    // Must serialize 0, not drop it — otherwise the "did NOT truncate" signal vanishes.
    expect(doc.MaxTurnsHit).toBe(0);
    expect(doc._aws.CloudWatchMetrics[0].Metrics).toEqual([{ Name: 'MaxTurnsHit', Unit: 'Count' }]);
  });
});
