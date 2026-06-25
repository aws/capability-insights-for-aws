import { S3BucketClient } from '../services/s3-client';
import { EnvironmentKey, getEnv, getOptionalEnv } from '../constants/environment';
import { CatalogKey, usedCapabilitiesKey } from '../constants/data-paths';
import { logger } from '../util/logger';
import { ToolName, type ProposableWriteKind } from './tools';
import type { Region } from '@capability-insights/shared/types/capability/region';
import type { Product } from '@capability-insights/shared/types/capability/product';
import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type { CfnResource, EnrichedCfnResource } from '@capability-insights/shared/types/capability/cfn';
import type { UsedCapabilities } from '@capability-insights/shared/types/used-capabilities';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import type { AnswerFact, AnswerItem, AnswerLink, AnswerPayload } from '@capability-insights/shared/types/chat-answer';
import {
  availableRegions,
  diffRegions,
  flattenProducts,
  isAvailableIn,
  type RegionalAvailabilityMap,
} from '@capability-insights/shared/types/capability-query';

/**
 * Executes chat-agent tool calls against catalog data.
 *
 * READ tools resolve through the deterministic capability-query core, so the
 * model never computes availability itself. `preview_policy` is a read-only
 * dry run. `propose_write` performs NO mutation — it echoes a structured
 * proposal the browser surfaces for explicit human confirmation.
 *
 * Catalog loaders are injectable so the executor is unit-testable without S3.
 */

/** Result returned to the agent loop for one tool call. */
export interface ToolResult {
  /** JSON-serializable payload handed back to the model as the tool_result. */
  content: unknown;
  /** Present only for propose_write — surfaced to the browser for confirmation. */
  writeProposal?: WriteProposal;
  /** Structured answer for the companion canvas (query_capabilities / preview_policy). */
  answer?: AnswerPayload;
}

export interface WriteProposal {
  kind: ProposableWriteKind;
  summary: string;
  payload?: Record<string, unknown>;
}

/** Loaders the executor depends on. Defaulted to real S3 reads in production. */
export interface ToolDataSources {
  loadRegions: () => Promise<Region[]>;
  loadProducts: () => Promise<Product[]>;
  loadApis: () => Promise<ApiService[]>;
  loadCfn: () => Promise<CfnResource[]>;
  loadSyncMetadata: () => Promise<{ lastSyncTime?: string; errors?: string[] } | null>;
  loadUsedCapabilities: () => Promise<UsedCapabilities | null>;
  /** Feature flags as the UI sees them (usageAnalysis/policyEnforcer enabled). */
  loadFeatureFlags: () => Promise<{ usageAnalysisEnabled: boolean; policyEnforcerEnabled: boolean }>;
  /** Read-only policy preview; returns null if the policy doesn't exist. */
  previewPolicy: (policyName: string) => Promise<unknown | null>;
}

/**
 * Cap on list sizes returned TO THE MODEL, to keep tool results small. This is
 * a real constraint: the content JSON is fed back into Bedrock as a toolResult
 * every turn (tokens + the API Gateway 30s ceiling). The model only needs the
 * exact `total` (computed over the full set) plus a sample — never the full list.
 */
const MAX_ITEMS = 50;

/**
 * Cap on the BROWSER-FACING answer payload (rendered, paginated, in the drawer).
 * This list never goes through Bedrock, so the token/latency reason for
 * MAX_ITEMS does not apply — it only needs a high safety bound so a pathological
 * set doesn't blow the 6 MB Lambda response. Realistic answers (tens–hundreds)
 * render in full; the card paginates them. `truncated` still flags an overflow
 * honestly rather than silently dropping.
 */
const MAX_ANSWER_ITEMS = 500;

function cap<T>(items: T[]): { total: number; truncated: boolean; items: T[] } {
  return { total: items.length, truncated: items.length > MAX_ITEMS, items: items.slice(0, MAX_ITEMS) };
}

/**
 * Sort keys the model may choose for ranking/superlative questions. The MENU is
 * code-defined (the model picks one + a direction); the executor owns HOW each
 * key's scalar is COMPUTED over the FULL set BEFORE the MAX_ITEMS cap, so the
 * model never ranks a truncated slice and is never load-bearing for the
 * arithmetic. Adding a dimension = one case here + the schema enum.
 */
export type OrderByKey = 'regionCount' | 'usedCount' | 'soonestLaunch' | 'name';

/**
 * Parse a planned launch-date string ("YYYY Qn", e.g. "2026 Q4") into a
 * sortable integer (year*10 + quarter). Returns null for anything unparseable,
 * so entities with no/garbled dates sort to the end regardless of direction.
 */
