/* eslint-disable @typescript-eslint/no-explicit-any */
export function stripCdkMetadata(template: Record<string, any>): Record<string, any> {
  const cleaned = { ...template };

  // Remove CDKMetadata resource and Metadata from all resources
  const resources = { ...cleaned.Resources };
  delete resources.CDKMetadata;
  for (const key of Object.keys(resources)) {
    if (resources[key].Metadata) {
      delete resources[key].Metadata;
    }
  }
  cleaned.Resources = resources;

  // Remove CDKMetadataAvailable condition
  if (cleaned.Conditions) {
    const conditions = { ...cleaned.Conditions };
    delete conditions.CDKMetadataAvailable;
    cleaned.Conditions = Object.keys(conditions).length ? conditions : undefined;
  }

  // Remove BootstrapVersion parameter
  if (cleaned.Parameters) {
    const params = { ...cleaned.Parameters };
    delete params.BootstrapVersion;
    cleaned.Parameters = params;
  }

  // Remove CheckBootstrapVersion rule
  if (cleaned.Rules) {
    const rules = { ...cleaned.Rules };
    delete rules.CheckBootstrapVersion;
    cleaned.Rules = Object.keys(rules).length ? rules : undefined;
  }

  // Remove undefined sections
  return Object.fromEntries(Object.entries(cleaned).filter(([, v]) => v !== undefined));
}
