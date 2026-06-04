import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { RouteHandler } from './types/api';
import { HttpMethod } from './constants/http-methods';
import { ErrorResponse } from './constants/errors';
import { logger } from './util/logger';
import { ParamRouter } from './util/router';
import { syncCapabilityDataRoute } from './routes/sync-capability-data-route';
import { handleAnalyze } from './routes/analyze-route';
import { getUsedCapabilities } from './routes/usage-route';
import {
  createPolicyRoute,
  listPoliciesRoute,
  getPolicyRoute,
  updatePolicyRoute,
  deletePolicyRoute,
  refreshPolicyRoute,
  previewPolicyRoute,
} from './routes/policy-routes';

const routes: Map<string, RouteHandler> = new Map();
const paramRouter = new ParamRouter();

function registerRoute(method: string, path: string, handler: RouteHandler) {
  routes.set(`${method} ${path}`, handler);
}

// --- Register routes ---
registerRoute(HttpMethod.POST, '/syncCapabilityData', syncCapabilityDataRoute);
// Usage analysis: start analysis (POST) and poll status (GET)
registerRoute(HttpMethod.POST, '/analysis', handleAnalyze);
registerRoute(HttpMethod.GET, '/analysis', handleAnalyze);
// Account-aware filtering: returns services/APIs based on usage data
registerRoute(HttpMethod.GET, '/capabilities', getUsedCapabilities);

// Policy Enforcer routes (parameterized)
registerRoute(HttpMethod.POST, '/policies', createPolicyRoute);
registerRoute(HttpMethod.GET, '/policies', listPoliciesRoute);
paramRouter.register(HttpMethod.GET, '/policies/:policyName', getPolicyRoute);
paramRouter.register(HttpMethod.PUT, '/policies/:policyName', updatePolicyRoute);
paramRouter.register(HttpMethod.DELETE, '/policies/:policyName', deletePolicyRoute);
paramRouter.register(HttpMethod.POST, '/policies/:policyName/refresh', refreshPolicyRoute);
paramRouter.register(HttpMethod.GET, '/policies/:policyName/preview', previewPolicyRoute);

// --- Main handler ---
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const key = `${event.httpMethod} ${event.path}`;
  logger.info('Received event', {
    route: key,
    requestId: event.requestContext?.requestId,
  });

  try {
    const exactHandler = routes.get(key);
    if (exactHandler) {
      return await exactHandler(event);
    }

    const paramMatch = paramRouter.match(event.httpMethod, event.path);
    if (paramMatch) {
      return await paramMatch.handler(event, paramMatch.params);
    }

    return ErrorResponse.notFound(`${key} not found`);
  } catch (e) {
    logger.error('Unhandled exception', { route: key, error: String(e) });
    return ErrorResponse.internalServerError(String(e));
  }
};
