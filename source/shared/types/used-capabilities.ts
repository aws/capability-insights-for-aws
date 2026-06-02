import type { ApiService } from './capability/api';
import type { EnrichedCfnResource } from './capability/cfn';
import type { Product } from './capability/product';

/**
 * Response shape of the pre-computed `used-capabilities-*.json` files
 * produced by the usage decorator and served by `GET /capabilities`.
 *
 * One file is generated per (scope, usageFilter) pair — six combinations
 * of {account, organization} × {deployed, active_usage, combined}.
 */
export interface UsedCapabilities {
  products: Product[];
  apis: ApiService[];
  cfnResources: EnrichedCfnResource[];
  lastAnalyzedAt: string;
}
