import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { PolicyStatus, RefreshOutcome } from '@capability-insights/shared/types/policy-enforcer/policy-enums';

// ---- Mock all collaborators of policy-routes.ts ---------------------------

vi.mock('../services/s3-client', () => {
  const getObject = vi.fn();
  return {
    S3BucketClient: vi.fn().mockImplementation(() => ({ getObject })),
    __getObjectStub: getObject,
  };
});

// vi.mock factories are hoisted; declare mock classes INSIDE the factory and
// re-import them in the test below so we can throw them from `mockRejectedValue`.
vi.mock('../services/policy-enforcer/policy-config-store', () => {
  class PolicyNameConflictError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'PolicyNameConflictError';
    }
  }
  class PolicyNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'PolicyNotFoundError';
    }
  }
  const storeStub = {
    createPolicy: vi.fn(),
    getPolicy: vi.fn(),
    listPolicies: vi.fn(),
    updatePolicy: vi.fn(),
    deletePolicy: vi.fn(),
  };
  return {
    PolicyConfigStore: vi.fn().mockImplementation(() => storeStub),
    PolicyNameConflictError,
    PolicyNotFoundError,
    // Expose the singleton stub so tests can configure it after import.
    __storeStub: storeStub,
  };
});

vi.mock('../services/policy-enforcer/iam-policy-applier', () => {
  const applierStub = {
    apply: vi.fn(),
    deleteAll: vi.fn(),
  };
  return {
    IamPolicyApplier: vi.fn().mockImplementation(() => applierStub),
    __applierStub: applierStub,
  };
});

vi.mock('../policy-enforcer/allow-list-engine', () => ({
  computeAllowList: vi.fn(() => ({
    actions: ['s3:GetObject', 's3:PutObject'],
    actionCount: 2,
    excludedCount: 5,
    exceptionCount: 0,
  })),
}));

vi.mock('../policy-enforcer/policy-document-generator', () => {
  const generatePolicyDocument = vi.fn(() => ({
    documents: [{ Version: '2012-10-17', Statement: [] }],
    totalSize: 100,
    splitRequired: false,
    blanketDenyServiceCount: 0,
    fullyAvailableServiceCount: 0,
    partiallyAvailableServiceCount: 0,
    partialDenyActionCount: 0,
    error: undefined as string | undefined,
  }));
  return {
    generatePolicyDocument,
    __generateStub: generatePolicyDocument,
  };
});

vi.mock('../policy-enforcer/validation', () => ({
  validatePolicyConfiguration: vi.fn(() => ({ valid: true, errors: [] })),
  validatePolicyUpdate: vi.fn(() => ({ valid: true, errors: [] })),
}));

// ---- Module under test ---------------------------------------------------

import {
  createPolicyRoute,
  listPoliciesRoute,
  getPolicyRoute,
  updatePolicyRoute,
  deletePolicyRoute,
  refreshPolicyRoute,
  previewPolicyRoute,
  _resetForTests,
} from './policy-routes';
import { validatePolicyConfiguration, validatePolicyUpdate } from '../policy-enforcer/validation';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — exposed by the vi.mock factory above
import {
  __storeStub as storeMock,
  PolicyNameConflictError,
  PolicyNotFoundError,
} from '../services/policy-enforcer/policy-config-store';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — exposed by the vi.mock factory above
import { __applierStub as applierMock } from '../services/policy-enforcer/iam-policy-applier';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — exposed by the vi.mock factory above
import { __generateStub as generatePolicyDocumentMock } from '../policy-enforcer/policy-document-generator';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — exposed by the vi.mock factory above
import { __getObjectStub as mockGetObject } from '../services/s3-client';

// ---- Helpers --------------------------------------------------------------

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/policies',
    body: null,
    headers: {},
    multiValueHeaders: {},
    isBase64Encoded: false,
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '',
    requestContext: {
      accountId: '123456789012',
      apiId: 'test',
      authorizer: null,
      protocol: 'HTTP/1.1',
      httpMethod: 'GET',
      identity: {} as APIGatewayProxyEvent['requestContext']['identity'],
      path: '/policies',
      stage: 'prod',
      requestId: 'test-id',
      requestTimeEpoch: 0,
      resourceId: '',
      resourcePath: '',
    },
    ...overrides,
  };
}

