// Reads the CDK-synthesized CloudFormation template, strips CDK metadata,
// and writes the clean template to the deployment output directory.
import fs from 'fs';
import { stripCdkMetadata } from '../dist/lib/util/strip-cdk-metadata.js';

const raw = JSON.parse(fs.readFileSync('build/cdk.out/CapabilityInsightsForAWS.template.json', 'utf8'));

fs.writeFileSync(
  '../../deployment/dist/template/capability-insights.template.json',
  JSON.stringify(stripCdkMetadata(raw), null, 2),
);
