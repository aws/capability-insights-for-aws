import { PAGE_POLICY_ENFORCER, PAGE_REGION_COMPARE } from '~/constants/app';

/**
 * Per-page suggested questions seeded into the empty chat drawer. Picked by
 * the current route's pageName (from RouteHandle). Falls back to the general
 * capability set.
 *
 * The "superlative" prompts showcase the chat's reason to exist post-decoupling:
 * compositional ranking the static filter table can't do (it can't compute-then
 * -filter). The backend ranks the FULL set in code (orderBy), so these are
 * precise, not truncated samples.
 */
const CAPABILITY_PROMPTS = [
  'Is Amazon Bedrock available in eu-central-1?',
  'Which AWS services are not yet available in ap-south-2?',
  'Compare service availability between us-east-1 and eu-west-1.',
  // Non-usage superlative — works without Usage Analysis (ranks the whole catalog).
  'Which AWS services have the widest regional coverage?',
];

/**
 * "My stuff" superlatives — only meaningful when Usage Analysis is enabled
 * (otherwise they'd answer "not enabled" as a first impression). Appended to the
 * capability set when the flag is on.
 */
const USAGE_SUPERLATIVE_PROMPTS = [
  'Which of the services I use is available in the fewest regions?',
  'What CloudFormation resource type do I use most heavily?',
  'Of the services I use, which has the soonest upcoming regional launch?',
];

const REGION_COMPARE_PROMPTS = [
  'What products are available in us-east-1 but not eu-south-1?',
  'Diff API operations between us-east-1 and ap-southeast-4.',
  'Which CloudFormation resource types are missing in us-gov-west-1?',
];

const POLICY_ENFORCER_PROMPTS = [
  'Draft a policy that denies services unavailable in eu-south-1.',
  'Which of my existing policies need a refresh?',
  'Explain the difference between an IAM Managed Policy and an SCP.',
];

export function suggestedPromptsFor(pageName: string | undefined, usageAnalysisEnabled = false): string[] {
  switch (pageName) {
    case PAGE_REGION_COMPARE:
      return REGION_COMPARE_PROMPTS;
    case PAGE_POLICY_ENFORCER:
      return POLICY_ENFORCER_PROMPTS;
    default:
      // Append "my stuff" ranking prompts only when Usage Analysis is on, so a
      // first-time user without usage data isn't shown questions that answer
      // "not enabled".
      return usageAnalysisEnabled ? [...CAPABILITY_PROMPTS, ...USAGE_SUPERLATIVE_PROMPTS] : CAPABILITY_PROMPTS;
  }
}
