import type { RegionCode } from './region';
import type { AvailabilityStatus } from '../availability/availability-status';

export interface CfnResourceConfiguration {
  resourceConfigurationName: string;
  regionalAvailability: Record<RegionCode, AvailabilityStatus>;
  /**
   * Stacks that contributed this configuration value. Present only on
   * personalized ("My stuff") output from the usage decorator; absent on the
   * master catalog. Lets the UI filter configurations (e.g., `t3.medium`
   * specifically from `test-assets-*`, not `CapabilityInsightsSampleEnv`).
   */
  stacks?: string[];
}

export interface CfnResourceProperty {
  resourcePropertyName: string;
  resourceConfigurations: CfnResourceConfiguration[];
}

export interface CfnResourceType {
  resourceTypeName: string;
  resourceTypeHomepage: string;
  regionalAvailability: Record<RegionCode, AvailabilityStatus>;
  resourceProperties?: CfnResourceProperty[];
}

export interface CfnResource {
  serviceName: string;
  resourceTypes: CfnResourceType[];
}

/**
 * CFN resource type as emitted by the usage decorator's personalized
 * ("My stuff") output. Adds a `usage` subfield describing which stacks
 * contributed this resource type and which scalar property values were
 * observed in those stacks. Absent on the master catalog.
 */
export interface EnrichedCfnResourceType extends CfnResourceType {
  usage?: {
    stacks: string[];
    properties: Record<string, string[]>;
    count: number;
  };
}

/**
 * Decorator-emitted CFN service entry. Same shape as `CfnResource` but
 * `resourceTypes` are enriched with usage attribution.
 */
export interface EnrichedCfnResource extends Omit<CfnResource, 'resourceTypes'> {
  resourceTypes: EnrichedCfnResourceType[];
}
