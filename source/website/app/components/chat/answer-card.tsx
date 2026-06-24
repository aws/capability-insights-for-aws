import { useState } from 'react';
import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Link from '@cloudscape-design/components/link';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Alert from '@cloudscape-design/components/alert';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Pagination from '@cloudscape-design/components/pagination';

import { AvailabilityStatus } from '@capability-insights/shared/types/availability/availability-status';
import type { AnswerItem, AnswerLink, AnswerPayload } from '~/types/chat';
import { formatTimestamp } from '~/utils/time-utils';

/** Alternates per page in the drawer's answer card. */
const PAGE_SIZE = 25;

function statusIndicator(status: AnswerItem['status']): React.ReactNode {
  switch (status) {
    case AvailabilityStatus.AVAILABLE:
      return <StatusIndicator type="success">Available</StatusIndicator>;
    case AvailabilityStatus.PLANNED:
    case AvailabilityStatus.PLANNING:
      return <StatusIndicator type="pending">{status}</StatusIndicator>;
    case AvailabilityStatus.NOT_EXPANDING:
      return <StatusIndicator type="warning">Not expanding</StatusIndicator>;
    case AvailabilityStatus.NOT_AVAILABLE:
      return <StatusIndicator type="stopped">Not available</StatusIndicator>;
    default:
      return null;
  }
}

function renderLinks(links: AnswerLink[] | undefined): React.ReactNode {
  if (!links?.length) return null;
  return (
    <SpaceBetween direction="horizontal" size="xs">
      {links.map((l, i) => (
        <Link key={i} href={l.href} external={l.external} variant="primary" fontSize="body-s">
          {l.text}
        </Link>
      ))}
    </SpaceBetween>
  );
}

function renderItem(item: AnswerItem, prominent: boolean): React.ReactNode {
  return (
    <SpaceBetween size="xxs">
      <SpaceBetween direction="horizontal" size="xs">
        <Box variant={prominent ? 'h5' : 'p'} display="inline-block">
          {item.label}
        </Box>
        {statusIndicator(item.status)}
      </SpaceBetween>
      {item.detail && (
        <Box variant="small" color="text-body-secondary">
          {item.detail}
        </Box>
      )}
      {/* Generic typed facts (definition list) — one render path for any detail. */}
      {item.facts?.length ? (
        <div>
          {item.facts.map((f, i) => (
            <div key={i}>
              <Box variant="awsui-key-label" display="inline-block">
                {f.label}:
              </Box>{' '}
              <Box variant="small" display="inline-block">
                {f.values.join(', ')}
              </Box>
            </div>
          ))}
        </div>
      ) : null}
      {renderLinks(item.links)}
    </SpaceBetween>
  );
}

/**
 * The assistant's structured answer, rendered INLINE inside the chat drawer
 * (under the prose reply). It is self-contained — it never navigates or filters
 * the main search-results table, so the rendered answer can't diverge from the
 * count the agent computed. Shows the primary item, alternates collapsed,
 * external docs links, and the freshness footer.
 */
export default function AnswerCard({ answer }: { answer: AnswerPayload }) {
  const [page, setPage] = useState(1);

  if (answer.notEnabled) {
    return (
      <Box padding={{ top: 'xs' }}>
        <Alert type="info">{answer.subtitle ?? 'This feature is not enabled for your account.'}</Alert>
      </Box>
    );
  }

  const alternates = answer.alternates ?? [];
  // primary + alternates are the rows actually carried in the payload. `total`
  // is the exact full count (computed server-side); it may exceed what's carried
  // only for pathological sets above the answer cap, which we flag honestly.
  const carried = (answer.primary ? 1 : 0) + alternates.length;
  const pageCount = Math.max(1, Math.ceil(alternates.length / PAGE_SIZE));
  const start = (page - 1) * PAGE_SIZE;
  const pageItems = alternates.slice(start, start + PAGE_SIZE);
  const overflow = typeof answer.total === 'number' && answer.total > carried;

  return (
    <Box padding={{ top: 'xs' }}>
      <SpaceBetween size="xs">
        <Box variant="h4">{answer.title}</Box>
        {answer.subtitle && (
          <Box variant="small" color="text-body-secondary">
            {answer.subtitle}
          </Box>
        )}

        {renderLinks(answer.links)}

        {answer.primary ? (
          <Box>{renderItem(answer.primary, true)}</Box>
        ) : (
          <Box color="text-body-secondary">No matching results.</Box>
        )}

        {alternates.length > 0 && (
          <ExpandableSection headerText={`${alternates.length} more`} variant="footer" defaultExpanded>
            <SpaceBetween size="s">
              {pageItems.map((it, i) => (
                <Box key={start + i}>{renderItem(it, false)}</Box>
              ))}
              {pageCount > 1 && (
                <Pagination
                  currentPageIndex={page}
                  pagesCount={pageCount}
                  onChange={({ detail }) => setPage(detail.currentPageIndex)}
                  ariaLabels={{
                    nextPageLabel: 'Next page',
                    previousPageLabel: 'Previous page',
                    pageLabel: n => `Page ${n} of ${pageCount}`,
                  }}
                />
              )}
            </SpaceBetween>
          </ExpandableSection>
        )}

        {overflow || answer.asOf ? (
          <Box variant="small" color="text-body-secondary">
            {overflow ? `Showing ${carried} of ${answer.total} — refine your query to narrow the rest. ` : ''}
            {answer.asOf ? `As of ${formatTimestamp(answer.asOf)}.` : ''}
          </Box>
        ) : null}
      </SpaceBetween>
    </Box>
  );
}