const samplePolicy = {
  policyName: 'Payments',
  tags: [],
  regions: ['us-east-1'],
  mode: 'intersection',
  policyType: 'IAM',
  exceptions: [],
  status: PolicyStatus.PENDING,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  _resetForTests();
  Object.values(storeMock).forEach(fn => (fn as ReturnType<typeof vi.fn>).mockReset());
  applierMock.apply.mockReset();
  applierMock.deleteAll.mockReset();
  mockGetObject.mockReset();
  generatePolicyDocumentMock.mockReset();
  generatePolicyDocumentMock.mockReturnValue({
    documents: [{ Version: '2012-10-17', Statement: [] }],
    totalSize: 100,
    splitRequired: false,
    blanketDenyServiceCount: 0,
    fullyAvailableServiceCount: 0,
    partiallyAvailableServiceCount: 0,
    partialDenyActionCount: 0,
    error: undefined,
  });
  (validatePolicyConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({ valid: true, errors: [] });
  (validatePolicyUpdate as ReturnType<typeof vi.fn>).mockReturnValue({ valid: true, errors: [] });
  vi.stubEnv('POLICY_TABLE_NAME', 'CapabilityInsightsPolicyConfiguration');
  vi.stubEnv('WEBSITE_BUCKET_NAME', 'test-bucket');
  vi.stubEnv('IAM_HELPER_LAMBDA_NAME', 'helper');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---- Tests ----------------------------------------------------------------

describe('createPolicyRoute', () => {
  const validBody = JSON.stringify({
    policyName: 'Payments',
    regions: ['us-east-1'],
    mode: 'intersection',
    policyType: 'IAM',
  });

  it('returns 400 when body is missing', async () => {
    const result = await createPolicyRoute(makeEvent({ httpMethod: 'POST', body: null }));
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when validation fails', async () => {
    (validatePolicyConfiguration as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      valid: false,
      errors: ['policyName is required'],
    });

    const result = await createPolicyRoute(makeEvent({ httpMethod: 'POST', body: validBody }));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).message).toContain('policyName');
  });

  it('returns 409 when the store reports a name conflict', async () => {
    storeMock.createPolicy.mockRejectedValueOnce(new PolicyNameConflictError('exists'));

    const result = await createPolicyRoute(makeEvent({ httpMethod: 'POST', body: validBody }));
    expect(result.statusCode).toBe(409);
  });

  it('returns 201 + inline-refresh + flips policy to ACTIVE on the happy path', async () => {
    storeMock.createPolicy.mockResolvedValueOnce(samplePolicy);
    mockGetObject.mockResolvedValueOnce(JSON.stringify([{ id: 's3' }]));
    applierMock.apply.mockResolvedValueOnce({
      policyArn: 'arn:aws:iam::123456789012:policy/PolicyEnforcer-Payments',
      additionalPolicyArns: [],
    });
    storeMock.updatePolicy.mockResolvedValueOnce({
      ...samplePolicy,
      status: PolicyStatus.ACTIVE,
      policyArn: 'arn:aws:iam::123456789012:policy/PolicyEnforcer-Payments',
    });

    const result = await createPolicyRoute(makeEvent({ httpMethod: 'POST', body: validBody }));

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.policy.status).toBe(PolicyStatus.ACTIVE);
    expect(body.refresh.policyArn).toBe('arn:aws:iam::123456789012:policy/PolicyEnforcer-Payments');
    expect(body.refresh.actionCount).toBe(2);

    const updateCall = storeMock.updatePolicy.mock.calls[0][1];
    expect(updateCall.status).toBe(PolicyStatus.ACTIVE);
    expect(updateCall.lastRefreshOutcome).toBe(RefreshOutcome.SUCCESS);
    expect(updateCall.lastActionCount).toBe(2);
  });

  it('returns 201 with pending policy when catalog is temporarily unavailable', async () => {
    storeMock.createPolicy.mockResolvedValueOnce(samplePolicy);
    mockGetObject.mockRejectedValueOnce(new Error('NoSuchKey'));

    const result = await createPolicyRoute(makeEvent({ httpMethod: 'POST', body: validBody }));

    expect(result.statusCode).toBe(201);
    expect(applierMock.apply).not.toHaveBeenCalled();
    expect(storeMock.updatePolicy).not.toHaveBeenCalled();
    const body = JSON.parse(result.body);
    expect(body.policy.status).toBe(PolicyStatus.PENDING);
  });

  it('returns 400 and deletes the row when generated policy exceeds size limit on create', async () => {
    storeMock.createPolicy.mockResolvedValueOnce(samplePolicy);
    mockGetObject.mockResolvedValueOnce(JSON.stringify([]));
    generatePolicyDocumentMock.mockReturnValueOnce({
      documents: [],
      totalSize: 9999,
      splitRequired: false,
      blanketDenyServiceCount: 0,
      fullyAvailableServiceCount: 0,
      partiallyAvailableServiceCount: 0,
      partialDenyActionCount: 0,
      error: 'SCP would exceed 5,120 char limit',
    });
    storeMock.deletePolicy.mockResolvedValueOnce(undefined);

    const result = await createPolicyRoute(makeEvent({ httpMethod: 'POST', body: validBody }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).message).toContain('5,120');
    expect(applierMock.apply).not.toHaveBeenCalled();
    // Row + name shadow are deleted so the user can retry the same name.
    expect(storeMock.deletePolicy).toHaveBeenCalledWith(samplePolicy.policyName);
    // The row was never marked ACTIVE, and we shouldn't have flipped it to
    // ERROR before deleting it.
    expect(storeMock.updatePolicy).not.toHaveBeenCalled();
  });

  it('returns 400 and tolerates failure to clean up the orphan row', async () => {
    storeMock.createPolicy.mockResolvedValueOnce(samplePolicy);
    mockGetObject.mockResolvedValueOnce(JSON.stringify([]));
    generatePolicyDocumentMock.mockReturnValueOnce({
      documents: [],
      totalSize: 9999,
      splitRequired: false,
      blanketDenyServiceCount: 0,
      fullyAvailableServiceCount: 0,
      partiallyAvailableServiceCount: 0,
      partialDenyActionCount: 0,
      error: 'SCP would exceed 5,120 char limit',
    });
    storeMock.deletePolicy.mockRejectedValueOnce(new Error('TransientDdbError'));

    const result = await createPolicyRoute(makeEvent({ httpMethod: 'POST', body: validBody }));

    expect(result.statusCode).toBe(400);
    expect(applierMock.apply).not.toHaveBeenCalled();
  });
});

