import { App } from 'aws-cdk-lib';
import { CapabilityInsightsSampleEnvironmentStack } from '../lib/stacks/sample-environment-stack';
import { EnvironmentConfig, getEnv } from '../lib/types/environment-config';

const app = new App();

new CapabilityInsightsSampleEnvironmentStack(app, 'CapabilityInsightsSampleEnvironment', {
  ec2KeyPair: getEnv(app, EnvironmentConfig.Ec2KeyPair),
});
