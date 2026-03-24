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
}