function launchDateRank(date: string): number | null {
  const m = /^(\d{4})\s*Q([1-4])$/.exec(date.trim());
  if (m) return Number(m[1]) * 10 + Number(m[2]);
  // Tolerate a bare year ("2026") as Q1 of that year.
  const y = /^(\d{4})$/.exec(date.trim());
  if (y) return Number(y[1]) * 10 + 1;
  return null;
}

/**
 * The scalar sort value for an entity under a given key, or null when the
 * entity has no value for that key. Null always sorts LAST (after both asc and
 * desc orderings of real values), so "soonest launch" never surfaces an
 * entity that has no launch date.
 */
function sortValue(e: CatalogEntity, key: OrderByKey): number | string | null {
  switch (key) {
    case 'regionCount':
      return availableRegions(e.regionalAvailability).length;
    case 'usedCount':
      return e.raw?.kind === 'cfn' ? (e.raw.resourceType.usage?.count ?? null) : null;
    case 'soonestLaunch': {
      if (e.raw?.kind !== 'product') return null;
      const dates = e.raw.product.launchDates;
      if (!dates) return null;
      const ranks = Object.values(dates)
        .map(launchDateRank)
        .filter((n): n is number => n !== null);
      return ranks.length ? Math.min(...ranks) : null;
    }
    case 'name':
      return e.name.toLowerCase();
  }
}

/**
 * Rank entities by a code-computed key over the FULL set. Entities with NO
 * value for the key (e.g. a product under usedCount, or a service with no
 * launch date under soonestLaunch) are EXCLUDED from a ranked result entirely —
 * they are not candidates for a superlative, so a ranking never surfaces a
 * null-keyed entity as the answer (and an all-null set yields an empty ranking,
 * not a bogus "winner"). Values are precomputed once; ties break by name.
 */
function rankEntities(
  entities: CatalogEntity[],
  key: OrderByKey,
  order: 'asc' | 'desc',
): { ranked: CatalogEntity[]; unranked: number } {
  const keyed = entities
    .map(e => ({ e, v: sortValue(e, key) }))
    .filter((x): x is { e: CatalogEntity; v: number | string } => x.v !== null);
  const dir = order === 'desc' ? -1 : 1;
  keyed.sort((a, b) => {
    if (a.v < b.v) return -1 * dir;
    if (a.v > b.v) return 1 * dir;
    return a.e.name.localeCompare(b.e.name);
  });
  return { ranked: keyed.map(x => x.e), unranked: entities.length - keyed.length };
}

const RANK_LABEL: Record<OrderByKey, string> = {
  regionCount: 'Available regions',
  usedCount: 'Used count',
  soonestLaunch: 'Soonest launch',
  name: 'Name',
};

/** Human-facing value of an entity's rank key (decodes soonestLaunch back to "YYYY Qn"). */
function rankDisplay(e: CatalogEntity, key: OrderByKey): string | null {
  const v = sortValue(e, key);
  if (v === null) return null;
  if (key === 'soonestLaunch') {
    const n = v as number;
    return `${Math.floor(n / 10)} Q${n % 10}`;
  }
  return String(v);
}

/**
 * A definition-list fact carrying the value an entity was ranked by, so the
 * model (and the drawer) can CITE the magnitude — not just the relative order —
 * even without detail=true. 'name' adds nothing (the label already shows it).
 */
function rankFact(e: CatalogEntity, key: OrderByKey): AnswerFact | null {
  if (key === 'name') return null;
  const d = rankDisplay(e, key);
  return d === null ? null : { label: RANK_LABEL[key], values: [d] };
}

