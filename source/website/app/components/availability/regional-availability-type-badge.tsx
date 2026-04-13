import Badge from '@cloudscape-design/components/badge';
import { RegionalAvailabilityType } from '@capability-insights/shared/types/availability/regional-availability';

const COLORS: Record<RegionalAvailabilityType, 'blue' | 'green' | 'grey' | 'red'> = {
  [RegionalAvailabilityType.SERVICE]: 'blue',
  [RegionalAvailabilityType.FEATURE]: 'green',
  [RegionalAvailabilityType.SDK_SERVICE]: 'blue',
  [RegionalAvailabilityType.OPERATION]: 'green',
  [RegionalAvailabilityType.RESOURCE_TYPE]: 'green',
  [RegionalAvailabilityType.PROPERTY]: 'grey',
  [RegionalAvailabilityType.CONFIGURATION]: 'red',
};

export default function RegionalAvailabilityTypeBadge({ type }: { type: RegionalAvailabilityType }) {
  return <Badge color={COLORS[type]}>{type}</Badge>;
}
