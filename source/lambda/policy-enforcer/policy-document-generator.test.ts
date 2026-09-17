import { describe, it, expect } from 'vitest';
import { generatePolicyDocument } from './policy-document-generator';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type { PolicyConfiguration } from '@capability-insights/shared/types/policy-enforcer/policy-configuration';

const config = (overrides: Partial<PolicyConfiguration> = {}): PolicyConfiguration => ({
  policyName: 'Test',
  tags: [],
  regions: ['us-east-1', 'eu-west-1'],
  mode: 'intersection',
  policyType: 'IAM',
  exceptions: [],
  status: 'pending',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

const TS = '2026-06-03T15:00:00Z';

const buildService = (sdkServiceName: string, apis: { name: string; available: boolean }[]): ApiService => ({
  sdkServiceName,
  sdkServiceFullName: sdkServiceName,
  apis: apis.map(a => ({
    apiName: a.name,
    apiAction: a.name,
    homepage: '',
    regionalAvailability: a.available
      ? {
          'us-east-1': AvailabilityStatus.AVAILABLE,
          'eu-west-1': AvailabilityStatus.AVAILABLE,
        }
      : {
          'us-east-1': AvailabilityStatus.AVAILABLE,
          // missing eu-west-1 → not available under intersection
        },
  })),
});

/** All Action strings across statements with the given effect (their union). */
const actionsFor = (result: ReturnType<typeof generatePolicyDocument>, effect: 'Allow' | 'Deny'): string[] =>
  result.documents
    .flatMap(d => d.Statement)
    .filter(s => s.Effect === effect)
    .flatMap(s => s.Action ?? []);

describe('generatePolicyDocument — IAM (allow-list)', () => {
  it('produces a single Allow document for a small allow-list', () => {
    const result = generatePolicyDocument({
      catalogData: [buildService('s3', [{ name: 'GetObject', available: true }])],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(result.error).toBeUndefined();
    expect(result.documents).toHaveLength(1);
    const stmt = result.documents[0].Statement[0];
    expect(result.documents[0].Version).toBe('2012-10-17');
    expect(stmt.Effect).toBe('Allow');
    expect(stmt.Resource).toBe('*');
    expect(stmt.Action).toEqual(['s3:*']);
    expect(stmt.Sid).toMatch(/^PolicyEnforcerAllow/);
  });

  it('embeds the sanitized generation timestamp in the Sid', () => {
    const result = generatePolicyDocument({
      catalogData: [buildService('s3', [{ name: 'GetObject', available: true }])],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.documents[0].Statement[0].Sid).toContain('20260603T150000Z');
  });

  it('Strategy A: allow service:* + Deny the unavailable actions when most APIs are available', () => {
    const apis = Array.from({ length: 20 }, (_, i) => ({ name: `Action${i}`, available: true }));
    apis.push({ name: 'UnavailableAction', available: false });

    const result = generatePolicyDocument({
      catalogData: [buildService('s3', apis)],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(actionsFor(result, 'Allow')).toEqual(['s3:*']);
    expect(actionsFor(result, 'Deny')).toEqual(['s3:UnavailableAction']);
    // The Deny is a distinct statement so it narrows the s3:* allow.
    const denyStmt = result.documents.flatMap(d => d.Statement).find(s => s.Effect === 'Deny');
    expect(denyStmt?.Sid).toMatch(/^PolicyEnforcerDeny/);
  });

  it('Strategy B: list the available actions when most APIs are unavailable', () => {
    const apis = [
      { name: 'AvailA', available: true },
      { name: 'AvailB', available: true },
      ...Array.from({ length: 20 }, (_, i) => ({ name: `UnavailX${i}`, available: false })),
    ];
    const result = generatePolicyDocument({
      catalogData: [buildService('s3', apis)],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(actionsFor(result, 'Allow')).toEqual(['s3:AvailA', 's3:AvailB']);
    expect(actionsFor(result, 'Deny')).toEqual([]); // nothing to narrow
  });

  it('omits fully-unavailable services from the allow-list (default-denied)', () => {
    const result = generatePolicyDocument({
      catalogData: [
        buildService('s3', [{ name: 'GetObject', available: true }]),
        buildService('unavailableservice', [{ name: 'OnlyAction', available: false }]),
      ],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(actionsFor(result, 'Allow')).toEqual(['s3:*']);
    expect(result.blanketDenyServiceCount).toBe(1);
    expect(result.fullyAvailableServiceCount).toBe(1);
  });

  it('errors when nothing is available in the selected region(s) (empty allow-list)', () => {
    const result = generatePolicyDocument({
      catalogData: [buildService('s3', [{ name: 'GetObject', available: false }])],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/No capabilities are available/i);
    // Critically, it does NOT silently emit a deny-everything policy.
    expect(actionsFor(result, 'Allow')).toEqual([]);
  });

  it('counts fully / partially / fully-unavailable services separately', () => {
    const result = generatePolicyDocument({
      catalogData: [
        buildService('s3', [{ name: 'GetObject', available: true }]),
        buildService('ec2', [
          { name: 'DescribeInstances', available: true },
          { name: 'RunInstances', available: false },
        ]),
        buildService('unavailable', [{ name: 'OnlyAction', available: false }]),
      ],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.fullyAvailableServiceCount).toBe(1);
    expect(result.partiallyAvailableServiceCount).toBe(1);
    expect(result.blanketDenyServiceCount).toBe(1);
  });

  it('marks splitRequired and keeps every document within the IAM size limit', () => {
    const services: ApiService[] = [];
    for (let i = 0; i < 1500; i++) {
      services.push(buildService(`service${i}`, [{ name: 'Action', available: true }]));
    }
    const result = generatePolicyDocument({
      catalogData: services,
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.error).toBeUndefined();
    expect(result.splitRequired).toBe(true);
    expect(result.documents.length).toBeGreaterThan(1);
    for (const doc of result.documents) {
      expect(JSON.stringify(doc).length).toBeLessThanOrEqual(6144);
    }
  });

  // ── Regression for V2367423619 ─────────────────────────────────────────────
  // The old generator expressed the allow-list as `Deny NotAction:[…]` and
  // split it across documents. Attaching those documents together denies
  // everything except the (empty) intersection of the NotAction chunks — i.e.
  // deny-all. The allow-list must instead UNION across documents.
  it('multi-document allow-list composes by UNION, never collapsing to deny-all', () => {
    const N = 1500;
    const services: ApiService[] = [];
    for (let i = 0; i < N; i++) {
      services.push(buildService(`service${i}`, [{ name: 'Action', available: true }]));
    }
    const result = generatePolicyDocument({
      catalogData: services,
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(result.documents.length).toBeGreaterThan(1); // it split
    // No document uses NotAction (the unsplittable, intersect-on-combine form).
    for (const s of result.documents.flatMap(d => d.Statement)) {
      expect((s as { NotAction?: unknown }).NotAction).toBeUndefined();
      expect(s.Effect).toBe('Allow');
    }
    // The UNION of Allow actions across all documents equals the full
    // allow-list — nothing lost to the split.
    const allowUnion = new Set(actionsFor(result, 'Allow'));
    for (let i = 0; i < N; i++) {
      expect(allowUnion.has(`service${i}:*`)).toBe(true);
    }
    expect(allowUnion.size).toBe(N);
  });
});

describe('generatePolicyDocument — SCP', () => {
  const notActionStmts = (r: ReturnType<typeof generatePolicyDocument>) =>
    r.documents.flatMap(d => d.Statement).filter(s => s.NotAction !== undefined);

  it('uses a single strict Deny/NotAction whitelist for a low-availability region (the reported case)', () => {
    // A few available services among many unavailable — like us-isob-east-1.
    const services = [
      buildService('s3', [{ name: 'GetObject', available: true }]),
      buildService('ec2', [{ name: 'DescribeInstances', available: true }]),
      ...Array.from({ length: 50 }, (_, i) => buildService(`unavail${i}`, [{ name: 'A', available: false }])),
    ];
    const result = generatePolicyDocument({
      catalogData: services,
      configuration: config({ policyType: 'SCP' }),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.error).toBeUndefined();
    const na = notActionStmts(result);
    expect(na).toHaveLength(1); // exactly one whitelist document
    expect(na[0].Effect).toBe('Deny');
    expect(na[0].NotAction).toEqual(['ec2:*', 's3:*']); // sorted allow-list
    expect(na[0].NotAction!.length).toBeGreaterThan(0); // NOT deny-all
    expect(result.splitRequired).toBe(false);
  });

  it('narrows a partially-available service in the whitelist with a Deny/Action document', () => {
    const apis = Array.from({ length: 20 }, (_, i) => ({ name: `Avail${i}`, available: true }));
    apis.push({ name: 'Bad', available: false });
    const result = generatePolicyDocument({
      catalogData: [buildService('s3', apis)],
      configuration: config({ policyType: 'SCP' }),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.error).toBeUndefined();
    expect(notActionStmts(result)[0]?.NotAction).toEqual(['s3:*']); // allow s3:*
    expect(actionsFor(result, 'Deny')).toEqual(['s3:Bad']); // narrow out s3:Bad
  });

  it('errors (never deny-all) when nothing is available in the region', () => {
    const result = generatePolicyDocument({
      catalogData: [buildService('s3', [{ name: 'GetObject', available: false }])],
      configuration: config({ policyType: 'SCP' }),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.error).toMatch(/No capabilities are available/i);
    expect(notActionStmts(result)).toHaveLength(0); // no Deny NotAction:[] deny-all
  });

  it('falls back to a union-safe Deny/Action deny-list when the whitelist is too large for one SCP', () => {
    const services: ApiService[] = [];
    for (let i = 0; i < 600; i++) services.push(buildService(`avail${i}`, [{ name: 'A', available: true }]));
    for (let i = 0; i < 200; i++) services.push(buildService(`gone${i}`, [{ name: 'A', available: false }]));
    const result = generatePolicyDocument({
      catalogData: services,
      configuration: config({ policyType: 'SCP' }),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.error).toBeUndefined();
    const stmts = result.documents.flatMap(d => d.Statement);
    expect(stmts.every(s => s.NotAction === undefined)).toBe(true); // fell back → no NotAction
    expect(stmts.every(s => s.Effect === 'Deny')).toBe(true);
    const denyUnion = new Set(actionsFor(result, 'Deny'));
    for (let i = 0; i < 200; i++) expect(denyUnion.has(`gone${i}:*`)).toBe(true);
    expect(result.documents.length).toBeLessThanOrEqual(5);
    for (const doc of result.documents) expect(JSON.stringify(doc).length).toBeLessThanOrEqual(5120);
  });

  it('errors (pointing to IAM, not union mode) when neither whitelist nor deny-list fits the SCP budget', () => {
    const services: ApiService[] = [];
    for (let i = 0; i < 3000; i++) services.push(buildService(`avail${i}`, [{ name: 'A', available: true }]));
    for (let i = 0; i < 6000; i++) services.push(buildService(`gone${i}`, [{ name: 'A', available: false }]));
    const result = generatePolicyDocument({
      catalogData: services,
      configuration: config({ policyType: 'SCP' }),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/IAM Policy type/);
    expect(result.error).not.toMatch(/union mode/); // UI doesn't expose union
    expect(result.documents.length).toBeGreaterThan(5);
  });
});

describe('generatePolicyDocument — invariants', () => {
  it('never emits more than one NotAction statement (NotAction is never split)', () => {
    const small = [buildService('s3', [{ name: 'GetObject', available: true }])];
    const partial = [
      buildService('s3', [
        { name: 'A', available: true },
        { name: 'B', available: false },
      ]),
    ];
    const large: ApiService[] = [];
    for (let i = 0; i < 1500; i++) large.push(buildService(`svc${i}`, [{ name: 'A', available: true }]));
    const lowAvail = [
      buildService('s3', [{ name: 'A', available: true }]),
      ...Array.from({ length: 100 }, (_, i) => buildService(`u${i}`, [{ name: 'A', available: false }])),
    ];

    for (const catalogData of [small, partial, large, lowAvail]) {
      for (const policyType of ['IAM', 'SCP'] as const) {
        const r = generatePolicyDocument({
          catalogData,
          configuration: config({ policyType }),
          policyName: 'T',
          generationTimestamp: TS,
        });
        const notActionCount = r.documents.flatMap(d => d.Statement).filter(s => s.NotAction !== undefined).length;
        expect(notActionCount).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('generatePolicyDocument — exceptions', () => {
  it('treats exception actions as available (their service is allowed)', () => {
    const result = generatePolicyDocument({
      catalogData: [
        buildService('s3', [{ name: 'GetObject', available: true }]),
        buildService('thingthatdoesntexist', [{ name: 'DoSomething', available: false }]),
      ],
      configuration: config({
        exceptions: [{ action: 'thingthatdoesntexist:DoSomething', addedAt: '2026-01-01T00:00:00Z' }],
      }),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(actionsFor(result, 'Allow')).toContain('thingthatdoesntexist:*');
  });
});