/** Production data sources backed by the website bucket + features route logic. */
export function defaultDataSources(): ToolDataSources {
  const bucket = () => new S3BucketClient(getEnv(EnvironmentKey.WEBSITE_BUCKET_NAME));
  const getJson = async <T>(key: string): Promise<T> => JSON.parse(await bucket().getObject(key)) as T;
  const getJsonOrNull = async <T>(key: string): Promise<T | null> => {
    try {
      return await getJson<T>(key);
    } catch {
      return null;
    }
  };
  const usedCombinedKey = usedCapabilitiesKey('account', 'combined');
  return {
    loadRegions: () => getJson<Region[]>(CatalogKey.REGIONS),
    loadProducts: () => getJson<Product[]>(CatalogKey.PRODUCTS),
    loadApis: () => getJson<ApiService[]>(CatalogKey.APIS),
    loadCfn: () => getJson<CfnResource[]>(CatalogKey.CFN_RESOURCES),
    loadSyncMetadata: () => getJsonOrNull<{ lastSyncTime?: string; errors?: string[] }>('data/sync-metadata.json'),
    loadUsedCapabilities: () => getJsonOrNull<UsedCapabilities>(usedCombinedKey),
    loadFeatureFlags: async () => {
      // Detect Usage Analysis by the PRESENCE OF ITS DATA, not an env var: the
      // Chat Lambda is a separate, out-of-VPC function that is NOT wired with
      // ANALYSIS_STATE_MACHINE_ARN, so an env-var check is always false here.
      //
      // Probe via getObject (NOT listObjects): the Chat Lambda's role only
      // grants s3:GetObject on the bucket, not s3:ListBucket, so a list-based
      // probe would always AccessDenied -> false. A getObject on the combined
      // used-capabilities key succeeds when Usage Analysis has produced data
      // (what the used_but_unavailable tool actually reads) and throws
      // (NoSuchKey/AccessDenied) otherwise. Mirrors features-route's probe.
      let usageAnalysisEnabled = false;
      try {
        await bucket().getObject(usedCombinedKey);
        usageAnalysisEnabled = true;
      } catch {
        usageAnalysisEnabled = false;
      }
      return {
        usageAnalysisEnabled,
        policyEnforcerEnabled: Boolean(getOptionalEnv(EnvironmentKey.POLICY_TABLE_NAME)),
      };
    },
    // previewPolicy wiring is supplied by the route (it needs the per-account
    // store + catalog); default throws so a misconfigured caller fails loudly.
    previewPolicy: () => {
      throw new Error('previewPolicy data source not provided');
    },
  };
}

/**
 * Uniform, availability-bearing view of any catalog entity, so all entity types
 * (products/services, API operations, CFN resource types) flow through the same
 * deterministic query paths. `id`/`detail`/`homepage` feed the answer payload
 * (the homepage is the hyperlink the companion UI renders). `raw` retains the
 * source object so the generic detail path (entityFacts) can compute typed
 * facts (launch dates, used values, etc.) without a mode-per-field.
 */
export interface CatalogEntity {
  id: string;
  name: string;
  detail?: string;
  homepage?: string;
  regionalAvailability?: RegionalAvailabilityMap;
  /** Source object + kind, for computing typed detail facts on demand. */
  raw?:
    | { kind: 'product'; product: Product }
    | { kind: 'api'; service: ApiService; operation: ApiService['apis'][number] }
    | { kind: 'cfn'; service: EnrichedCfnResource; resourceType: EnrichedCfnResource['resourceTypes'][number] };
}

type EntityType = 'product' | 'api' | 'cfn';

/** Flatten a product tree (services + nested features) into CatalogEntity rows. */
function productsToEntities(products: Product[]): CatalogEntity[] {
  return flattenProducts(products).map(p => ({
    id: p.productId,
    name: p.productName,
    detail: p.productType,
    homepage: p.homepage,
    regionalAvailability: p.regionalAvailability,
    raw: { kind: 'product' as const, product: p },
  }));
}

function apisToEntities(apis: ApiService[]): CatalogEntity[] {
  const out: CatalogEntity[] = [];
  for (const s of apis) {
    for (const op of s.apis) {
      out.push({
        id: `${s.sdkServiceName}:${op.apiAction}`,
        name: `${s.sdkServiceName}:${op.apiAction}`,
        detail: s.sdkServiceFullName || s.sdkServiceName,
        homepage: op.homepage,
        regionalAvailability: op.regionalAvailability,
        raw: { kind: 'api' as const, service: s, operation: op },
      });
    }
  }
  return out;
}

function cfnToEntities(cfn: EnrichedCfnResource[]): CatalogEntity[] {
  const out: CatalogEntity[] = [];
  for (const s of cfn) {
    for (const t of s.resourceTypes) {
      out.push({
        id: t.resourceTypeName,
        name: t.resourceTypeName,
        detail: s.serviceName,
        homepage: t.resourceTypeHomepage,
        regionalAvailability: t.regionalAvailability,
        raw: { kind: 'cfn' as const, service: s, resourceType: t },
      });
    }
  }
  return out;
}

/**
 * Compute typed key/value facts for an entity — the generic detail mechanism.
 * Each entity type contributes the facts it actually carries; all values are
 * strings, so the canvas renders them through ONE definition-list path and a
 * new "tell me about X" question needs no new code or render branch.
 */