describe('listPoliciesRoute', () => {
  it('passes through query filters to the store', async () => {
    storeMock.listPolicies.mockResolvedValueOnce([]);

    await listPoliciesRoute(
      makeEvent({
        queryStringParameters: { tagKey: 'team', tagValue: 'core', status: 'active', search: 'pay' },
      }),
    );

    expect(storeMock.listPolicies).toHaveBeenCalledWith({
      tagKey: 'team',
      tagValue: 'core',
      status: 'active',
      search: 'pay',
    });
  });

  it('returns 200 with the policy list', async () => {
    storeMock.listPolicies.mockResolvedValueOnce([samplePolicy]);
    const result = await listPoliciesRoute(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).policies).toEqual([samplePolicy]);
  });
});

describe('getPolicyRoute', () => {
  it('returns 404 when the policy does not exist', async () => {
    storeMock.getPolicy.mockResolvedValueOnce(null);
    const result = await getPolicyRoute(makeEvent(), { policyName: 'missing' });
    expect(result.statusCode).toBe(404);
  });

  it('returns 200 with the policy', async () => {
    storeMock.getPolicy.mockResolvedValueOnce(samplePolicy);
    const result = await getPolicyRoute(makeEvent(), { policyName: 'Payments' });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).policy).toEqual(samplePolicy);
  });
});

describe('updatePolicyRoute', () => {
  const validBody = JSON.stringify({ description: 'updated' });

  it('returns 400 when validation fails', async () => {
    (validatePolicyUpdate as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      valid: false,
      errors: ['policyName must be non-empty'],
    });

    const result = await updatePolicyRoute(makeEvent({ httpMethod: 'PUT', body: validBody }), {
      policyName: 'Payments',
    });
    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when the store reports the policy is missing', async () => {
    storeMock.updatePolicy.mockRejectedValueOnce(new PolicyNotFoundError('not found'));

    const result = await updatePolicyRoute(makeEvent({ httpMethod: 'PUT', body: validBody }), {
      policyName: 'missing',
    });
    expect(result.statusCode).toBe(404);
  });

  it('refreshes inline and persists ACTIVE state on success', async () => {
    storeMock.updatePolicy.mockResolvedValueOnce({ ...samplePolicy, description: 'updated' }).mockResolvedValueOnce({
      ...samplePolicy,
      description: 'updated',
      status: PolicyStatus.ACTIVE,
    });
    mockGetObject.mockResolvedValueOnce('[]');
    applierMock.apply.mockResolvedValueOnce({
      policyArn: 'arn:aws:iam::1:policy/Payments',
      additionalPolicyArns: [],
    });

    const result = await updatePolicyRoute(makeEvent({ httpMethod: 'PUT', body: validBody }), {
      policyName: 'Payments',
    });

    expect(result.statusCode).toBe(200);
    expect(applierMock.apply).toHaveBeenCalled();
    expect(storeMock.updatePolicy).toHaveBeenCalledTimes(2);
    expect(storeMock.updatePolicy.mock.calls[1][1].status).toBe(PolicyStatus.ACTIVE);
  });
});

