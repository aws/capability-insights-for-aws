import { App } from 'aws-cdk-lib';
import { CapabilityInsightsStack } from '../lib/stacks/capability-insights-stack';
import { UsageAnalysisStack } from '../lib/stacks/usage-analysis-stack';

const app = new App();
new CapabilityInsightsStack(app, 'CapabilityInsightsForAWS');
new UsageAnalysisStack(app, 'CapabilityInsightsUsageAnalysis');