function entityFacts(e: CatalogEntity): AnswerFact[] {
  const facts: AnswerFact[] = [];
  const raw = e.raw;
  if (!raw) return facts;

  if (raw.kind === 'product') {
    const p = raw.product;
    facts.push({ label: 'Type', values: [String(p.productType)] });
    if (p.childProducts?.length) facts.push({ label: 'Features', values: [String(p.childProducts.length)] });
    if (p.launchDates && Object.keys(p.launchDates).length) {
      facts.push({
        label: 'Launch dates',
        values: Object.entries(p.launchDates)
          .slice(0, MAX_ITEMS)
          .map(([region, date]) => `${region}: ${date}`),
      });
    }
  } else if (raw.kind === 'api') {
    facts.push({ label: 'Service', values: [raw.service.sdkServiceFullName || raw.service.sdkServiceName] });
    facts.push({ label: 'Action', values: [raw.operation.apiAction] });
  } else {
    facts.push({ label: 'Service', values: [raw.service.serviceName] });
    const usage = raw.resourceType.usage;
    if (usage) {
      facts.push({ label: 'Used count', values: [String(usage.count)] });
      if (usage.stacks?.length) facts.push({ label: 'Stacks', values: usage.stacks.slice(0, MAX_ITEMS) });
      for (const [prop, vals] of Object.entries(usage.properties ?? {})) {
        facts.push({ label: prop, values: vals.slice(0, MAX_ITEMS) });
      }
    }
  }
  return facts;
}

/** Load the requested entity type as a uniform CatalogEntity list (master or used-only). */
async function loadEntities(
  entityType: EntityType,
  usedOnly: boolean,
  sources: ToolDataSources,
): Promise<{ entities: CatalogEntity[]; used: UsedCapabilities | null }> {
  if (usedOnly) {
    const used = await sources.loadUsedCapabilities();
    if (!used) return { entities: [], used: null };
    const entities =
      entityType === 'product'
        ? productsToEntities(used.products)
        : entityType === 'api'
          ? apisToEntities(used.apis)
          : cfnToEntities(used.cfnResources);
    return { entities, used };
  }
  const entities =
    entityType === 'product'
      ? productsToEntities(await sources.loadProducts())
      : entityType === 'api'
        ? apisToEntities(await sources.loadApis())
        : cfnToEntities(await sources.loadCfn());
  return { entities, used: null };
}

/**
 * Generic words a user/model adds that carry no catalog signal. Dropped from
 * the query token set so "APS Service", "APS cfn resources", "S3 resource type"
 * all reduce to their meaningful tokens before matching.
 */
const MATCH_STOPWORDS = new Set([
  'service',
  'services',
  'resource',
  'resources',
  'cfn',
  'cloudformation',
  'type',
  'types',
]);

/** Meaningful (non-stopword) lowercase tokens of a free-text query. */
function meaningfulTokens(name: string): string[] {
  return name
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t && !MATCH_STOPWORDS.has(t));
}

/**
 * The searchable text for an entity. For CFN this folds in the service name
 * (e.name/e.id is only the resource-type name) and the fully-qualified
 * "aws::service::type" form, so a service-only query like "APS" — or the
 * fully-qualified "AWS::APS::Workspace" — matches. Other kinds keep name+id.
 */
function searchHaystack(e: CatalogEntity): string {
  if (e.raw?.kind === 'cfn') {
    const svc = e.raw.service.serviceName; // e.g. "APS" or "AWS::APS"
    // fq normalizes to a single AWS:: prefix whether serviceName already carries it.
    const fq = `aws::${svc.replace(/^aws::/i, '')}::${e.name.replace(/^aws::[^:]*::/i, '')}`;
    return `${svc} ${e.name} ${fq}`.toLowerCase();
  }
  return `${e.name} ${e.id}`.toLowerCase();
}

/**
 * Case-insensitive match (blank = match all). An exact id hit always matches
 * (preserves "s3:GetObject" / "AWS::S3::Bucket" exact resolution). Otherwise the
 * query is tokenized, generic stopwords are dropped, and EVERY remaining token
 * must appear in the entity's haystack — service-aware and noise-tolerant.
 */
function matchesName(e: CatalogEntity, name: string | undefined): boolean {
  if (!name || !name.trim()) return true;
  const n = name.trim().toLowerCase();
  if (e.id.toLowerCase() === n) return true;
  const tokens = meaningfulTokens(n);
  // All-stopword query (e.g. "cfn resources") -> treat as match-all for the type.
  if (!tokens.length) return true;
  const hay = searchHaystack(e);
  return tokens.every(t => hay.includes(t));
}

