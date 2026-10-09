import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type {
  ExceptionEntry,
  PolicyConfiguration,
} from '@capability-insights/shared/types/policy-enforcer/policy-configuration';
import { PolicyMode, PolicyType } from '@capability-insights/shared/types/policy-enforcer/policy-enums';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import { toIamAction, toIamServicePrefix } from './iam-action-mapping';

/** AWS hard size limit for an IAM Managed Policy document, in characters. */
const IAM_SIZE_LIMIT = 6144;

/** AWS hard size limit for an SCP document, in characters. */
const SCP_SIZE_LIMIT = 5120;

/**
 * Maximum number of SCPs AWS Organizations allows attached to a single target.
 * SCP denials are additive (an action is blocked if ANY attached SCP denies
 * it), so the deny-list CAN be spread across up to this many documents; beyond
 * it, the restriction genuinely cannot be attached.
 */
const MAX_SCP_DOCUMENTS = 5;

export interface PolicyDocumentOptions {
  catalogData: ApiService[];
  configuration: PolicyConfiguration;
  policyName: string;
  /** ISO 8601 timestamp embedded in `Sid` for traceability. */
  generationTimestamp: string;
}

export interface PolicyStatement {
  Sid: string;
  Effect: 'Allow' | 'Deny';
  Action?: string[];
  /**
   * Used ONLY in a single, never-split whitelist document. `Deny NotAction`
   * intersects when combined across documents, so it must never be bin-packed —
   * it is emitted as exactly one statement or not at all.
   */
  NotAction?: string[];
  Resource: '*';
}

export interface PolicyDocument {
  Version: '2012-10-17';
  Statement: PolicyStatement[];
}

export interface GeneratedPolicy {
  /**
   * One or more documents. All must be attached together. Every statement is a
   * `Deny`, so attaching them can only ever REMOVE permissions. The documents
   * compose correctly when combined:
   *   - IAM: `Deny Action` documents only, which union (an action is blocked
   *     if any document denies it). Splitting is safe.
   *   - SCP: at most one `Deny NotAction` whitelist (never split), plus
   *     `Deny Action` documents, which union.
   * NB: a whitelist is never bin-packed — combining two
   * `Deny NotAction:[disjoint]` documents denies everything except their
   * (empty) intersection, i.e. denies all.
   */
  documents: PolicyDocument[];
  /** Sum of `JSON.stringify(doc).length` across all documents. */
  totalSize: number;
  /** True if the policy required more than one document. */
  splitRequired: boolean;
  /** Services with zero available APIs (fully blocked). */
  blanketDenyServiceCount: number;
  /** Services where every API is available in all selected regions. */
  fullyAvailableServiceCount: number;
  /** Services where some APIs are available and some are not. */
  partiallyAvailableServiceCount: number;
  /** Count of specific (non-wildcard) unavailable actions listed in Deny statements. */
  partialDenyActionCount: number;
  /**
   * Set when generation cannot satisfy the constraints (e.g. an empty
   * allow-list, an SCP deny-list that would exceed the per-target SCP budget,
   * or an IAM policy with nothing to restrict). Callers should surface this to
   * the user as a 400.
   */
  error?: string;
}

/**
 * Per-service classification used to decide which statements to emit.
 */
interface ServiceClassification {
  iamPrefix: string;
  totalAPIs: number;
  /** Count of APIs available under the configured mode. */
  availableAPIs: number;
  /** IAM action strings for APIs available under the configured mode. */
  availableActions: string[];
  /** IAM action strings for APIs NOT available under the configured mode. */
  unavailableActions: string[];
}

/**
 * For each service in the catalog, decide which APIs are "available" under
 * the configured mode (intersection vs union) and which are not. Exceptions
 * are treated as always-available so their parent service appears partially
 * available rather than blanket-denied.
 */
function classifyServices(
  catalogData: ApiService[],
  regions: string[],
  mode: PolicyMode,
  exceptions: ExceptionEntry[],
): ServiceClassification[] {
  const exceptionSet = new Set(exceptions.map(e => e.action));
  const classifications: ServiceClassification[] = [];

  for (const service of catalogData) {
    if (service.apis.length === 0) continue;

    // Use the first API's homepage as the source for the service-wide IAM
    // prefix (every API in a service should share a prefix).
    const sampleHomepage = service.apis[0].homepage;
    const iamPrefix = toIamServicePrefix(service.sdkServiceName, sampleHomepage);
    const availableActions: string[] = [];
    const unavailableActions: string[] = [];

    for (const operation of service.apis) {
      const iamAction = toIamAction(service.sdkServiceName, operation.apiAction, operation.homepage);
      const isExcepted = exceptionSet.has(iamAction);
      const isAvailableByRegion =
        mode === PolicyMode.INTERSECTION
          ? regions.every(region => operation.regionalAvailability[region] === AvailabilityStatus.AVAILABLE)
          : regions.some(region => operation.regionalAvailability[region] === AvailabilityStatus.AVAILABLE);

      if (isAvailableByRegion || isExcepted) {
        availableActions.push(iamAction);
      } else {
        unavailableActions.push(iamAction);
      }
    }

    classifications.push({
      iamPrefix,
      totalAPIs: service.apis.length,
      availableAPIs: availableActions.length,
      availableActions,
      unavailableActions,
    });
  }

  return classifications;
}

