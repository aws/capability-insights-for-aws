import { App } from 'aws-cdk-lib';

export enum EnvironmentConfig {
  Ec2KeyPair = 'ec2KeyPair',
}

export function getEnv(app: App, key: EnvironmentConfig): string | undefined {
  return app.node.tryGetContext(key) || undefined;
}
