import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';

const client = new LambdaClient({});

export class LambdaFunctionClient {
  constructor(private functionName: string) {}

  async invokeAsync(payload?: string): Promise<void> {
    try {
      await client.send(
        new InvokeCommand({
          FunctionName: this.functionName,
          InvocationType: InvocationType.Event,
          ...(payload && { Payload: payload }),
        }),
      );
    } catch (e) {
      throw new Error(`Failed to invoke ${this.functionName}: ${e}`);
    }
  }

  /**
   * Synchronous (RequestResponse) invoke. Returns the parsed JSON payload.
   * Used by request/response flows like the chat route, where the API Lambda
   * waits on the out-of-VPC Chat Lambda's result. Throws on a function error.
   */
  async invokeSync<T>(payload?: string): Promise<T> {
    try {
      const res = await client.send(
        new InvokeCommand({
          FunctionName: this.functionName,
          InvocationType: InvocationType.RequestResponse,
          ...(payload && { Payload: payload }),
        }),
      );
      const text = res.Payload ? new TextDecoder().decode(res.Payload) : '';
      const parsed = (text ? JSON.parse(text) : {}) as T & { errorMessage?: string };
      if (res.FunctionError) {
        throw new Error(`${this.functionName} failed: ${parsed.errorMessage ?? res.FunctionError}`);
      }
      return parsed as T;
    } catch (e) {
      throw new Error(`Failed to invoke ${this.functionName}: ${e}`);
    }
  }
}
