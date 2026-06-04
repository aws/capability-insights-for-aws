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

export interface PolicyDocumentOptions {
  catalogData: ApiService[];
  configuration: PolicyConfiguration;
  policyName: string;
  /** ISO 8601 timestamp embedded in `Sid` for traceability. */
  generationTimestamp: string;
}

export interface PolicyStatement {
  Sid: string;
  Effect: 'Deny';
  /** Used in blanket-deny statements. Mutually exclusive with `Action`. */
  NotAction?: string[];
  /** Used in specific-API deny statements (partially-available services). */
  Action?: string[];
  Resource: '*';
}

export interface PolicyDocument {
  Version: '2012-10-17';
  Statement: PolicyStatement[];
}

export interface GeneratedPolicy {
  /** One or more documents. IAM may split; SCP never does. */
  documents: PolicyDocument[];
  /** Sum of `JSON.stringify(doc).length` across all documents. */
  totalSize: number;
  /** True if the IAM allow-list required splitting across multiple documents. */
  splitRequired: boolean;
  /** Services with zero available APIs (covered implicitly by the blanket deny). */
  blanketDenyServiceCount: number;
  /** Services where every API is available in all selected regions. */
  fullyAvailableServiceCount: number;
  /** Services where some APIs are available and some are not. */
  partiallyAvailableServiceCount: number;
  /** Total count of unavailable actions listed in specific-API deny statements. */
  partialDenyActionCount: number;
  /**
   * Set when generation cannot satisfy the constraints (e.g. SCP would
   * exceed 5,120 chars). Callers should surface this to the user as a 400.
   */
  error?: string;
}

/**
 * Per-service classification used to decide which deny strategy to apply.
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

function buildApiDenyDocument(actions: string[], sid: string): PolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: sid,
        Effect: 'Deny',
        Action: actions,
        Resource: '*',
      },
    ],
  };
}

function getDocumentSize(document: PolicyDocument): number {
  return JSON.stringify(document).length;
}

/** Format: `PolicyEnforcerBlanketDeny<timestamp-sanitized>` */
function generateBlanketDenySid(timestamp: string): string {
  return `PolicyEnforcerBlanketDeny${timestamp.replace(/[^a-zA-Z0-9]/g, '')}`;
}

/** Format: `PolicyEnforcerAPIDeny<timestamp-sanitized>Part<N>` */
function generateApiDenySid(timestamp: string, partNumber: number): string {
  return `PolicyEnforcerAPIDeny${timestamp.replace(/[^a-zA-Z0-9]/g, '')}Part${partNumber}`;
}

/**
 * Bin-pack `actions` into IAM-sized documents using binary search to find
 * the maximum number of actions that fit in each document.
 */
