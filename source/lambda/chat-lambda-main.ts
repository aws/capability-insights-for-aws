import { EnvironmentKey, getEnv, getOptionalEnv } from './constants/environment';
import { CatalogKey } from './constants/data-paths';
import { S3BucketClient } from './services/s3-client';
import { PolicyConfigStore } from './services/policy-enforcer/policy-config-store';
import { computeAllowList } from './policy-enforcer/allow-list-engine';
import { generatePolicyDocument } from './policy-enforcer/policy-document-generator';
import { runAgent, MAX_TURNS, type ConverseMessage } from './chat/agent';
import { makeBedrockConverse } from './chat/bedrock-converse';
import { defaultDataSources, type ToolDataSources, type WriteProposal } from './chat/tool-executor';
import { logger, errorFields, emitMetrics } from './util/logger';
import type { ApiService } from '@capability-insights/shared/types/capability/api';
import type { AnswerPayload } from '@capability-insights/shared/types/chat-answer';

/**
 * Chat Lambda — runs the Bedrock agent loop OUTSIDE the VPC.
 *
 * Bedrock has no VPC endpoint in this app's topology, so (like the IAM helper)
 * the agent runs out-of-VPC and is invoked synchronously by the in-VPC API
 * Lambda's `POST /chat` route. Reads catalog data from the website bucket and
 * DynamoDB; performs NO mutations (the agent can only propose writes, which the
 * browser confirms against the existing gated routes).
 */

/** Invocation payload from the API Lambda's /chat route. */
export interface ChatInvokeRequest {
  message: string;
  history?: ConverseMessage[];
  accountId: string;
  /** Page the user is on, for future per-page prompt seeding (unused in v1). */
  pageName?: string;
}

export interface ChatInvokeResponse {
  reply: string;
  writeProposal?: WriteProposal;
  answer?: AnswerPayload;
  turns: number;
}

/** Build the production tool data sources, including per-account previewPolicy. */
function buildSources(accountId: string): ToolDataSources {
  const base = defaultDataSources();
  const policyTableName = getOptionalEnv(EnvironmentKey.POLICY_TABLE_NAME);
  const websiteBucket = getEnv(EnvironmentKey.WEBSITE_BUCKET_NAME);

  return {
    ...base,
    previewPolicy: async (policyName: string) => {
      if (!policyTableName) return null; // Policy Enforcer not deployed
      const store = new PolicyConfigStore(policyTableName, accountId);
      const policy = await store.getPolicy(policyName);
      if (!policy) return null;
      const raw = await new S3BucketClient(websiteBucket).getObject(CatalogKey.APIS);
      const catalogData = JSON.parse(raw) as ApiService[];
      const allowList = computeAllowList({ catalogData, configuration: policy });
      const generated = generatePolicyDocument({
        catalogData,
        configuration: policy,
        policyName: policy.policyName,
        generationTimestamp: new Date().toISOString(),
      });
      return {
        actions: allowList.actions,
        actionCount: allowList.actions.length,
        documentCount: generated.documents?.length,
      };
    },
  };
}

export async function handler(event: ChatInvokeRequest): Promise<ChatInvokeResponse> {
  const modelId = getEnv(EnvironmentKey.BEDROCK_MODEL_ID);
  logger.info('chat invocation', { accountId: event.accountId, pageName: event.pageName });

  const startedAt = Date.now();
  try {
    const converse = makeBedrockConverse(modelId);
    const sources = buildSources(event.accountId);
    const result = await runAgent(event.message, event.history ?? [], converse, sources);
    const latencyMs = Date.now() - startedAt;
    logger.info('chat invocation complete', {
      turns: result.turns,
      latencyMs,
      hasProposal: Boolean(result.writeProposal),
      hasAnswer: Boolean(result.answer),
    });
    // EMF metrics so turn-count and latency are chartable/alarmable without
    // grepping logs — this is the data that decides whether a streaming/async
    // transport is worth building (see the agent loop's MAX_TURNS rationale).
    // MaxTurnsHit counts truncated answers (the real complex-question failure).
    emitMetrics('CapabilityInsights/Chat', {
      AgentTurns: { value: result.turns },
      ChatLatency: { value: latencyMs, unit: 'Milliseconds' },
      MaxTurnsHit: { value: result.turns >= MAX_TURNS ? 1 : 0 },
      ChatInvocation: { value: 1 },
    });
    return { reply: result.reply, writeProposal: result.writeProposal, answer: result.answer, turns: result.turns };
  } catch (e) {
    logger.error('chat invocation failed', errorFields(e));
    emitMetrics('CapabilityInsights/Chat', {
      ChatError: { value: 1 },
      ChatInvocation: { value: 1 },
    });
    throw e;
  }
}
