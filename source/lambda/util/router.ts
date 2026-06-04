import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

/**
 * Handler that may receive parsed path parameters as a second argument.
 * Used by parameterized routes only; exact-match routes use `RouteHandler`.
 */
export type ParamRouteHandler = (
  event: APIGatewayProxyEvent,
  params: Record<string, string>,
) => Promise<APIGatewayProxyResult>;

interface ParamRoute {
  method: string;
  segments: Array<{ literal?: string; paramName?: string }>;
  handler: ParamRouteHandler;
}

/**
 * Tiny route matcher supporting `:param` segments.
 *
 * Patterns are matched against the request path split by `/`. Literal
 * segments must equal exactly; segments declared as `:name` capture into
 * a parameters map passed to the handler.
 *
 * Designed to live alongside the existing exact-match map in
 * `api-lambda-main.ts` rather than replace it. Only routes that need
 * params register here.
 */
export class ParamRouter {
  private readonly routes: ParamRoute[] = [];

  register(method: string, pattern: string, handler: ParamRouteHandler): void {
    const segments = pattern
      .split('/')
      .filter(s => s.length > 0)
      .map(segment => (segment.startsWith(':') ? { paramName: segment.slice(1) } : { literal: segment }));
    this.routes.push({ method, segments, handler });
  }

  /**
   * Returns a match for `(method, path)` if any pattern fits, else null.
   * The first registered pattern that matches wins.
   */
  match(method: string, path: string): { handler: ParamRouteHandler; params: Record<string, string> } | null {
    const pathSegments = path.split('/').filter(s => s.length > 0);

    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== pathSegments.length) continue;

      const params: Record<string, string> = {};
      let allMatch = true;

      for (let i = 0; i < route.segments.length; i++) {
        const expected = route.segments[i];
        const actual = pathSegments[i];

        if (expected.literal !== undefined) {
          if (expected.literal !== actual) {
            allMatch = false;
            break;
          }
        } else if (expected.paramName !== undefined) {
          params[expected.paramName] = decodeURIComponent(actual);
        }
      }

      if (allMatch) {
        return { handler: route.handler, params };
      }
    }

    return null;
  }
}
