import { capabilityInsightsClient } from '~/clients/capability-insights-client';
import type { WriteProposal } from '~/types/chat';
import type { CreatePolicyRequest } from '@capability-insights/shared/types/policy-enforcer/policy-api';

/**
 * The write-gate: the agent never mutates. It returns a `WriteProposal`; the
 * user confirms in the UI; only THEN do we call the existing gated client
 * methods. This module renders the proposal and performs the confirmed action
 * through those same methods (with their existing validation), so the chat
 * path adds no new write authority.
 */

/** Human-readable description shown in the confirm card. */
export function describeProposal(proposal: WriteProposal): string {
  return proposal.summary;
}

/** Execute a user-confirmed proposal via the existing gated client methods. Returns a status note. */
export async function confirmProposal(proposal: WriteProposal): Promise<string> {
  switch (proposal.kind) {
    case 'createPolicy': {
      const { policy } = await capabilityInsightsClient.createPolicy(
        proposal.payload as unknown as CreatePolicyRequest,
      );
      return `Created policy "${policy.policyName}".`;
    }
    case 'refreshPolicy': {
      const policyName = String((proposal.payload as { policyName?: string })?.policyName ?? '');
      if (!policyName) throw new Error('Missing policyName for refresh.');
      await capabilityInsightsClient.refreshPolicy(policyName);
      return `Refreshed policy "${policyName}".`;
    }
    case 'deletePolicy': {
      const policyName = String((proposal.payload as { policyName?: string })?.policyName ?? '');
      if (!policyName) throw new Error('Missing policyName for delete.');
      await capabilityInsightsClient.deletePolicy(policyName);
      return `Deleted policy "${policyName}".`;
    }
    case 'triggerAnalysis': {
      const arn = await capabilityInsightsClient.triggerAnalysis();
      return `Started a usage analysis run (${arn}).`;
    }
    case 'syncCapabilityData': {
      await capabilityInsightsClient.syncCapabilityData();
      return 'Triggered a capability data sync.';
    }
    // updatePolicy / refreshAllPolicies are intentionally not auto-executed
    // from chat in v1 — they need richer UI confirmation. Direct the user.
    case 'updatePolicy':
    case 'refreshAllPolicies':
      throw new Error(
        `"${proposal.kind}" must be done from the Policy Enforcer page. The assistant can't run it directly yet.`,
      );
    default:
      throw new Error(`Unsupported action: ${proposal.kind as string}`);
  }
}
