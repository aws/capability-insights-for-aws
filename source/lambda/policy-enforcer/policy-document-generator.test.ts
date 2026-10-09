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

/** The `NotAction` list of the (single) whitelist statement, if there is one. */
const whitelistFor = (result: ReturnType<typeof generatePolicyDocument>): string[] | undefined =>
  result.documents.flatMap(d => d.Statement).find(s => s.NotAction !== undefined)?.NotAction;

/** A catalog whose whitelist is too large for one IAM document: forces the deny-list fallback. */
const mixedLargeCatalog = (): ApiService[] => {
  const services: ApiService[] = [];
  for (let i = 0; i < 600; i++) services.push(buildService(`avail${i}`, [{ name: 'A', available: true }]));
  for (let i = 0; i < 1500; i++) services.push(buildService(`gone${i}`, [{ name: 'A', available: false }]));
  return services;
};

/** Applies the documents' Deny statements to `action` (Deny Action / Deny NotAction semantics). */
const isDenied = (result: ReturnType<typeof generatePolicyDocument>, action: string): boolean => {
  const matches = (entry: string) =>
    entry === action || (entry.endsWith(':*') && action.startsWith(entry.slice(0, -1)));
  return result.documents
    .flatMap(d => d.Statement)
    .some(
      s =>
        s.Effect === 'Deny' && (s.Action?.some(matches) || (s.NotAction !== undefined && !s.NotAction.some(matches))),
    );
};

