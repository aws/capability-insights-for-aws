import type { APIGatewayProxyResult } from 'aws-lambda';
import { corsHeaders } from '../types/api';
import { StatusCode } from './status-codes';

export const ErrorResponse = {
  badRequest: (message: string): APIGatewayProxyResult => ({
    statusCode: StatusCode.BAD_REQUEST,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'Bad Request', message }),
  }),

  notFound: (message: string): APIGatewayProxyResult => ({
    statusCode: StatusCode.NOT_FOUND,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'Not Found', message }),
  }),

  conflict: (message: string): APIGatewayProxyResult => ({
    statusCode: StatusCode.CONFLICT,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'Conflict', message }),
  }),

  serviceUnavailable: (message: string): APIGatewayProxyResult => ({
    statusCode: StatusCode.SERVICE_UNAVAILABLE,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'Service Unavailable', message }),
  }),

  internalServerError: (message: string): APIGatewayProxyResult => ({
    statusCode: StatusCode.INTERNAL_SERVER_ERROR,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'Internal Server Error', message }),
  }),

  unauthorized: (message: string): APIGatewayProxyResult => ({
    statusCode: StatusCode.UNAUTHORIZED,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'Unauthorized', message }),
  }),

  forbidden: (message: string): APIGatewayProxyResult => ({
    statusCode: StatusCode.FORBIDDEN,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'Forbidden', message }),
  }),
} as const;
