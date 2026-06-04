// Reads the CDK-synthesized CloudFormation template, strips CDK metadata,
// and writes the clean template to the deployment output directory.
import fs from 'fs';
import { stripCdkMetadata } from '../dist/lib/util/strip-cdk-metadata.js';

const raw = JSON.parse(fs.readFileSync('build/cdk.out/CapabilityInsightsForAWS.template.json', 'utf8'));

fs.writeFileSync(
  '../../deployment/dist/template/capability-insights.template.json',
  JSON.stringify(stripCdkMetadata(raw), null, 2),
);

// Package Usage Analysis stack template if it exists
const usageAnalysisPath = 'build/cdk.out/CapabilityInsightsUsageAnalysis.template.json';
if (fs.existsSync(usageAnalysisPath)) {
  const usageRaw = JSON.parse(fs.readFileSync(usageAnalysisPath, 'utf8'));
  fs.writeFileSync(
    '../../deployment/dist/template/usage-analysis.template.json',
    JSON.stringify(stripCdkMetadata(usageRaw), null, 2),
  );
}

// Package Policy Enforcer stack template if it exists
const policyEnforcerPath = 'build/cdk.out/CapabilityInsightsPolicyEnforcer.template.json';
if (fs.existsSync(policyEnforcerPath)) {
  const policyRaw = JSON.parse(fs.readFileSync(policyEnforcerPath, 'utf8'));
  fs.writeFileSync(
    '../../deployment/dist/template/policy-enforcer.template.json',
    JSON.stringify(stripCdkMetadata(policyRaw), null, 2),
  );
}