function buildDocument(effect: 'Allow' | 'Deny', actions: string[], sid: string): PolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: sid,
        Effect: effect,
        Action: actions,
        Resource: '*',
      },
    ],
  };
}

/**
 * A single-statement `Deny NotAction` (allow-list) document. NEVER bin-packed:
 * combining two `Deny NotAction` documents intersects their exceptions, which
 * denies everything. The caller only emits this when it fits one document.
 */
function buildBlanketDenyDocument(notActions: string[], sid: string): PolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: sid,
        Effect: 'Deny',
        NotAction: notActions,
        Resource: '*',
      },
    ],
  };
}

function getDocumentSize(document: PolicyDocument): number {
  return JSON.stringify(document).length;
}

function sanitize(timestamp: string): string {
  return timestamp.replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Bin-pack `actions` into documents each within `sizeLimit`, using binary
 * search to maximize how many actions fit per document. Safe to split because
 * every produced statement uses the SAME effect on `Action` (not `NotAction`):
 * Allow statements union to a larger allow-list, Deny statements union to a
 * larger deny-list — the combined effect is the union of all chunks.
 *
 * `sidBase` is used verbatim for a single document, and suffixed `Part<N>`
 * when the list spans multiple documents.
 */
function binPackActions(
  actions: string[],
  effect: 'Allow' | 'Deny',
  sidBase: string,
  sizeLimit: number,
): PolicyDocument[] {
  if (actions.length === 0) return [];

  // Measure against the LONGEST Sid any chunk could receive (`…Part<N>` where
  // N is at most the action count). The emitted Sid is never longer than this,
  // so a chunk that fits during measurement still fits after the real Sid —
  // otherwise a bare-Sid measurement underestimates and a `PartN` document can
  // spill past the limit.
  const measurementSid = `${sidBase}Part${actions.length}`;

  // First pass: partition into size-fitting chunks.
  const chunks: string[][] = [];
  let remaining = [...actions];

  while (remaining.length > 0) {
    let lo = 1;
    let hi = remaining.length;
    let bestFit = 0;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = buildDocument(effect, remaining.slice(0, mid), measurementSid);
      if (getDocumentSize(candidate) <= sizeLimit) {
        bestFit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // Pathological: a single action exceeds the limit. Include it anyway so
    // the oversize document is a visible signal rather than a dropped action.
    if (bestFit === 0) bestFit = 1;

    chunks.push(remaining.slice(0, bestFit));
    remaining = remaining.slice(bestFit);
  }

  return chunks.map((chunk, i) =>
    buildDocument(effect, chunk, chunks.length === 1 ? sidBase : `${sidBase}Part${i + 1}`),
  );
}

/**
 * IAM namespaces the catalog models only through a small data-plane SDK, while
 * their key permissions are IAM-only and available wherever the parent service
 * is: `execute-api:Invoke` (calling any IAM-authorized API Gateway API) and
 * `neptune-db:connect`. The catalog derives `execute-api` from
 * ApiGatewayManagementApi and `neptune-db` from neptunedata, and can list
 * those SDKs as unavailable in Regions where API Gateway and Neptune work, so
 * these namespaces are never denied wholesale — only their catalogued
 * unavailable actions are listed.
 */
const PARTIALLY_MODELED_PREFIXES = new Set(['execute-api', 'neptune-db']);

/**
 * The IAM deny-list: every catalog action that is unavailable under the
 * configured mode, merged per IAM service prefix. Several catalog services
 * can map to one prefix (e.g. Lambda and Lambda Core), so an action is denied
 * only if no service with that prefix makes it available, and the whole
 * prefix (`prefix:*`) only if none of its actions are available. Exceptions
 * count as available; a `prefix:*` exception exempts the whole prefix.
 */
function buildIamDenyEntries(
  catalogData: ApiService[],
  regions: string[],
  mode: PolicyMode,
  exceptions: ExceptionEntry[],
): string[] {
  const exceptionSet = new Set(exceptions.map(e => e.action));
  const byPrefix = new Map<string, { available: Set<string>; unavailable: Set<string> }>();

  for (const service of catalogData) {
    for (const operation of service.apis) {
      const prefix = toIamServicePrefix(service.sdkServiceName, operation.homepage);
      const action = `${prefix}:${operation.apiAction}`;
      const isAvailableByRegion =
        mode === PolicyMode.INTERSECTION
          ? regions.every(region => operation.regionalAvailability[region] === AvailabilityStatus.AVAILABLE)
          : regions.some(region => operation.regionalAvailability[region] === AvailabilityStatus.AVAILABLE);

      let entry = byPrefix.get(prefix);
      if (!entry) {
        entry = { available: new Set(), unavailable: new Set() };
        byPrefix.set(prefix, entry);
      }
      (isAvailableByRegion || exceptionSet.has(action) ? entry.available : entry.unavailable).add(action);
    }
  }

  const denyEntries: string[] = [];
  for (const [prefix, { available, unavailable }] of byPrefix) {
    if (exceptionSet.has(`${prefix}:*`)) continue;
    if (available.size === 0 && !PARTIALLY_MODELED_PREFIXES.has(prefix)) {
      denyEntries.push(`${prefix}:*`);
      continue;
    }
    for (const action of unavailable) {
      if (!available.has(action)) denyEntries.push(action);
    }
  }
  return denyEntries.sort();
}

/**
 * Generates IAM/SCP policy documents that restrict access to the capabilities
 * available in the selected region(s).
 *
 * Every statement is a `Deny`, so attaching the documents can only remove
 * permissions. The representation is chosen so that documents COMPOSE
 * correctly when split (see `GeneratedPolicy.documents`):
 *
 *   IAM  → a DENY-LIST of the unavailable actions (`Deny Action:[…]`), merged
 *          per IAM service prefix (see `buildIamDenyEntries`). Never a
 *          `NotAction` whitelist: a whitelist also denies everything the
 *          catalog doesn't model — IAM-only namespaces such as `ssmmessages`
 *          or `rds-db`, and services whose catalog-derived prefix differs from
 *          the real one — overriding the principal's own grants. Actions absent
 *          from the catalog are therefore not denied. Splits safely to any
 *          size, so IAM documents are not capped.
 *
 *   SCP  → prefer a single strict `Deny NotAction:[available]` whitelist when it
 *          fits ONE document (it is never split, so it cannot intersect-to-
 *          deny-all, and stays small for restricted regions). Otherwise fall
 *          back to a DENY-LIST of the unavailable actions (`Deny Action:[…]`,
 *          `service:*` for fully-unavailable services), which unions safely
 *          across documents. If neither fits the per-target SCP budget, return
 *          an error rather than a broken policy. Trade-off: in the deny-list
 *          fallback, services absent from the catalog are allowed, whereas the
 *          whitelist denies them.
 */
export function generatePolicyDocument(options: PolicyDocumentOptions): GeneratedPolicy {
  const { catalogData, configuration, generationTimestamp } = options;
  const { regions, mode, policyType, exceptions } = configuration;

  const classifications = classifyServices(catalogData, regions, mode, exceptions);

  let blanketDenyServiceCount = 0;
  let fullyAvailableServiceCount = 0;
  let partiallyAvailableServiceCount = 0;

  // Actions the SCP whitelist exempts from its `Deny NotAction`. Wildcards +
  // specific actions.
  const allowEntries: string[] = [];
  // Specific unavailable actions to DENY (narrows a whitelisted `service:*`).
  const specificDenyActions: string[] = [];
  // Whole services that are fully unavailable — denied via `service:*`.
  const fullyUnavailableWildcards: string[] = [];
  // Every unavailable action of partially-available services (all strategies) —
  // the SCP deny-list fallback denies these regardless of whitelist encoding.
  const allUnavailableActions: string[] = [];

  const addedAllow = new Set<string>();

  for (const c of classifications) {
    if (c.availableAPIs === 0) {
      // Fully unavailable.
      blanketDenyServiceCount++;
      const wildcard = `${c.iamPrefix}:*`;
      fullyUnavailableWildcards.push(wildcard);
      continue;
    }

    if (c.availableAPIs === c.totalAPIs) {
      // Fully available — whitelist the whole service.
      const wildcard = `${c.iamPrefix}:*`;
      if (!addedAllow.has(wildcard)) {
        allowEntries.push(wildcard);
        addedAllow.add(wildcard);
      }
      fullyAvailableServiceCount++;
      continue;
    }

    // Partially available — pick the cheaper whitelist encoding.
    const wildcard = `${c.iamPrefix}:*`;
    // Strategy A: whitelist `service:*` and deny the unavailable actions.
    const strategyACost = wildcard.length + c.unavailableActions.reduce((sum, a) => sum + a.length + 3, 0);
    // Strategy B: list the available actions.
    const strategyBCost = c.availableActions.reduce((sum, a) => sum + a.length + 3, 0);

    if (strategyBCost <= strategyACost) {
      for (const action of c.availableActions) {
        if (!addedAllow.has(action)) {
          allowEntries.push(action);
          addedAllow.add(action);
        }
      }
    } else {
      if (!addedAllow.has(wildcard)) {
        allowEntries.push(wildcard);
        addedAllow.add(wildcard);
      }
      specificDenyActions.push(...c.unavailableActions);
    }
    allUnavailableActions.push(...c.unavailableActions);
    partiallyAvailableServiceCount++;
  }

  allowEntries.sort();
  const uniqueSpecificDeny = Array.from(new Set(specificDenyActions)).sort();
  const partialDenyActionCount = uniqueSpecificDeny.length;

  const denySid = `PolicyEnforcerDeny${sanitize(generationTimestamp)}`;

  const baseMeta = {
    blanketDenyServiceCount,
    fullyAvailableServiceCount,
    partiallyAvailableServiceCount,
    partialDenyActionCount,
  };

  // Nothing available would make a `Deny NotAction:[]` whitelist (or a
  // deny-list of every service) deny everything — surface it as an error
  // instead of a deny-all policy.
  if (allowEntries.length === 0) {
    return {
      documents: [],
      totalSize: 0,
      splitRequired: false,
      ...baseMeta,
      error:
        'No capabilities are available in the selected region(s), so the allow-list ' +
        'is empty. Check that the region has capability data and is spelled correctly, ' +
        'or select additional regions.',
    };
  }

  if (policyType === PolicyType.SCP) {
    // Preferred: a single strict `Deny NotAction:[available]` whitelist. It is
    // ONE document (never split, so it cannot intersect-to-deny-all), and stays
    // compact when few services are available — the common case for a
    // restricted region. Partially-available services whitelisted via
    // `service:*` are narrowed by `Deny Action` documents, which union safely.
    const whitelistSid = `PolicyEnforcerAllowList${sanitize(generationTimestamp)}`;
    const whitelistDoc = buildBlanketDenyDocument(allowEntries, whitelistSid);
    if (getDocumentSize(whitelistDoc) <= SCP_SIZE_LIMIT) {
      const narrowingDocs = binPackActions(uniqueSpecificDeny, 'Deny', denySid, SCP_SIZE_LIMIT);
      const documents = [whitelistDoc, ...narrowingDocs];
      if (documents.length <= MAX_SCP_DOCUMENTS) {
        const totalSize = documents.reduce((sum, doc) => sum + getDocumentSize(doc), 0);
        return { documents, totalSize, splitRequired: documents.length > 1, ...baseMeta };
      }
    }

    // Fallback (available set too large for one whitelist doc): deny the entire
    // unavailable set with `Deny Action`, which unions safely across documents.
    // Trade-off vs the whitelist: services absent from the catalog are allowed.
    const denyEntries = Array.from(new Set([...fullyUnavailableWildcards, ...allUnavailableActions])).sort();
    if (denyEntries.length === 0) {
      // Everything in the catalog is available; no SCP restriction is required.
      return { documents: [], totalSize: 0, splitRequired: false, ...baseMeta };
    }
    const documents = binPackActions(denyEntries, 'Deny', denySid, SCP_SIZE_LIMIT);
    const totalSize = documents.reduce((sum, doc) => sum + getDocumentSize(doc), 0);

    if (documents.length > MAX_SCP_DOCUMENTS) {
      return {
        documents,
        totalSize,
        splitRequired: true,
        ...baseMeta,
        error:
          `This selection can't be expressed as an SCP within the ${MAX_SCP_DOCUMENTS}-SCP-per-target ` +
          `limit (${SCP_SIZE_LIMIT} characters each): too many services are available to list as a ` +
          `single allow-list SCP, and denying the unavailable set needs ${documents.length} documents. ` +
          'Use the IAM Policy type instead — it has no equivalent per-target limit. (An SCP allow-list ' +
          'for a mixed-availability region can exceed AWS SCP size limits and cannot be split.)',
      };
    }

    return { documents, totalSize, splitRequired: documents.length > 1, ...baseMeta };
  }

  // IAM path: deny-list only.
  const denyEntries = buildIamDenyEntries(catalogData, regions, mode, exceptions);
  if (denyEntries.length === 0) {
    // An empty set would make the applier delete the policy's existing parts.
    return {
      documents: [],
      totalSize: 0,
      splitRequired: false,
      ...baseMeta,
      error:
        'Every capability in the catalog is available in the selected region(s), so there is ' +
        'nothing for this IAM policy to restrict.',
    };
  }
  const documents = binPackActions(denyEntries, 'Deny', denySid, IAM_SIZE_LIMIT);
  const totalSize = documents.reduce((sum, doc) => sum + getDocumentSize(doc), 0);

  return { documents, totalSize, splitRequired: documents.length > 1, ...baseMeta };
}
