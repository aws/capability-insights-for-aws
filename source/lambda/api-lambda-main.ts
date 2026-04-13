import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { RouteHandler } from './types/api';
import { HttpMethod } from './constants/http-methods';
import { ErrorResponse } from './constants/errors';
import { logger } from './util/logger';
import { syncCapabilityDataRoute } from './routes/sync-capability-data-route';
const routes: Map<string, RouteHandler> = new Map();

function registerRoute(method: string, path: string, handler: RouteHandler) {
  routes.set(`${method} ${path}`, handler);
}

// --- Register routes ---
registerRoute(HttpMethod.POST, '/syncCapabilityData', syncCapabilityDataRoute);

// --- Main handler ---
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const key = `${event.httpMethod} ${event.path}`;
  logger.info('Received event', {
    route: key,
    requestId: event.requestContext?.requestId,
  });

  try {
    const routeHandler = routes.get(key);

    if (routeHandler) {
      return await routeHandler(event);
    }

    return ErrorResponse.notFound(`${key} not found`);
  } catch (e) {
    logger.error('Unhandled exception', { route: key, error: String(e) });
    return ErrorResponse.internalServerError(String(e));
  }
};