/**
 * Relevance score for ranking name matches (higher = better). Catalog order is
 * NOT relevance, so a substring like "Amazon Bedrock Integration" must not
 * outrank the exact/closest match "Amazon Bedrock" for the query "Bedrock".
 * Tiers: exact name/id > canonical "Amazon/AWS <q>" service name > whole-word
 * match > prefix > substring; ties broken by shorter name (closer to the query).
 *
 * The canonical tier is what makes a bare service token resolve to the SERVICE,
 * not a feature that merely contains it: "s3" -> "Amazon S3" (700), beating
 * "S3 Tables" / "S3 Glacier" (whole-word, 500). Without it those tie at 500 and
 * an arbitrary length/order tiebreak can surface the wrong entity.
 */
function matchScore(e: CatalogEntity, query: string): number {
  const name = e.name.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  if (name === q || e.id.toLowerCase() === q) return 1000;
  // Canonical full service name for a bare token: "Amazon S3" / "AWS Lambda".
  if (name === `amazon ${q}` || name === `aws ${q}`) return 700;
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(name)) return 500;
  if (name.startsWith(q)) return 300;
  if (name.includes(q)) return 100;
  // Fall back to the service-aware/noise-tolerant haystack so service-name and
  // multi-token matches (e.g. CFN "APS Service") still rank above non-matches.
  const tokens = meaningfulTokens(q);
  if (tokens.length) {
    const hay = searchHaystack(e);
    if (tokens.every(t => hay.includes(t))) return 50;
  }
  return 0;
}

/** Matches for `name`, ranked best-first (relevance, then shorter name). */
function rankedMatches(entities: CatalogEntity[], name: string | undefined): CatalogEntity[] {
  const matched = entities.filter(e => matchesName(e, name));
  if (!name || !name.trim()) return matched;
  const q = name.trim();
  return matched
    .map((e, i) => ({ e, i, score: matchScore(e, q) }))
    .sort((a, b) => b.score - a.score || a.e.name.length - b.e.name.length || a.i - b.i)
    .map(x => x.e);
}

/**
 * Project a CatalogEntity to a compact, hyperlinkable item (for the model).
 * When `rankKey` is set, the value the entity was ranked by is attached so the
 * model can CITE the magnitude (e.g. "used 99 times", "in 57 regions"), not
 * just rely on list position.
 */
function toItem(e: CatalogEntity, regionForStatus?: string, rankKey?: OrderByKey) {
  return {
    name: e.name,
    detail: e.detail,
    homepage: e.homepage,
    status: regionForStatus ? (e.regionalAvailability?.[regionForStatus] ?? null) : undefined,
    ...(rankKey && rankKey !== 'name' ? { [rankKey]: rankDisplay(e, rankKey) } : {}),
  };
}

// ---- Companion-canvas answer payload helpers ----

/**
 * Project a CatalogEntity to a renderable AnswerItem (with its docs hyperlink).
 * When `withFacts` is set, attach typed key/value facts (launch dates, used
 * values, etc.) for the canvas's generic detail rendering.
 */
function toAnswerItem(e: CatalogEntity, regionForStatus?: string, withFacts = false, rankKey?: OrderByKey): AnswerItem {
  const links: AnswerLink[] = [];
  if (e.homepage) links.push({ text: 'AWS docs', href: e.homepage, external: true });
  const facts: AnswerFact[] = withFacts ? entityFacts(e) : [];
  // Always surface the ranked-by value (even without detail) so the drawer can
  // show "Available regions: 57" / "Used count: 99" next to the ranked entity.
  // regionCount in particular has no entityFact, so this is its only surface.
  if (rankKey) {
    const rf = rankFact(e, rankKey);
    if (rf && !facts.some(f => f.label === rf.label)) facts.unshift(rf);
  }
  return {
    label: e.name,
    detail: e.detail,
    status: regionForStatus ? (e.regionalAvailability?.[regionForStatus] ?? null) : undefined,
    links: links.length ? links : undefined,
    facts: facts.length ? facts : undefined,
  };
}

interface QueryInput {
  mode: 'available_in' | 'where_available' | 'diff' | 'list' | 'usage_summary' | 'usage_detail' | 'usage_gaps';
  entityType?: EntityType;
  regions?: string[];
  name?: string;
  status?: string[];
  /** How `status` is compared. '!=' means "NOT these statuses" (e.g. "not yet available"). Defaults to '='. */
  statusOp?: '=' | '!=';
  /**
   * Restrict products to a single product type: 'SERVICE' (top-level services)
   * or 'FEATURE' (nested capabilities). Only meaningful for entityType=product;
   * ignored for api/cfn. Use for "services only (not features)" questions.
   */
  productType?: 'SERVICE' | 'FEATURE';
  usedOnly?: boolean;
  /** Attach typed per-entity facts (launch dates, used values, etc.) to results. */
  detail?: boolean;
  /**
   * Rank the result set (list/usage_summary) by a code-computed key BEFORE the
   * result is capped — so superlative/"which is the X-est" / "top N" questions
   * are answered deterministically over the full set, not a truncated slice.
   */
  orderBy?: OrderByKey;
  /** Sort direction for orderBy. Defaults to 'desc' (largest/latest first). */
  order?: 'asc' | 'desc';
}