describe('generatePolicyDocument — IAM (deny-list)', () => {
  it('denies a fully-unavailable service with a service wildcard', () => {
    const result = generatePolicyDocument({
      catalogData: [
        buildService('s3', [{ name: 'GetObject', available: true }]),
        buildService('unavailableservice', [{ name: 'OnlyAction', available: false }]),
      ],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(result.error).toBeUndefined();
    expect(result.documents).toHaveLength(1);
    const stmt = result.documents[0].Statement[0];
    expect(result.documents[0].Version).toBe('2012-10-17');
    expect(stmt.Effect).toBe('Deny');
    expect(stmt.Resource).toBe('*');
    expect(stmt.Action).toEqual(['unavailableservice:*']);
    expect(stmt.NotAction).toBeUndefined();
    expect(stmt.Sid).toMatch(/^PolicyEnforcerDeny/);
    expect(result.blanketDenyServiceCount).toBe(1);
    expect(result.fullyAvailableServiceCount).toBe(1);
  });

  it('embeds the sanitized generation timestamp in the Sid', () => {
    const result = generatePolicyDocument({
      catalogData: [
        buildService('s3', [{ name: 'GetObject', available: false }]),
        buildService('ec2', [{ name: 'A', available: true }]),
      ],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.documents[0].Statement[0].Sid).toContain('20260603T150000Z');
  });

  it('denies only the unavailable actions of a mostly-available service', () => {
    const apis = Array.from({ length: 20 }, (_, i) => ({ name: `Action${i}`, available: true }));
    apis.push({ name: 'UnavailableAction', available: false });

    const result = generatePolicyDocument({
      catalogData: [buildService('s3', apis)],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(actionsFor(result, 'Deny')).toEqual(['s3:UnavailableAction']);
  });

  it('denies the unavailable actions of a mostly-unavailable service, not the whole service', () => {
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

    const denied = actionsFor(result, 'Deny');
    expect(denied).toHaveLength(20);
    expect(denied).not.toContain('s3:*');
    expect(isDenied(result, 's3:AvailA')).toBe(false);
  });

  // Several catalog services can map to one IAM prefix (e.g. Lambda and Lambda
  // Core). Availability is merged per prefix, so one unavailable service can't
  // deny the actions another service with the same prefix makes available.
  it('does not deny the whole prefix when another service with the same IAM prefix is available', () => {
    const result = generatePolicyDocument({
      catalogData: [
        buildService('lambda', [{ name: 'Invoke', available: true }]),
        buildService('lambda', [{ name: 'CoreOnly', available: false }]),
      ],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(actionsFor(result, 'Deny')).toEqual(['lambda:CoreOnly']);
    expect(isDenied(result, 'lambda:Invoke')).toBe(false);
  });

  it('does not deny an action that another service with the same IAM prefix makes available', () => {
    const result = generatePolicyDocument({
      catalogData: [
        buildService('wisdom', [
          { name: 'Shared', available: false },
          { name: 'OnlyHere', available: false },
          { name: 'Other', available: true },
        ]),
        buildService('wisdom', [{ name: 'Shared', available: true }]),
      ],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(actionsFor(result, 'Deny')).toEqual(['wisdom:OnlyHere']);
    expect(isDenied(result, 'wisdom:Shared')).toBe(false);
  });

  it('does not deny services or actions that are missing from the catalog', () => {
    const result = generatePolicyDocument({
      catalogData: [
        buildService('s3', [{ name: 'GetObject', available: true }]),
        buildService('gone', [{ name: 'A', available: false }]),
      ],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    // e.g. IAM-only namespaces such as Session Manager's, which no catalog service models.
    expect(isDenied(result, 'ssmmessages:CreateControlChannel')).toBe(false);
    expect(isDenied(result, 's3:ListAllMyBuckets')).toBe(false);
    expect(isDenied(result, 'gone:A')).toBe(true);
  });

  it('never denies a partially-modeled namespace such as execute-api wholesale', () => {
    // The catalog models execute-api only through ApiGatewayManagementApi, but
    // execute-api:Invoke (calling IAM-authorized APIs) works wherever API Gateway does.
    const result = generatePolicyDocument({
      catalogData: [
        buildService('apigateway', [{ name: 'GetRestApis', available: true }]),
        buildService('execute-api', [
          { name: 'PostToConnection', available: false },
          { name: 'GetConnection', available: false },
        ]),
      ],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(actionsFor(result, 'Deny')).toEqual(['execute-api:GetConnection', 'execute-api:PostToConnection']);
    expect(isDenied(result, 'execute-api:Invoke')).toBe(false);
  });

  it('honours exceptions: an excepted action and a service-wide exception are not denied', () => {
    const result = generatePolicyDocument({
      catalogData: [
        buildService('s3', [
          { name: 'GetObject', available: true },
          { name: 'PutObject', available: false },
        ]),
        buildService('ecr', [{ name: 'BatchGetImage', available: false }]),
        buildService('gone', [{ name: 'A', available: false }]),
      ],
      configuration: config({
        exceptions: [
          { action: 's3:PutObject', addedAt: '2026-01-01T00:00:00Z' },
          { action: 'ecr:*', addedAt: '2026-01-01T00:00:00Z' },
        ],
      }),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(actionsFor(result, 'Deny')).toEqual(['gone:*']);
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
    expect(result.documents).toHaveLength(0);
  });

  it('errors instead of returning no documents when there is nothing to restrict', () => {
    // An empty result would make the applier delete the policy's existing parts.
    const result = generatePolicyDocument({
      catalogData: [buildService('s3', [{ name: 'GetObject', available: true }])],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.error).toMatch(/nothing for this IAM policy to restrict/i);
    expect(result.documents).toHaveLength(0);
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

  // ── Regression for V2367423619 ─────────────────────────────────────────────
  // The old generator expressed the allow-list as `Deny NotAction:[…]` and
  // split it across documents. Attaching those documents together denies
  // everything except the (empty) intersection of the NotAction chunks — i.e.
  // deny-all. A split policy must instead UNION across documents.
  it('splits a large deny-list within the IAM size limit, composing by UNION', () => {
    const result = generatePolicyDocument({
      catalogData: mixedLargeCatalog(),
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
    for (const s of result.documents.flatMap(d => d.Statement)) {
      expect(s.Effect).toBe('Deny');
      expect(s.NotAction).toBeUndefined();
    }
    // The UNION of Deny actions across all documents is exactly the
    // unavailable set — nothing lost to the split, nothing available denied.
    const denyUnion = new Set(actionsFor(result, 'Deny'));
    for (let i = 0; i < 1500; i++) expect(denyUnion.has(`gone${i}:*`)).toBe(true);
    for (let i = 0; i < 600; i++) expect(denyUnion.has(`avail${i}:*`)).toBe(false);
    expect(denyUnion.size).toBe(1500);
  });

  it('denies the unavailable actions of partially-available services in a split deny-list', () => {
    const result = generatePolicyDocument({
      catalogData: [
        ...mixedLargeCatalog(),
        buildService('parta', [
          ...Array.from({ length: 20 }, (_, i) => ({ name: `Ok${i}`, available: true })),
          { name: 'Gone', available: false },
        ]),
        buildService('partb', [
          { name: 'Ok', available: true },
          ...Array.from({ length: 20 }, (_, i) => ({ name: `Gone${i}`, available: false })),
        ]),
      ],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    const denyUnion = new Set(actionsFor(result, 'Deny'));
    expect(denyUnion.has('parta:Gone')).toBe(true);
    for (let i = 0; i < 20; i++) expect(denyUnion.has(`partb:Gone${i}`)).toBe(true);
    expect(denyUnion.has('partb:Ok')).toBe(false);
    expect(denyUnion.has('parta:*')).toBe(false);
    expect(denyUnion.has('partb:*')).toBe(false);
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

  // Generated documents must only ever restrict.
  it('never emits an Allow statement, and IAM never uses NotAction', () => {
    const partial = [
      buildService('s3', [
        { name: 'A', available: true },
        { name: 'B', available: false },
      ]),
    ];
    const strategyA = [
      buildService('s3', [
        ...Array.from({ length: 20 }, (_, i) => ({ name: `Ok${i}`, available: true })),
        { name: 'Gone', available: false },
      ]),
    ];
    const lowAvail = [
      buildService('s3', [{ name: 'A', available: true }]),
      ...Array.from({ length: 100 }, (_, i) => buildService(`u${i}`, [{ name: 'A', available: false }])),
    ];

    let statements = 0;
    for (const catalogData of [partial, strategyA, lowAvail, mixedLargeCatalog()]) {
      for (const policyType of ['IAM', 'SCP'] as const) {
        const r = generatePolicyDocument({
          catalogData,
          configuration: config({ policyType }),
          policyName: 'T',
          generationTimestamp: TS,
        });
        const stmts = r.documents.flatMap(d => d.Statement);
        statements += stmts.length;
        expect(stmts.every(s => s.Effect === 'Deny')).toBe(true);
        if (policyType === 'IAM') expect(stmts.every(s => s.NotAction === undefined)).toBe(true);
      }
    }
    expect(statements).toBeGreaterThan(0);
  });
});

describe('generatePolicyDocument — exceptions', () => {
  it('treats exception actions as available (their service is whitelisted, not denied)', () => {
    const result = generatePolicyDocument({
      catalogData: [
        buildService('s3', [{ name: 'GetObject', available: true }]),
        buildService('thingthatdoesntexist', [{ name: 'DoSomething', available: false }]),
      ],
      configuration: config({
        policyType: 'SCP',
        exceptions: [{ action: 'thingthatdoesntexist:DoSomething', addedAt: '2026-01-01T00:00:00Z' }],
      }),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(whitelistFor(result)).toContain('thingthatdoesntexist:*');
    expect(actionsFor(result, 'Deny')).not.toContain('thingthatdoesntexist:*');
  });
});
