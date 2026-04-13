import type { APIGatewayProxyResult } from 'aws-lambda';
import { LambdaFunctionClient } from '../services/lambda-client';
import { corsHeaders } from '../types/api';
import { StatusCode } from '../constants/status-codes';
import { EnvironmentKey, getEnv } from '../constants/environment';

const dataFetchLambda = new LambdaFunctionClient(getEnv(EnvironmentKey.DATA_FETCH_LAMBDA_NAME));

export const syncCapabilityDataRoute = async (): Promise<APIGatewayProxyResult> => {
  await dataFetchLambda.invokeAsync();

  return {
    statusCode: StatusCode.OK,
    headers: corsHeaders,
    body: JSON.stringify({ message: 'Data sync triggered' }),
  };
};