/**
 * The single general query over the catalog. The model composes the params;
 * this function executes them deterministically against the capability-query
 * core. Subsumes the former is_available / where_available / diff_regions /
 * products_not_available / summarize_usage / used_but_unavailable tools.
 */
async function queryCapabilities(input: Record<string, unknown>, sources: ToolDataSources): Promise<ToolResult> {
  const {
    mode,
    entityType = 'product',
    regions = [],
    name,
    status,
    statusOp = '=',
    productType,
    usedOnly = false,
    detail = false,
    orderBy,
    order = 'desc',
  } = input as unknown as QueryInput;

  // Usage modes require Usage Analysis enabled + data present.
  const needsUsage = mode === 'usage_summary' || mode === 'usage_detail' || mode === 'usage_gaps' || usedOnly;
  if (needsUsage) {
    const flags = await sources.loadFeatureFlags();
    if (!flags.usageAnalysisEnabled) {
      return {
        content: {
          mode,
          notEnabled: true,
          message: 'Usage Analysis is not enabled. Re-run deploy with --enable-usage-analysis.',
        },
        answer: {
          kind: mode === 'usage_gaps' ? 'usage-gaps' : 'usage-summary',
          title: 'Usage Analysis not enabled',
          subtitle: 'Re-run deploy with --enable-usage-analysis to see your usage.',
          notEnabled: true,
        },
      };
    }
  }

  const loaded = await loadEntities(entityType, needsUsage, sources);
  const used = loaded.used;
  if (needsUsage && !used) {
    return {
      content: { mode, notEnabled: false, hasData: false, message: 'No usage data yet — run an analysis first.' },
      answer: {
        kind: mode === 'usage_gaps' ? 'usage-gaps' : 'usage-summary',
        title: 'No usage data yet',
        subtitle: 'Run a usage analysis to populate your usage data.',
      },
    };
  }

  // Optional product-type filter (SERVICE vs FEATURE) — applied once over the
  // full entity set so EVERY mode (list counts, available_in, usage_*) honors
  // "services only (not features)". Only products carry a type; api/cfn ignore it.
  const entities =
    productType && entityType === 'product'
      ? loaded.entities.filter(e => e.raw?.kind === 'product' && e.raw.product.productType === productType)
      : loaded.entities;

  const entityLabel =
    entityType === 'product'
      ? productType === 'SERVICE'
        ? 'services'
        : productType === 'FEATURE'
          ? 'features'
          : 'products/services'
      : entityType === 'api'
        ? 'API operations'
        : 'CloudFormation resource types';

  switch (mode) {
    case 'available_in': {
      const region = regions[0];
      const matches = rankedMatches(entities, name);
      const inRegion = matches.filter(e => isAvailableIn(e.regionalAvailability, region));
      const shown = name ? matches : inRegion;
      const answerItems = shown.map(e => toAnswerItem(e, region, detail));
      const title = name ? `${name} in ${region}` : `${inRegion.length} ${entityLabel} available in ${region}`;
      const subtitle = name ? `${inRegion.length} of ${matches.length} matching available in ${region}` : undefined;
      return {
        content: {
          mode,
          entityType,
          region,
          query: name,
          matched: matches.length,
          availableCount: inRegion.length,
          items: cap(shown.map(e => toItem(e, region))),
        },
        answer: {
          kind: 'availability',
          title,
          subtitle,
          primary: answerItems[0],
          alternates: answerItems.slice(1, MAX_ANSWER_ITEMS),
          total: shown.length,
        },
      };
    }

    case 'where_available': {
      const [match] = rankedMatches(entities, name);
      if (!match) {
        return {
          content: { mode, found: false, query: name },
          answer: { kind: 'regions', title: `No match for "${name ?? ''}"`, subtitle: 'Not found in the catalog.' },
        };
      }
      const regionsAvail = availableRegions(match.regionalAvailability);
      return {
        content: { mode, found: true, matched: match.name, homepage: match.homepage, ...cap(regionsAvail) },
        answer: {
          kind: 'regions',
          title: `${match.name} — available in ${regionsAvail.length} region${regionsAvail.length === 1 ? '' : 's'}`,
          primary: {
            label: match.name,
            detail: regionsAvail.join(', '),
            links: match.homepage ? [{ text: 'AWS docs', href: match.homepage, external: true }] : undefined,
          },
          alternates: regionsAvail.slice(0, MAX_ANSWER_ITEMS).map(r => ({ label: r })),
          total: regionsAvail.length,
        },
      };
    }

    case 'diff': {
      const [a, b] = regions;
      const d = diffRegions(entities, a, b);
      const onlyAItems = d.onlyInA.map(e => toAnswerItem(e));
      const onlyBItems = d.onlyInB.map(e => toAnswerItem(e));
      return {
        content: {
          mode,
          entityType,
          regionA: a,
          regionB: b,
          counts: {
            onlyInA: d.onlyInA.length,
            onlyInB: d.onlyInB.length,
            inBoth: d.inBoth.length,
            inNeither: d.inNeither.length,
          },
          onlyInA: cap(d.onlyInA.map(e => toItem(e))),
          onlyInB: cap(d.onlyInB.map(e => toItem(e))),
        },
        answer: {
          kind: 'region-diff',
          title: `${entityLabel}: ${a} vs ${b}`,
          subtitle: `${d.onlyInA.length} only in ${a} · ${d.onlyInB.length} only in ${b} · ${d.inBoth.length} in both`,
          primary: onlyAItems[0] ?? onlyBItems[0],
          alternates: [...onlyAItems, ...onlyBItems].slice(0, MAX_ANSWER_ITEMS),
          total: d.onlyInA.length + d.onlyInB.length,
        },
      };
    }

    case 'list': {
      const region = regions[0];
      const statusSet = status && status.length ? new Set<string>(status) : null;
      // statusOp '!=' means "NOT these statuses" — e.g. "not yet available"
      // = everything whose status is not Available (Planned, Planning, Not
      // Available, Not Expanding, or missing).
      const negate = statusOp === '!=';
      const matched = entities.filter(e => {
        if (!matchesName(e, name)) return false;
        if (region) {
          const s = e.regionalAvailability?.[region] ?? AvailabilityStatus.NOT_AVAILABLE;
          if (statusSet) return negate ? !statusSet.has(s) : statusSet.has(s);
          // No status filter + region: default to "available in region".
          return isAvailableIn(e.regionalAvailability, region);
        }
        return true;
      });
      // Rank over the FULL filtered set BEFORE capping, so a "which is the
      // X-est / top N" question gets the true top-N, not the first N in catalog
      // order. The model only chose the key+direction; the sort is in code.
      // Entities with no value for the key are EXCLUDED (not a candidate for a
      // superlative) — `unranked` reports how many, so nothing is silent.
      const rank = orderBy ? rankEntities(matched, orderBy, order) : null;
      const filtered = rank ? rank.ranked : matched;
      const items = filtered.map(e => toAnswerItem(e, region, detail, orderBy));
      const statusText = status && status.length ? ` (${negate ? 'not ' : ''}${status.join(', ')})` : '';
      const orderText = orderBy ? `, by ${orderBy} ${order}` : '';
      return {
        content: {
          mode,
          entityType,
          region,
          status: status ?? null,
          statusOp,
          productType: productType ?? null,
          orderBy: orderBy ?? null,
          order: orderBy ? order : null,
          ...(rank ? { unranked: rank.unranked } : {}),
          ...cap(filtered.map(e => toItem(e, region, orderBy))),
        },
        answer: {
          kind: 'entity-list',
          title: `${filtered.length} ${entityLabel}${region ? ` in ${region}` : ''}${statusText}${orderText}`,
          primary: items[0],
          alternates: items.slice(1, MAX_ANSWER_ITEMS),
          total: filtered.length,
        },
      };
    }

    case 'usage_summary': {
      // Rank the full used set in code before capping, so "what do I use most /
      // which is in the fewest regions / soonest launch" returns the true top.
      // Null-keyed entities are excluded from a ranking (`unranked` counts them).
      const rank = orderBy ? rankEntities(entities, orderBy, order) : null;
      const ranked = rank ? rank.ranked : entities;
      const items = ranked.map(e => toAnswerItem(e, undefined, detail, orderBy));
      const orderText = orderBy ? ` (by ${orderBy} ${order})` : '';
      return {
        content: {
          mode,
          entityType,
          lastAnalyzedAt: used?.lastAnalyzedAt,
          orderBy: orderBy ?? null,
          order: orderBy ? order : null,
          ...(rank ? { unranked: rank.unranked } : {}),
          ...cap(ranked.map(e => toItem(e, undefined, orderBy))),
        },
        answer: {
          kind: 'usage-summary',
          title: `You use ${entities.length} ${entityLabel}${orderText}`,
          primary: items[0],
          alternates: items.slice(1, MAX_ANSWER_ITEMS),
          total: entities.length,
          asOf: used?.lastAnalyzedAt,
        },
      };
    }

    case 'usage_detail': {
      // The SPECIFIC values used for a resource (e.g. EC2 instance types). Runs
      // over the CatalogEntity list (which carries `raw`), so it renders via the
      // generic typed-facts path — each property becomes its own definition-list
      // row (resource -> property -> values), not one squashed line. Service-aware
      // + noise-tolerant matching (incl. the fully-qualified "AWS::Service::Type"
      // form) is now centralized in matchesName.
      const matched = entities.filter(e => matchesName(e, name));
      const items: AnswerItem[] = matched.map(e => toAnswerItem(e, undefined, true));
      return {
        content: {
          mode,
          entityType,
          lastAnalyzedAt: used?.lastAnalyzedAt,
          ...cap(matched.map(e => ({ resourceType: e.name, detail: e.detail, facts: entityFacts(e) }))),
        },
        answer: {
          kind: 'usage-summary',
          title: name ? `Your usage of ${name} (${matched.length})` : `Your resource usage (${matched.length})`,
          primary: items[0],
          alternates: items.slice(1, MAX_ANSWER_ITEMS),
          total: matched.length,
          asOf: used?.lastAnalyzedAt,
        },
      };
    }

    case 'usage_gaps': {
      const gaps = regions.map(region => {
        const missing = entities.filter(e => !isAvailableIn(e.regionalAvailability, region));
        return { region, missing };
      });
      const first = gaps[0];
      const firstItems = first ? first.missing.map(e => toAnswerItem(e, first.region)) : [];
      return {
        content: {
          mode,
          entityType,
          lastAnalyzedAt: used?.lastAnalyzedAt,
          gaps: gaps.map(g => ({
            targetRegion: g.region,
            missingCount: g.missing.length,
            ...cap(g.missing.map(e => toItem(e, g.region))),
          })),
        },
        answer: {
          kind: 'usage-gaps',
          title: first
            ? `${first.missing.length} ${entityLabel} you use are missing in ${first.region}`
            : 'No target regions given',
          subtitle: gaps.length > 1 ? gaps.map(g => `${g.region}: ${g.missing.length}`).join(' · ') : undefined,
          primary: firstItems[0],
          alternates: firstItems.slice(1, MAX_ANSWER_ITEMS),
          total: first?.missing.length ?? 0,
          asOf: used?.lastAnalyzedAt,
        },
      };
    }

    default:
      return { content: { error: `Unknown query mode: ${String(mode)}` } };
  }
}

