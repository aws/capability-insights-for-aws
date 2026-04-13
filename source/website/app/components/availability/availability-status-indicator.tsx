import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';

interface AvailabilityStatusIndicatorProps {
  status: AvailabilityStatus | null;
  launchDate?: string;
}

export default function AvailabilityStatusIndicator({ status, launchDate }: AvailabilityStatusIndicatorProps) {
  switch (status) {
    case AvailabilityStatus.AVAILABLE:
      return <StatusIndicator type="success">Available</StatusIndicator>;
    case AvailabilityStatus.PLANNED:
      return (
        <StatusIndicator type="pending" colorOverride="blue">
          {launchDate ?? 'Planned'}
        </StatusIndicator>
      );
    case AvailabilityStatus.PLANNING:
      return (
        <StatusIndicator type="pending" colorOverride="yellow">
          Planning
        </StatusIndicator>
      );
    case AvailabilityStatus.NOT_EXPANDING:
      return <StatusIndicator type="stopped">Not Expanding</StatusIndicator>;
    case AvailabilityStatus.NOT_AVAILABLE:
    default:
      return <StatusIndicator type="error">Not Available</StatusIndicator>;
  }
}
