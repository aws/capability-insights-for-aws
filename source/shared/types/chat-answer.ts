import type { AvailabilityStatus } from './availability/availability-status';

/**
 * Structured "answer of record" emitted by the chat agent's query tool and
 * rendered inside the assistant drawer. The prose reply narrates; THIS is the
 * definitive, renderable answer card (primary item, alternates, external docs
 * links, freshness footer). It is self-contained — the chat does NOT drive the
 * main search-results table, so the rendered answer can never diverge from the
 * count the agent computed.
 *
 * Shared between the Chat Lambda (producer) and the website (renderer) so the
 * contract can't drift.
 */

/** A hyperlink attached to an answer or item (external docs or internal deep-link). */
export interface AnswerLink {
  text: string;
  href: string;
  /** True for external (AWS docs) links; false/absent for internal app routes. */
  external?: boolean;
}

/**
 * A typed key/value fact about an entity, rendered as a definition-list row on
 * the canvas. This is the generic detail mechanism: the executor computes facts
 * deterministically per entity type (e.g. launch dates, used instance types,
 * feature count), so a new "tell me about X" question needs no new render code
 * — only data the executor already has. `values` is always strings (no
 * free-form objects), preserving the no-hallucination, typed-render guarantee.
 */
export interface AnswerFact {
  label: string;
  values: string[];
}

/** A single renderable result row. */
export interface AnswerItem {
  label: string;
  /** Secondary text (e.g. service name for an API op, product type for a service). */
  detail?: string;
  /** Availability status to render as an indicator, when the answer is region-scoped. */
  status?: AvailabilityStatus | null;
  links?: AnswerLink[];
  /** Typed key/value facts shown when detail is requested (definition list). */
  facts?: AnswerFact[];
}

/** What kind of answer the canvas is rendering — drives the layout. */
export type AnswerKind =
  | 'availability' // available_in: is/what is available in a region
  | 'regions' // where_available: the regions a thing is available in
  | 'region-diff' // diff: A vs B
  | 'entity-list' // list: filtered entities
  | 'usage-summary' // usage_summary: my stuff
  | 'usage-gaps' // usage_gaps: used-but-missing in target regions
  | 'policy-preview'; // preview_policy

/** The structured answer rendered on the canvas. */
export interface AnswerPayload {
  kind: AnswerKind;
  title: string;
  /** One-line summary (counts, the headline fact). */
  subtitle?: string;
  /** The "first" / headline result shown expanded. */
  primary?: AnswerItem;
  /** Remaining results (selectable). Empty/absent when there's only one. */
  alternates?: AnswerItem[];
  /** Total matches before capping, so the canvas can show "showing N of M". */
  total?: number;
  /** ISO timestamp of catalog/usage freshness, for the canvas footer. */
  asOf?: string;
  /** Answer-level links — external docs only (the chat does not drive app pages). */
  links?: AnswerLink[];
  /** True when a usage answer was requested but Usage Analysis is off. */
  notEnabled?: boolean;
}
