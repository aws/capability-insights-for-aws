import { describe, it, expect } from 'vitest';
import { generateAllowTemplate, generatePolicyDocument } from './policy-document-generator';
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

  // The catalog models execute-api only through ApiGatewayManagementApi and neptune-db through neptunedata,
  // but execute-api:Invoke and neptune-db:connect work wherever API Gateway and Neptune do.
  it.each([
    ['apigateway', 'execute-api', 'Invoke'],
    ['rds', 'neptune-db', 'connect'],
  ])('never denies the partially-modeled namespace under %s (%s) wholesale', (parent, prefix, iamOnlyAction) => {
    const result = generatePolicyDocument({
      catalogData: [
        buildService(parent, [{ name: 'Describe', available: true }]),
        buildService(prefix, [
          { name: 'GetThing', available: false },
          { name: 'PutThing', available: false },
        ]),
      ],
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });

    expect(actionsFor(result, 'Deny')).toEqual([`${prefix}:GetThing`, `${prefix}:PutThing`]);
    expect(isDenied(result, `${prefix}:${iamOnlyAction}`)).toBe(false);
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

  // Several catalog services can map to one IAM prefix (e.g. MediaStore and
  // MediaStore Data), so one unavailable service can't deny the prefix.
  it('does not deny a shared IAM prefix in the deny-list fallback when another service with it is available', () => {
    const services: ApiService[] = [];
    for (let i = 0; i < 600; i++) services.push(buildService(`avail${i}`, [{ name: 'A', available: true }]));
    for (let i = 0; i < 200; i++) services.push(buildService(`gone${i}`, [{ name: 'A', available: false }]));
    services.push(buildService('mediastore', [{ name: 'DescribeContainer', available: true }]));
    services.push(buildService('mediastore', [{ name: 'GetObject', available: false }]));
    const result = generatePolicyDocument({
      catalogData: services,
      configuration: config({ policyType: 'SCP' }),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.error).toBeUndefined();
    expect(whitelistFor(result)).toBeUndefined(); // fell back to the deny-list
    expect(isDenied(result, 'mediastore:DescribeContainer')).toBe(false);
    expect(isDenied(result, 'mediastore:GetObject')).toBe(true);
  });

  it('does not narrow out an action that another service with the same IAM prefix makes available', () => {
    // Mostly available, so the whitelist allows chime:* and narrows out the rest.
    const apis = Array.from({ length: 20 }, (_, i) => ({ name: `Avail${i}`, available: true }));
    apis.push({ name: 'Shared', available: false }, { name: 'OnlyHere', available: false });
    const result = generatePolicyDocument({
      catalogData: [buildService('chime', apis), buildService('chime', [{ name: 'Shared', available: true }])],
      configuration: config({ policyType: 'SCP' }),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.error).toBeUndefined();
    expect(whitelistFor(result)).toEqual(['chime:*']);
    expect(actionsFor(result, 'Deny')).toEqual(['chime:OnlyHere']);
    expect(isDenied(result, 'chime:Shared')).toBe(false);
  });

  it('narrows a shared prefix in the whitelist with every action the IAM deny-list denies', () => {
    // `connect:*` and `lambda:*` are whitelisted for fully-available services, so
    // a sibling's unavailable actions (fully unavailable, or listed action by
    // action) must be narrowed out, or the SCP would let them through.
    const catalogData = [
      buildService('connect', [{ name: 'ListSegments', available: true }]),
      buildService('connect', [
        { name: 'CreateInstance', available: false },
        { name: 'StartChat', available: false },
      ]),
      buildService('lambda', [{ name: 'Invoke', available: true }]),
      buildService('lambda', [
        { name: 'GetMicroVm', available: true },
        { name: 'CreateMicroVmWithLongName', available: false },
        { name: 'DeleteMicroVmWithLongName', available: false },
      ]),
      ...Array.from({ length: 50 }, (_, i) => buildService(`unavail${i}`, [{ name: 'A', available: false }])),
    ];
    const generate = (policyType: 'IAM' | 'SCP') =>
      generatePolicyDocument({
        catalogData,
        configuration: config({ policyType }),
        policyName: 'Test',
        generationTimestamp: TS,
      });
    const scp = generate('SCP');
    expect(scp.error).toBeUndefined();
    expect(whitelistFor(scp)).toContain('connect:*');
    expect(whitelistFor(scp)).toContain('lambda:*');
    const iamDenied = actionsFor(generate('IAM'), 'Deny');
    expect(iamDenied).toContain('connect:CreateInstance');
    expect(iamDenied).toContain('lambda:CreateMicroVmWithLongName');
    for (const action of iamDenied) expect(isDenied(scp, action)).toBe(true);
    for (const action of ['connect:ListSegments', 'lambda:Invoke', 'lambda:GetMicroVm']) {
      expect(isDenied(scp, action)).toBe(false);
    }
  });

  // A fully-available service whitelists `connect:*`; its sibling's N unavailable actions must be narrowed out.
  const narrowingCatalog = (n: number): ApiService[] => [
    buildService('connect', [{ name: 'ListSegments', available: true }]),
    buildService(
      'connect',
      Array.from({ length: n }, (_, i) => ({ name: `UnavailableActionNumber${i}`, available: false })),
    ),
  ];

  it('keeps the whitelist when its narrowing needs several documents, each within the SCP size limit', () => {
    const result = generatePolicyDocument({
      catalogData: narrowingCatalog(250),
      configuration: config({ policyType: 'SCP' }),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.error).toBeUndefined();
    expect(whitelistFor(result)).toEqual(['connect:*']);
    expect(result.documents.length).toBeGreaterThan(2);
    expect(result.documents.length).toBeLessThanOrEqual(5);
    for (const doc of result.documents) expect(JSON.stringify(doc).length).toBeLessThanOrEqual(5120);
    expect(isDenied(result, 'connect:UnavailableActionNumber249')).toBe(true);
    expect(isDenied(result, 'connect:ListSegments')).toBe(false);
  });

  it('errors (pointing to IAM) when the whitelist fits but its narrowing overflows the SCP budget', () => {
    const result = generatePolicyDocument({
      catalogData: narrowingCatalog(1000),
      configuration: config({ policyType: 'SCP' }),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.error).toMatch(/IAM Policy type/);
    expect(result.error).toMatch(/fits in one document but needs \d+ more/);
    expect(result.error).not.toMatch(/too many services are available/);
  });

  it('errors instead of returning no documents when there is nothing for the SCP to restrict', () => {
    // Too many services to whitelist in one document, and every one of them is available.
    const services: ApiService[] = [];
    for (let i = 0; i < 600; i++) services.push(buildService(`avail${i}`, [{ name: 'A', available: true }]));
    const result = generatePolicyDocument({
      catalogData: services,
      configuration: config({ policyType: 'SCP' }),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.error).toMatch(/nothing for this SCP to restrict/);
    expect(result.documents).toHaveLength(0);
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

describe('generateAllowTemplate', () => {
  const template = (catalogData: ApiService[], overrides: Partial<PolicyConfiguration> = {}) =>
    generateAllowTemplate({
      catalogData,
      configuration: config(overrides),
      policyName: 'Test',
      generationTimestamp: TS,
    });
  type Template = ReturnType<typeof generateAllowTemplate>;
  const allowed = (result: Template): string[] =>
    result.documents.flatMap(d => d.Statement).flatMap(s => s.Action ?? []);
  const isAllowed = (result: Template, action: string): boolean =>
    allowed(result).some(e => e === action || (e.endsWith(':*') && action.startsWith(e.slice(0, -1))));

  it('emits only Allow statements and wildcards a fully-available prefix', () => {
    const result = template([
      buildService('s3', [
        { name: 'GetObject', available: true },
        { name: 'PutObject', available: true },
      ]),
      buildService('gone', [{ name: 'A', available: false }]),
    ]);
    expect(result.error).toBeUndefined();
    for (const s of result.documents.flatMap(d => d.Statement)) {
      expect(s.Effect).toBe('Allow');
      expect(s.NotAction).toBeUndefined();
    }
    expect(allowed(result)).toEqual(['s3:*']);
  });

  it('allows a whole service when any of its actions is available, and omits a fully-unavailable one', () => {
    const result = template([
      buildService('connect', [{ name: 'ListSegments', available: true }]),
      buildService('connect', [{ name: 'CreateInstance', available: false }]),
      buildService('lambda', [
        { name: 'Invoke', available: true },
        { name: 'CreateMicroVm', available: false },
      ]),
      buildService('gone', [{ name: 'A', available: false }]),
    ]);
    expect(allowed(result)).toEqual(['connect:*', 'lambda:*']);
    expect(isAllowed(result, 'gone:A')).toBe(false);
  });

  // The catalog can list these SDKs as unavailable where API Gateway and Neptune work, and the
  // Deny parts never deny the namespaces wholesale, so the template keeps execute-api:Invoke and neptune-db:connect.
  it.each([
    ['apigateway', 'execute-api'],
    ['rds', 'neptune-db'],
  ])('always includes the partially-modeled namespace under %s (%s)', (parent, prefix) => {
    const result = template([
      buildService(parent, [{ name: 'Describe', available: true }]),
      buildService(prefix, [{ name: 'GetThing', available: false }]),
    ]);
    expect(allowed(result)).toEqual([`${parent}:*`, `${prefix}:*`].sort());
  });

  it('errors when only the partially-modeled namespaces are present (e.g. a region with no capability data)', () => {
    const result = template([
      buildService('s3', [{ name: 'GetObject', available: false }]),
      buildService('execute-api', [{ name: 'PostToConnection', available: false }]),
      buildService('neptune-db', [{ name: 'GetEngineStatus', available: false }]),
    ]);
    expect(result.error).toMatch(/No capabilities are available/);
    expect(result.documents).toHaveLength(0);
  });

  it('includes exceptions, and a service-wide exception covers the listed actions', () => {
    const result = template(
      [
        buildService('s3', [
          { name: 'GetObject', available: true },
          { name: 'PutObject', available: false },
        ]),
        buildService('ecr', [{ name: 'PutImage', available: false }]),
        buildService('gone', [{ name: 'A', available: false }]),
      ],
      {
        exceptions: [
          { action: 's3:PutObject', addedAt: '2026-01-01T00:00:00Z' },
          { action: 'ecr:*', addedAt: '2026-01-01T00:00:00Z' },
          { action: 'ecr:PutImage', addedAt: '2026-01-01T00:00:00Z' },
          { action: 'gone:A', addedAt: '2026-01-01T00:00:00Z' },
          { action: 'ssmmessages:OpenDataChannel', addedAt: '2026-01-01T00:00:00Z' },
        ],
      },
    );
    expect(allowed(result)).toEqual(['ecr:*', 'gone:*', 's3:*', 'ssmmessages:OpenDataChannel']);
  });

  it('splits a large template into parts that each fit one managed policy, composing by UNION', () => {
    const result = template(mixedLargeCatalog());
    expect(result.error).toBeUndefined();
    expect(result.documents.length).toBeGreaterThan(1);
    for (const doc of result.documents) expect(JSON.stringify(doc).length).toBeLessThanOrEqual(6144);
    const union = new Set(allowed(result));
    for (let i = 0; i < 600; i++) expect(union.has(`avail${i}:*`)).toBe(true);
    expect(union.size).toBe(600);
    expect(result.totalSize).toBe(result.documents.reduce((n, d) => n + JSON.stringify(d).length, 0));
  });

  it('errors when nothing is available in the selected region(s)', () => {
    const result = template([buildService('s3', [{ name: 'GetObject', available: false }])]);
    expect(result.error).toMatch(/No capabilities are available/);
    expect(result.documents).toHaveLength(0);
  });

  it('combined with the Deny parts, allows exactly the available actions', () => {
    // The template is service-level; the Deny parts (like the SCP) remove the unavailable actions.
    const catalogData = [
      buildService('s3', [
        { name: 'GetObject', available: true },
        { name: 'PutObject', available: false },
      ]),
      buildService('connect', [{ name: 'ListSegments', available: true }]),
      buildService('connect', [{ name: 'CreateInstance', available: false }]),
      buildService('gone', [{ name: 'A', available: false }]),
    ];
    const allowTemplate = template(catalogData);
    const deny = generatePolicyDocument({
      catalogData,
      configuration: config(),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    const available = new Set(['s3:GetObject', 'connect:ListSegments']);
    for (const action of ['s3:GetObject', 's3:PutObject', 'connect:ListSegments', 'connect:CreateInstance', 'gone:A']) {
      expect(isAllowed(allowTemplate, action) && !isDenied(deny, action)).toBe(available.has(action));
    }
  });
});

describe('union mode', () => {
  // `in` lists the regions where the action is available; config regions are us-east-1 and eu-west-1.
  const svc = (name: string, apis: { name: string; in: string[] }[]): ApiService => ({
    sdkServiceName: name,
    sdkServiceFullName: name,
    apis: apis.map(a => ({
      apiName: a.name,
      apiAction: a.name,
      homepage: '',
      regionalAvailability: Object.fromEntries(a.in.map(r => [r, AvailabilityStatus.AVAILABLE])),
    })),
  });
  const catalogData = [
    svc('s3', [
      { name: 'GetObject', in: ['us-east-1'] },
      { name: 'PutObject', in: [] },
    ]),
    svc('gone', [{ name: 'A', in: [] }]),
  ];
  const run = (policyType: 'IAM' | 'SCP') =>
    generatePolicyDocument({
      catalogData,
      configuration: config({ mode: 'union', policyType }),
      policyName: 'Test',
      generationTimestamp: TS,
    });

  it.each(['IAM', 'SCP'] as const)('%s: an action available in any selected region is not denied', policyType => {
    const result = run(policyType);
    expect(result.error).toBeUndefined();
    expect(isDenied(result, 's3:GetObject')).toBe(false);
    expect(isDenied(result, 's3:PutObject')).toBe(true);
    expect(isDenied(result, 'gone:A')).toBe(true);
  });

  it('the template allows a service with an action available in any selected region', () => {
    const result = generateAllowTemplate({
      catalogData,
      configuration: config({ mode: 'union' }),
      policyName: 'Test',
      generationTimestamp: TS,
    });
    expect(result.documents.flatMap(d => d.Statement).flatMap(st => st.Action ?? [])).toEqual(['s3:*']);
  });
});
