import { App } from 'aws-cdk-lib';
import { CapabilityInsightsStack } from '../lib/stacks/capability-insights-stack';

const app = new App();
new CapabilityInsightsStack(app, 'CapabilityInsightsForAWS');
