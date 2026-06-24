/**
 * Chat UI types for the conversational assistant.
 *
 * `ConverseTurn` mirrors the backend's Bedrock-agnostic message shape (text-only
 * for transport — tool_use/tool_result blocks live server-side and are never
 * sent from the browser). The drawer keeps a list of `ChatMessage` for display
 * and derives the `history` it sends to /chat from the prior turns.
 */
import type { AnswerPayload } from '@capability-insights/shared/types/chat-answer';

export type { AnswerPayload, AnswerItem, AnswerLink, AnswerKind } from '@capability-insights/shared/types/chat-answer';

/** A transport message in the /chat request history (text only). */
export interface ConverseTurn {
  role: 'user' | 'assistant';
  content: { text: string }[];
}

/** Kinds of mutating action the agent can propose (must match the backend). */
export type WriteProposalKind =
  | 'createPolicy'
  | 'updatePolicy'
  | 'deletePolicy'
  | 'refreshPolicy'
  | 'refreshAllPolicies'
  | 'triggerAnalysis'
  | 'syncCapabilityData';

/** A proposed mutation the user must confirm in the UI. */
export interface WriteProposal {
  kind: WriteProposalKind;
  summary: string;
  payload?: Record<string, unknown>;
}

/** The /chat response. */
export interface ChatResponse {
  reply: string;
  writeProposal?: WriteProposal;
  /** Structured answer for the companion canvas (sticky on the client). */
  answer?: AnswerPayload;
  turns: number;
}

/** A message rendered in the chat drawer. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Present on an assistant message that proposed a write. */
  proposal?: WriteProposal;
  /** Structured answer card rendered inline under this assistant message. */
  answer?: AnswerPayload;
  /** True while this assistant message is awaiting the server response. */
  pending?: boolean;
}
