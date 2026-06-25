/**
 * Tool definitions for the Capability Insights chat agent (Anthropic / Bedrock
 * `tool_use` schema). These are pure data — the executor in `tool-executor.ts`
 * implements them.
 *
 * Design rules (see the chat-agent build plan):
 *  - READ tools resolve against the deterministic capability-query core, so a
 *    lookup answer is computed in code, never hallucinated by the model.
 *  - The only "policy" tool the agent may call autonomously is the read-only
 *    `preview_policy` dry-run. There are NO write tools: mutations are surfaced
 *    as a `propose_write` result that the browser turns into a human-confirmed
 *    call to the existing gated policy routes.
 */

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool input (Anthropic `input_schema`). */
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Canonical tool names, referenced by both the schema list and the executor. */
export const ToolName = {
  LIST_REGIONS: 'list_regions',
  QUERY_CAPABILITIES: 'query_capabilities',
  GET_LAST_SYNC_TIME: 'get_last_sync_time',
  GET_FEATURE_FLAGS: 'get_feature_flags',
  PREVIEW_POLICY: 'preview_policy',
  PROPOSE_WRITE: 'propose_write',
} as const;

export type ToolName = (typeof ToolName)[keyof typeof ToolName];

/** Write actions the agent may PROPOSE (never execute). Mirrors the gated routes. */
export const ProposableWriteKind = {
  CREATE_POLICY: 'createPolicy',
  UPDATE_POLICY: 'updatePolicy',
  DELETE_POLICY: 'deletePolicy',
  REFRESH_POLICY: 'refreshPolicy',
  REFRESH_ALL_POLICIES: 'refreshAllPolicies',
  TRIGGER_ANALYSIS: 'triggerAnalysis',
  SYNC_CAPABILITY_DATA: 'syncCapabilityData',
} as const;

export type ProposableWriteKind = (typeof ProposableWriteKind)[keyof typeof ProposableWriteKind];

/**
 * The full tool list passed to the model. READ + preview + propose only;
 * deliberately no executable write tools.
 */