/**
 * Execute one tool call by name. `input` is the model-supplied arguments.
 * Throws on unknown tool names; individual tools validate their own inputs.
 */
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  sources: ToolDataSources,
): Promise<ToolResult> {
  logger.info('chat tool call', { toolName });

  switch (toolName) {
    case ToolName.LIST_REGIONS: {
      const regions = await sources.loadRegions();
      return {
        content: regions.map(r => ({ code: r.Region, name: r.RegionLongName, partition: r.Partition })),
      };
    }

    case ToolName.QUERY_CAPABILITIES:
      return queryCapabilities(input, sources);

    case ToolName.GET_LAST_SYNC_TIME: {
      const meta = await sources.loadSyncMetadata();
      return { content: meta ?? { lastSyncTime: null, message: 'No sync metadata available.' } };
    }

    case ToolName.GET_FEATURE_FLAGS: {
      return { content: await sources.loadFeatureFlags() };
    }

    case ToolName.PREVIEW_POLICY: {
      const { policyName } = input as { policyName: string };
      const preview = await sources.previewPolicy(policyName);
      if (preview === null) return { content: { found: false, policyName } };
      return { content: { found: true, preview } };
    }

    case ToolName.PROPOSE_WRITE: {
      const { kind, summary, payload } = input as {
        kind: ProposableWriteKind;
        summary: string;
        payload?: Record<string, unknown>;
      };
      // No mutation performed: echo the proposal for human confirmation in the UI.
      const proposal: WriteProposal = { kind, summary, payload };
      return {
        content: { proposed: true, kind, summary, note: 'Awaiting user confirmation in the UI; nothing has changed.' },
        writeProposal: proposal,
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
