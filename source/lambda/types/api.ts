import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

export type RouteHandler = (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

export const corsHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};