export const CHAT_TOOLS: ToolSchema[] = [
  {
    name: ToolName.LIST_REGIONS,
    description:
      'List all AWS regions known to the capability catalog (code, long name, partition). Use this to resolve or validate any region the user names before answering. Never invent region codes.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: ToolName.QUERY_CAPABILITIES,
    description:
      "The single, general query over the capability catalog. Compose the parameters to answer ANY availability/usage question — you (the model) interpret the user's intent and fill the filters; the backend computes the exact answer deterministically.\n\n" +
      'Pick `mode` by intent:\n' +
      '- "available_in": is X available / what is available in a region (set regions=[one]).\n' +
      '- "where_available": which regions is X available in (set name; omit regions).\n' +
      '- "diff": compare two regions (set regions=[A,B]).\n' +
      '- "list": list/filter entities, optionally by region+status (e.g. planned products in a region). For "what is NOT yet available / missing in region X", set regions=[X], status=["Available"], statusOp="!=" — this returns everything whose status is anything other than Available.\n' +
      '- "usage_summary": general "what do I use / my stuff" with NO region (set usedOnly=true).\n' +
      '- "usage_detail": the SPECIFIC values you use for a resource — e.g. "what EC2 machines / instance types am I using". Set entityType=cfn, usedOnly=true, name=the resource (e.g. "EC2" or "AWS::EC2::Instance"). Returns the observed property values (instance types, etc.), the stacks using it, and counts.\n' +
      '- "usage_gaps": what the account uses that is NOT available in target region(s) (set usedOnly=true, regions=[targets]).\n\n' +
      'entityType selects the catalog: products/services, api operations, or CloudFormation resource types. ' +
      'Returns counts plus a capped, hyperlinkable result list (each item carries its catalog homepage URL when known). ' +
      'usage_summary/usage_detail/usage_gaps require Usage Analysis enabled (check get_feature_flags); they return a notEnabled flag otherwise.',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['available_in', 'where_available', 'diff', 'list', 'usage_summary', 'usage_detail', 'usage_gaps'],
          description: 'How to interpret the query — see the per-mode guidance above.',
        },
        entityType: {
          type: 'string',
          enum: ['product', 'api', 'cfn'],
          description:
            'Which catalog to query: product/service, API operation, or CloudFormation resource type. Defaults to product.',
        },
        regions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Region code(s). One for available_in/list; exactly two for diff; the target region(s) for usage_gaps; omit for where_available/usage_summary. Must be real codes (validate via list_regions).',
        },
        name: {
          type: 'string',
          description:
            'Free-text name/id to match (e.g. "Amazon Bedrock", "s3:GetObject", "AWS::S3::Bucket"). Used by available_in/where_available and as a filter for list.',
        },
        status: {
          type: 'array',
          items: { type: 'string', enum: ['Available', 'Planned', 'Planning', 'Not Expanding', 'Not Available'] },
          description:
            'Optional availability-status filter for list mode (e.g. ["Planned"]). For "not yet available", use status=["Available"] with statusOp="!=".',
        },
        statusOp: {
          type: 'string',
          enum: ['=', '!='],
          description:
            'How to compare `status` in list mode. "=" (default) keeps entities matching the status; "!=" keeps entities NOT matching it. Use "!=" with status=["Available"] for "what is not yet available in region X".',
        },
        productType: {
          type: 'string',
          enum: ['SERVICE', 'FEATURE'],
          description:
            'Restrict products to top-level SERVICEs or nested FEATUREs. Set "SERVICE" for "services only / not features", "FEATURE" for "features only". Only applies to entityType=product. The backend filters the FULL set, so counts and the result list both reflect it — do NOT hand-pick services out of a mixed list yourself.',
        },
        usedOnly: {
          type: 'boolean',
          description:
            'Restrict to capabilities this account actually uses ("My stuff"). Required true for usage_summary and usage_gaps.',
        },
        detail: {
          type: 'boolean',
          description:
            'Set true to attach typed per-entity facts to each result — launch dates (products), used instance types / stacks (cfn usage), service/action (apis). Use for "tell me more about X / details of X" questions.',
        },
        orderBy: {
          type: 'string',
          enum: ['regionCount', 'usedCount', 'soonestLaunch', 'name'],
          description:
            'Rank the result set (list / usage_summary) in code over the FULL set before it is capped — use for any "which is the most/fewest/X-est", "rank", or "top N" question so the answer is the true top, not a truncated sample. The first result is the answer. Keys: ' +
            '"regionCount" = number of regions an entity is available in (fewest/most regions -> set order=asc/desc); ' +
            '"usedCount" = how heavily the account uses it (cfn usage only; "what do I use most" -> order=desc); ' +
            '"soonestLaunch" = earliest UPCOMING planned launch quarter (products only; "soonest expansion" -> order=asc). NOTE: launch dates are FUTURE roadmap quarters, not historical GA dates — there is no "most recently launched" data; do not claim it. ' +
            '"name" = alphabetical. Entities lacking the chosen value always sort last.',
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description:
            'Sort direction for orderBy. Defaults to "desc" (largest/latest first). Use "asc" for fewest-regions or soonest-launch.',
        },
      },
      required: ['mode'],
    },
  },
  {
    name: ToolName.GET_LAST_SYNC_TIME,
    description:
      'Get when the capability catalog was last synced. Cite this freshness when answering availability questions.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: ToolName.GET_FEATURE_FLAGS,
    description:
      'Get the deploy-time state of opt-in features (Usage Analysis, Policy Enforcer). Check before answering personalization or policy questions.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: ToolName.PREVIEW_POLICY,
    description:
      'Read-only dry run: compute the allow-list and generated policy document for an EXISTING named policy WITHOUT applying anything to IAM. Use this to explain what a policy blocks/allows, or to show the effect before proposing a change.',
    input_schema: {
      type: 'object',
      properties: { policyName: { type: 'string', description: 'Name of an existing policy.' } },
      required: ['policyName'],
    },
  },
  {
    name: ToolName.PROPOSE_WRITE,
    description:
      'Propose a mutating action for the user to CONFIRM in the UI. This does NOT perform the action — it returns a structured proposal the user must explicitly approve. Use for creating/updating/deleting/refreshing policies, triggering analysis, or syncing data. Never claim a write happened.',
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: Object.values(ProposableWriteKind),
          description: 'The mutating action being proposed.',
        },
        summary: { type: 'string', description: 'One-line human-readable description of what will happen.' },
        payload: {
          type: 'object',
          description: 'The request payload for the corresponding gated route (e.g. CreatePolicyRequest).',
        },
      },
      required: ['kind', 'summary'],
    },
  },
];
