import { describe, it, expect, vi } from 'vitest';
import { ParamRouter } from './router';

describe('ParamRouter', () => {
  it('matches exact paths', async () => {
    const router = new ParamRouter();
    const handler = vi.fn(async () => ({
      statusCode: 200,
      body: '',
    }));
    router.register('GET', '/policies', handler);

    const match = router.match('GET', '/policies');
    expect(match).not.toBeNull();
    expect(match!.params).toEqual({});
  });

  it('captures :param segments', () => {
    const router = new ParamRouter();
    router.register('GET', '/policies/:policyName', vi.fn());

    const match = router.match('GET', '/policies/abc-123');
    expect(match!.params).toEqual({ policyName: 'abc-123' });
  });

  it('decodes URI-encoded params', () => {
    const router = new ParamRouter();
    router.register('GET', '/policies/:policyName', vi.fn());

    const match = router.match('GET', '/policies/abc%20123');
    expect(match!.params.policyName).toBe('abc 123');
  });

  it('respects HTTP method', () => {
    const router = new ParamRouter();
    router.register('GET', '/policies/:policyName', vi.fn());

    expect(router.match('POST', '/policies/abc')).toBeNull();
  });

  it('does not match when path has more segments', () => {
    const router = new ParamRouter();
    router.register('GET', '/policies/:policyName', vi.fn());

    expect(router.match('GET', '/policies/abc/preview')).toBeNull();
  });

  it('matches multi-param routes', () => {
    const router = new ParamRouter();
    router.register('POST', '/policies/:policyName/refresh', vi.fn());

    const match = router.match('POST', '/policies/abc-123/refresh');
    expect(match!.params).toEqual({ policyName: 'abc-123' });
  });

  it('returns null for unregistered paths', () => {
    const router = new ParamRouter();
    router.register('GET', '/policies/:policyName', vi.fn());

    expect(router.match('GET', '/unknown')).toBeNull();
  });

  it('first registered match wins', () => {
    const router = new ParamRouter();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    router.register('GET', '/policies/:id', handlerA);
    router.register('GET', '/policies/:other', handlerB);

    const match = router.match('GET', '/policies/abc');
    expect(match!.handler).toBe(handlerA);
  });
});
