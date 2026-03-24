import HelpPanel from '@cloudscape-design/components/help-panel';
import AvailabilityStatusIndicator from '~/components/availability/availability-status-indicator';
import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';

export default function HelpMenu() {
  return (
    <HelpPanel header={<h2>Help</h2>}>
      <p>
        This dashboard shows the regional availability of AWS services, API operations, and CloudFormation resource
        types across all AWS regions.
      </p>
      <h3>Capability</h3>
      <dl>
        <dt>Services and features</dt>
        <dd>
          Shows which AWS services and features are available, planned, or not expanding in each region. Dates indicate
          planned launch quarters.
        </dd>
        <dt>API operations</dt>
        <dd>Shows individual API action availability per region for each AWS service SDK.</dd>
        <dt>CloudFormation resources</dt>
        <dd>Shows which CloudFormation resource types are supported in each region.</dd>
      </dl>
      <h3>Status values</h3>
      <ul>
        <li>
          <AvailabilityStatusIndicator status={AvailabilityStatus.AVAILABLE} /> — Generally available in the region
        </li>
        <li>
          <AvailabilityStatusIndicator status={AvailabilityStatus.PLANNED} launchDate="2026 Q1" /> — Expected launch
          quarter
        </li>
        <li>
          <AvailabilityStatusIndicator status={AvailabilityStatus.BEING_PLANNED} /> — Launch is being planned
        </li>
        <li>
          <AvailabilityStatusIndicator status={AvailabilityStatus.NOT_EXPANDING} /> — No plans to expand to this region
        </li>
        <li>
          <AvailabilityStatusIndicator status={AvailabilityStatus.NOT_AVAILABLE} /> — Not available
        </li>
      </ul>
    </HelpPanel>
  );
}
