import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { corsHeaders } from '../types/api';
import { StatusCode } from '../constants/status-codes';
import { ErrorResponse } from '../constants/errors';
import { EnvironmentKey, getOptionalEnv } from '../constants/environment';
import { LambdaFunctionClient } from '../services/lambda-client';
import { logger, errorFields } from '../util/logger';
import type { ChatInvokeRequest, ChatInvokeResponse } from '../chat-lambda-main';
import type { ConverseMessage } from '../chat/agent';

interface ChatRequestBody {
  message: string;
  history?: ConverseMessage[];
  pageName?: string;
}

function parseBody<T>(event: APIGatewayProxyEvent): T | null {
  if (!event.body) return null;
  try {
    return JSON.parse(event.body) as T;
  } catch {
    return null;
  }
}

/**
 * Reduce client-supplied conversation history to TEXT ONLY.
 *
 * `history` is replayed verbatim into the Bedrock transcript, and the type
 * permits `toolUse` / `toolResult` blocks. A crafted client could otherwise
 * inject fabricated `toolResult` blocks to make the model assert false
 * availability data — the answers are meant to be authoritative. Tool context
 * is never trusted from the client: the agent loop rebuilds it server-side by
 * re-executing tools each turn. So we keep only `text` blocks here and drop any
 * turn left empty, preserving just the user/assistant prose for continuity.
 */
function sanitizeHistory(history: ConverseMessage[] | undefined): ConverseMessage[] | undefined {
  if (!Array.isArray(history)) return undefined;
  return history
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && Array.isArray(m.content))
    .map(m => ({
      role: m.role,
      content: m.content.filter(
        (b): b is { text: string } => !!b && typeof (b as { text?: unknown }).text === 'string',
      ),
    }))
    .filter(m => m.content.length > 0);
}

/**
 * POST /chat — proxy one chat turn to the out-of-VPC Chat Lambda (Bedrock
 * agent). Returns 503 when the Chat stack isn't deployed (CHAT_LAMBDA_NAME
 * absent), mirroring how /analysis and /policies/refresh-all gate on their
 * optional stacks. The chat agent runs out-of-VPC because Bedrock has no VPC
 * endpoint; the in-VPC API Lambda only forwards the request.
 */
export async function chatRoute(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const chatLambdaName = getOptionalEnv(EnvironmentKey.CHAT_LAMBDA_NAME);
  if (!chatLambdaName) {
    return ErrorResponse.serviceUnavailable(
      'Chat is not enabled for this deployment. Re-run deploy with --enable-chat.',
    );
  }

  const body = parseBody<ChatRequestBody>(event);
  if (!body || !body.message?.trim()) {
    return ErrorResponse.badRequest('Request body with a non-empty `message` is required');
  }

  const accountId = event.requestContext.accountId;
  const invokePayload: ChatInvokeRequest = {
    message: body.message,
    // Strip any client-supplied tool blocks; only prose history is trusted.
    history: sanitizeHistory(body.history),
    pageName: body.pageName,
    accountId,
  };

  try {
    const result = await new LambdaFunctionClient(chatLambdaName).invokeSync<ChatInvokeResponse>(
      JSON.stringify(invokePayload),
    );
    return { statusCode: StatusCode.OK, headers: corsHeaders, body: JSON.stringify(result) };
  } catch (e) {
    logger.error('chat route failed', errorFields(e));
    return ErrorResponse.internalServerError('Chat request failed. Please try again.');
  }
}