describe('deletePolicyRoute', () => {
  it('returns 404 when the policy is missing', async () => {
    storeMock.getPolicy.mockResolvedValueOnce(null);
    const result = await deletePolicyRoute(makeEvent(), { policyName: 'missing' });
    expect(result.statusCode).toBe(404);
    expect(applierMock.deleteAll).not.toHaveBeenCalled();
  });

  it('removes IAM resources before deleting the DDB record', async () => {
    storeMock.getPolicy.mockResolvedValueOnce({
      ...samplePolicy,
      policyArn: 'arn:1',
      additionalPolicyArns: ['arn:2'],
    });
    storeMock.deletePolicy.mockResolvedValueOnce(undefined);

    const result = await deletePolicyRoute(makeEvent(), { policyName: 'Payments' });

    expect(result.statusCode).toBe(200);
    expect(applierMock.deleteAll).toHaveBeenCalledWith(['arn:1', 'arn:2']);
    expect(storeMock.deletePolicy).toHaveBeenCalledWith('Payments');
  });

  it('still deletes the DDB record when IAM cleanup partially fails', async () => {
    storeMock.getPolicy.mockResolvedValueOnce({
      ...samplePolicy,
      policyArn: 'arn:1',
    });
    applierMock.deleteAll.mockRejectedValueOnce(new Error('AccessDenied'));
    storeMock.deletePolicy.mockResolvedValueOnce(undefined);

    const result = await deletePolicyRoute(makeEvent(), { policyName: 'Payments' });

    expect(result.statusCode).toBe(200);
    expect(storeMock.deletePolicy).toHaveBeenCalledWith('Payments');
  });
});

describe('refreshPolicyRoute', () => {
  it('returns 404 when the policy is missing', async () => {
    storeMock.getPolicy.mockResolvedValueOnce(null);
    const result = await refreshPolicyRoute(makeEvent({ httpMethod: 'POST' }), { policyName: 'missing' });
    expect(result.statusCode).toBe(404);
  });

  it('returns 503 when the catalog is unavailable', async () => {
    storeMock.getPolicy.mockResolvedValueOnce(samplePolicy);
    mockGetObject.mockRejectedValueOnce(new Error('NoSuchKey'));

    const result = await refreshPolicyRoute(makeEvent({ httpMethod: 'POST' }), { policyName: 'Payments' });
    expect(result.statusCode).toBe(503);
  });

  it('flips status to ERROR + returns 400 when generated policy exceeds size', async () => {
    storeMock.getPolicy.mockResolvedValueOnce(samplePolicy);
    mockGetObject.mockResolvedValueOnce('[]');
    generatePolicyDocumentMock.mockReturnValueOnce({
      documents: [],
      totalSize: 9999,
      splitRequired: false,
      blanketDenyServiceCount: 0,
      fullyAvailableServiceCount: 0,
      partiallyAvailableServiceCount: 0,
      partialDenyActionCount: 0,
      error: 'Too large',
    });
    storeMock.updatePolicy.mockResolvedValueOnce(samplePolicy);

    const result = await refreshPolicyRoute(makeEvent({ httpMethod: 'POST' }), { policyName: 'Payments' });

    expect(result.statusCode).toBe(400);
    expect(storeMock.updatePolicy.mock.calls[0][1].status).toBe(PolicyStatus.ERROR);
  });
});

describe('previewPolicyRoute', () => {
  it('returns 404 when the policy is missing', async () => {
    storeMock.getPolicy.mockResolvedValueOnce(null);
    const result = await previewPolicyRoute(makeEvent(), { policyName: 'missing' });
    expect(result.statusCode).toBe(404);
  });

  it('returns the computed preview without applying any IAM changes', async () => {
    storeMock.getPolicy.mockResolvedValueOnce(samplePolicy);
    mockGetObject.mockResolvedValueOnce('[]');

    const result = await previewPolicyRoute(makeEvent(), { policyName: 'Payments' });

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.actions).toEqual(['s3:GetObject', 's3:PutObject']);
    expect(body.actionCount).toBe(2);
    expect(body.estimatedPolicySize).toBe(100);
    expect(body.splitRequired).toBe(false);
    expect(applierMock.apply).not.toHaveBeenCalled();
  });

  it('returns 503 when the catalog is unavailable', async () => {
    storeMock.getPolicy.mockResolvedValueOnce(samplePolicy);
    mockGetObject.mockRejectedValueOnce(new Error('NoSuchKey'));

    const result = await previewPolicyRoute(makeEvent(), { policyName: 'Payments' });
    expect(result.statusCode).toBe(503);
  });
});
