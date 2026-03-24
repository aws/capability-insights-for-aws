import Box from '@cloudscape-design/components/box';
import Badge from '@cloudscape-design/components/badge';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type {
  RegionalAvailability,
  RegionalAvailabilityRow,
} from '@capability-insights/shared/types/availability/regional-availability';

interface AvailabilityStatCardProps {
  label: string;
  loading: boolean;
  badges: [string, string];
  rows: RegionalAvailabilityRow<RegionalAvailability>[];
}

export default function AvailabilityStatCard({ label, loading, badges, rows }: AvailabilityStatCardProps) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <Box variant="p">
        {loading ? (
          'Loading…'
        ) : (
          <SpaceBetween direction="horizontal" size="xs">
            <Badge>
              {rows.filter(r => r.parentId === null).length.toLocaleString()} {badges[0]}
            </Badge>
            <Badge>
              {rows.filter(r => r.parentId !== null).length.toLocaleString()} {badges[1]}
            </Badge>
          </SpaceBetween>
        )}
      </Box>
    </div>
  );
}