function binPackApiDenyActions(actions: string[], timestamp: string): PolicyDocument[] {
  if (actions.length === 0) return [];

  const documents: PolicyDocument[] = [];
  let remaining = [...actions];
  let partNumber = 1;

  while (remaining.length > 0) {
    const sid = generateApiDenySid(timestamp, partNumber);

    let lo = 1;
    let hi = remaining.length;
    let bestFit = 0;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = buildApiDenyDocument(remaining.slice(0, mid), sid);
      if (getDocumentSize(candidate) <= IAM_SIZE_LIMIT) {
        bestFit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // Pathological: a single action exceeds the limit. Include it anyway;
    // the document will exceed the limit, which is the correct signal of
    // an unfittable input rather than silently dropping the action.
    if (bestFit === 0) bestFit = 1;

    documents.push(buildApiDenyDocument(remaining.slice(0, bestFit), sid));
    remaining = remaining.slice(bestFit);
    partNumber++;
  }

  return documents;
}

/**
 * Bin-pack `notActions` into IAM-sized blanket-deny documents.
 */
function binPackBlanketDenyEntries(notActions: string[], baseSid: string): PolicyDocument[] {
  if (notActions.length === 0) {
    // Empty NotAction means "deny everything" — keep one document so the
    // caller can return a structurally-valid policy and surface the warning
    // to the user rather than failing here.
    return [buildBlanketDenyDocument([], baseSid)];
  }

  const documents: PolicyDocument[] = [];
  let remaining = [...notActions];
  let partNumber = 1;

  while (remaining.length > 0) {
    const sid =
      documents.length === 0 && remaining.length === notActions.length ? baseSid : `${baseSid}Part${partNumber}`;

    let lo = 1;
    let hi = remaining.length;
    let bestFit = 0;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = buildBlanketDenyDocument(remaining.slice(0, mid), sid);
      if (getDocumentSize(candidate) <= IAM_SIZE_LIMIT) {
        bestFit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (bestFit === 0) bestFit = 1;

    documents.push(buildBlanketDenyDocument(remaining.slice(0, bestFit), sid));
    remaining = remaining.slice(bestFit);
    partNumber++;
  }

  return documents;
}

/**
 * Generates IAM/SCP policy documents using a two-tier deny strategy with
 * per-service size optimization.
 *
 * Tier 1 (blanket deny): a single statement with `NotAction` containing a
 *   mix of `service:*` wildcards (for fully-available services) and
 *   specific `service:Action` entries (for partially-available services
 *   where listing the available actions is shorter than `service:*` plus a
 *   separate Action deny).
 *
 * Tier 2 (specific API deny): zero or more statements with `Action` lists
 *   containing the specific UNAVAILABLE actions in partially-available
 *   services that opted into Strategy A. Bin-packed into 6,144-char chunks.
 *
 * Per-service strategy selection (for partially-available services):
 *   Strategy A: `service:*` in NotAction, list unavailable actions in a
 *               separate Action deny statement.
 *   Strategy B: list each available action individually in NotAction (no
 *               separate Action deny needed for this service).
 *
 *   Pick whichever produces fewer total characters. Strategy B wins when a
 *   service has many unavailable actions and few available — common in
 *   newer regions where most APIs aren't yet rolled out.
 */
export function generatePolicyDocument(options: PolicyDocumentOptions): GeneratedPolicy {
  const { catalogData, configuration, generationTimestamp } = options;
  const { regions, mode, policyType, exceptions } = configuration;

  const classifications = classifyServices(catalogData, regions, mode, exceptions);

  const notActionEntries: string[] = [];
  const specificDenyActions: string[] = [];
  let blanketDenyServiceCount = 0;
  let fullyAvailableServiceCount = 0;
  let partiallyAvailableServiceCount = 0;

  // Track entries already added to NotAction to avoid duplicates from
  // services that share an IAM prefix (e.g. ELB / ELBv2, both map to
  // `elasticloadbalancing`). Order-dependent edge case: if Service A is
  // partially available and processed via Strategy B (list-available) and
  // Service B with the same prefix is partially available via Strategy A
  // (wildcard + specific deny), the wildcard supersedes A's earlier
  // list-available entries. The result is still semantically correct (the
  // wildcard allows everything in the prefix, the specific-deny statement
  // narrows it) but the policy ends up slightly larger than necessary.
  const addedNotActionEntries = new Set<string>();

  for (const c of classifications) {
    if (c.availableAPIs === 0) {
      // Service is fully unavailable — implicit deny via the blanket statement.
      blanketDenyServiceCount++;
      continue;
    }

    if (c.availableAPIs === c.totalAPIs) {
      // Service is fully available — `service:*` in NotAction.
      const wildcard = `${c.iamPrefix}:*`;
      if (!addedNotActionEntries.has(wildcard)) {
        notActionEntries.push(wildcard);
        addedNotActionEntries.add(wildcard);
      }
      fullyAvailableServiceCount++;
      continue;
    }

    // Partial availability: pick the cheaper strategy.
    const wildcard = `${c.iamPrefix}:*`;

    // Strategy A cost: wildcard in NotAction + every unavailable action in
    // an Action deny. JSON overhead per entry is roughly 3 chars (two
    // quotes + comma).
    const strategyACost = wildcard.length + c.unavailableActions.reduce((sum, a) => sum + a.length + 3, 0);

    // Strategy B cost: every available action listed in NotAction.
    const strategyBCost = c.availableActions.reduce((sum, a) => sum + a.length + 3, 0);

    if (strategyBCost < strategyACost) {
      for (const action of c.availableActions) {
        if (!addedNotActionEntries.has(action)) {
          notActionEntries.push(action);
          addedNotActionEntries.add(action);
        }
      }
    } else {
      if (!addedNotActionEntries.has(wildcard)) {
        notActionEntries.push(wildcard);
        addedNotActionEntries.add(wildcard);
      }
      specificDenyActions.push(...c.unavailableActions);
    }
    partiallyAvailableServiceCount++;
  }

  notActionEntries.sort();
  const uniqueSpecificDenyActions = Array.from(new Set(specificDenyActions)).sort();

  const blanketDenySid = generateBlanketDenySid(generationTimestamp);

  // SCP path: must fit in a single document; cannot split.
  if (policyType === PolicyType.SCP) {
    const statements: PolicyStatement[] = [
      {
        Sid: blanketDenySid,
        Effect: 'Deny',
        NotAction: notActionEntries,
        Resource: '*',
      },
    ];

    if (uniqueSpecificDenyActions.length > 0) {
      statements.push({
        Sid: generateApiDenySid(generationTimestamp, 1),
        Effect: 'Deny',
        Action: uniqueSpecificDenyActions,
        Resource: '*',
      });
    }

    const document: PolicyDocument = { Version: '2012-10-17', Statement: statements };
    const totalSize = getDocumentSize(document);

    if (totalSize > SCP_SIZE_LIMIT) {
      return {
        documents: [document],
        totalSize,
        splitRequired: false,
        blanketDenyServiceCount,
        partialDenyActionCount: uniqueSpecificDenyActions.length,
        fullyAvailableServiceCount,
        partiallyAvailableServiceCount,
        error:
          `SCP document is ${totalSize} characters, exceeding the 5,120-character limit. ` +
          'Service Control Policies cannot be split across multiple documents. ' +
          'Reduce the scope by selecting fewer regions, switching to intersection mode, ' +
          'or use IAM Policy type instead.',
      };
    }

    return {
      documents: [document],
      totalSize,
      splitRequired: false,
      blanketDenyServiceCount,
      partialDenyActionCount: uniqueSpecificDenyActions.length,
      fullyAvailableServiceCount,
      partiallyAvailableServiceCount,
    };
  }

  // IAM path: split if necessary.
  const blanketDocs = binPackBlanketDenyEntries(notActionEntries, blanketDenySid);
  const apiDenyDocs = binPackApiDenyActions(uniqueSpecificDenyActions, generationTimestamp);
  const documents = [...blanketDocs, ...apiDenyDocs];
  const totalSize = documents.reduce((sum, doc) => sum + getDocumentSize(doc), 0);

  return {
    documents,
    totalSize,
    splitRequired: documents.length > 1,
    blanketDenyServiceCount,
    partialDenyActionCount: uniqueSpecificDenyActions.length,
    fullyAvailableServiceCount,
    partiallyAvailableServiceCount,
  };
}
