import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Container from '@cloudscape-design/components/container';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Button from '@cloudscape-design/components/button';
import Box from '@cloudscape-design/components/box';
import Alert from '@cloudscape-design/components/alert';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Modal from '@cloudscape-design/components/modal';
import Table from '@cloudscape-design/components/table';
import Input from '@cloudscape-design/components/input';
import Pagination from '@cloudscape-design/components/pagination';
import Tabs from '@cloudscape-design/components/tabs';
import { capabilityInsightsClient } from '~/clients/capability-insights-client';
import { formatTimestamp } from '~/utils/time-utils';
import type { PolicyConfiguration } from '@capability-insights/shared/types/policy-enforcer/policy-configuration';
import type { PreviewResponse } from '@capability-insights/shared/types/policy-enforcer/policy-api';

import type { RouteHandle } from '~/types/route';

const PAGE_NAME = 'Policy details';

export const handle: RouteHandle = {
  pageName: PAGE_NAME,
  breadcrumbs: [{ text: 'Policy Enforcer', href: '/policy-enforcer' }],
};

export function meta() {
  return [{ title: PAGE_NAME }];
}

function CopyableArn({ arn }: { arn: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(arn).then(
        () => {
          setCopied(true);
          timerRef.current = setTimeout(() => setCopied(false), 2000);
        },
        () => {
          // Clipboard not available in this context (HTTP)
        },
      );
    }
  };

  return (
    <SpaceBetween size="xs" direction="horizontal">
      <Button variant="icon" iconName="copy" ariaLabel="Copy ARN" onClick={handleCopy} />
      <Box variant="code">{arn}</Box>
      {copied && <StatusIndicator type="success">Copied</StatusIndicator>}
    </SpaceBetween>
  );
}

function generateCdkSnippet(arns: string[], policyName: string, policyType: string): string {
  if (policyType === 'SCP') {
    const lines = arns.map((arn, i) => {
      const id = arns.length > 1 ? `${policyName}-Part${i + 1}` : policyName;
      return `new organizations.CfnPolicy(this, '${id}', {\n  name: '${id}',\n  type: 'SERVICE_CONTROL_POLICY',\n  targetIds: [/* your OU ID, e.g. 'ou-xxxx-xxxxxxxx' */],\n  content: iam.ManagedPolicy.fromManagedPolicyArn(this, '${id}-Ref', '${arn}'),\n});`;
    });
    return lines.join('\n\n');
  }
  const lines = arns.map((arn, i) => {
    const id = arns.length > 1 ? `${policyName}-Part${i + 1}` : policyName;
    return `role.addManagedPolicy(\n  iam.ManagedPolicy.fromManagedPolicyArn(this, '${id}', '${arn}'),\n);`;
  });
  return lines.join('\n\n');
}

function generateCfnSnippet(arns: string[], policyType: string): string {
  if (policyType === 'SCP') {
    const entries = arns.map(arn => `      - "${arn}"`).join('\n');
    return `Type: AWS::Organizations::Policy\nProperties:\n  Type: SERVICE_CONTROL_POLICY\n  TargetIds:\n    - "ou-xxxx-xxxxxxxx"  # Replace with your OU ID\n  Content: !Sub |\n    # Policy content is managed by Capability Insights\n  ManagedPolicyArns:\n${entries}`;
  }
  const entries = arns.map(arn => `      - "${arn}"`).join('\n');
  return `Type: AWS::IAM::Role\nProperties:\n  ManagedPolicyArns:\n${entries}`;
}

const PAGE_SIZE = 25;

function ActionsTable({ actions }: { actions: string[] }) {
  const [filterText, setFilterText] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  const filtered = useMemo(
    () => (filterText ? actions.filter(a => a.toLowerCase().includes(filterText.toLowerCase())) : actions),
    [actions, filterText],
  );

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <Table
      variant="embedded"
      items={paginated}
      trackBy={item => item}
      columnDefinitions={[
        {
          id: 'action',
          header: 'Action',
          cell: item => item,
        },
      ]}
      filter={
        <Input
          type="search"
          placeholder="Search actions"
          value={filterText}
          onChange={({ detail }) => {
            setFilterText(detail.value);
            setCurrentPage(1);
          }}
        />
      }
      pagination={
        <Pagination
          currentPageIndex={currentPage}
          pagesCount={totalPages}
          onChange={({ detail }) => setCurrentPage(detail.currentPageIndex)}
        />
      }
      empty={
        <Box textAlign="center" padding="l">
          <Box variant="p" color="text-body-secondary">
            No actions match the filter.
          </Box>
        </Box>
      }
    />
  );
}

export default function PolicyEnforcerDetail() {
  const { policyName } = useParams<{ policyName: string }>();
  const navigate = useNavigate();

  const [policy, setPolicy] = useState<PolicyConfiguration | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [error, setError] = useState('');

  const fetchData = useCallback(async () => {
    if (!policyName) return;
    setLoading(true);
    try {
      const [policyData, previewData] = await Promise.all([
        capabilityInsightsClient.getPolicy(policyName),
        capabilityInsightsClient.previewPolicy(policyName).catch(() => null),
      ]);
      setPolicy(policyData);
      setPreview(previewData);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [policyName]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleRefresh = async () => {
    if (!policyName) return;
    setRefreshing(true);
    try {
      await capabilityInsightsClient.refreshPolicy(policyName);
      await fetchData();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const handleDelete = async () => {
    if (!policyName) return;
    setDeleting(true);
    try {
      await capabilityInsightsClient.deletePolicy(policyName);
      void navigate('/policy-enforcer');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
      setShowDeleteModal(false);
    }
  };

  if (loading) {
    return (
      <ContentLayout header={<Header variant="h1">Loading…</Header>}>
        <StatusIndicator type="loading">Loading policy details</StatusIndicator>
      </ContentLayout>
    );
  }

  if (error && !policy) {
    return (
      <ContentLayout header={<Header variant="h1">Error</Header>}>
        <Alert type="error">{error}</Alert>
      </ContentLayout>
    );
  }

  if (!policy) return null;

  const allArns = [policy.policyArn, ...(policy.additionalPolicyArns ?? [])].filter(Boolean) as string[];

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          actions={
            <SpaceBetween size="xs" direction="horizontal">
              <Button onClick={() => void handleRefresh()} loading={refreshing}>
                Refresh now
              </Button>
              <Button onClick={() => setShowDeleteModal(true)}>Delete</Button>
            </SpaceBetween>
          }
        >
          {policy.policyName}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && <Alert type="error">{error}</Alert>}

        <Container header={<Header variant="h2">Configuration</Header>}>
          <SpaceBetween size="s">
            <Box>
              <Box variant="awsui-key-label">Description</Box>
              <Box>{policy.description || '—'}</Box>
            </Box>
            <Box>
              <Box variant="awsui-key-label">Type</Box>
              <Box>{policy.policyType}</Box>
            </Box>
            <Box>
              <Box variant="awsui-key-label">Regions</Box>
              <Box>{policy.regions.join(', ')}</Box>
            </Box>
            <Box>
              <Box variant="awsui-key-label">Tags</Box>
              <Box>{policy.tags.length > 0 ? policy.tags.map(t => `${t.key}=${t.value}`).join(', ') : '—'}</Box>
            </Box>
            <Box>
              <Box variant="awsui-key-label">Created</Box>
              <Box>{formatTimestamp(policy.createdAt)}</Box>
            </Box>
            <Box>
              <Box variant="awsui-key-label">Updated</Box>
              <Box>{formatTimestamp(policy.updatedAt)}</Box>
            </Box>
          </SpaceBetween>
        </Container>

        <Container header={<Header variant="h2">Refresh status</Header>}>
          <SpaceBetween size="s">
            <Box>
              <Box variant="awsui-key-label">Status</Box>
              <Box>{policy.status}</Box>
            </Box>
            <Box>
              <Box variant="awsui-key-label">Last refresh</Box>
              <Box>{policy.lastRefreshTime ? formatTimestamp(policy.lastRefreshTime) : '—'}</Box>
            </Box>
            <Box>
              <Box variant="awsui-key-label">Outcome</Box>
              <Box>{policy.lastRefreshOutcome ?? '—'}</Box>
            </Box>
            <Box>
              <Box variant="awsui-key-label">Action count</Box>
              <Box>{policy.lastActionCount ?? '—'}</Box>
            </Box>
          </SpaceBetween>
        </Container>

        {preview && (
          <Container header={<Header variant="h2">Allow-list preview</Header>}>
            <SpaceBetween size="m">
              <ColumnLayout columns={4}>
                <Box>
                  <Box variant="awsui-key-label">Allowed actions</Box>
                  <Box>{preview.actionCount}</Box>
                </Box>
                <Box>
                  <Box variant="awsui-key-label">Excluded by region</Box>
                  <Box>{preview.excludedCount}</Box>
                </Box>
                <Box>
                  <Box variant="awsui-key-label">Estimated size (chars)</Box>
                  <Box>{preview.estimatedPolicySize}</Box>
                </Box>
                <Box>
                  <Box variant="awsui-key-label">Split required</Box>
                  <Box>{preview.splitRequired ? 'Yes' : 'No'}</Box>
                </Box>
              </ColumnLayout>
              <ActionsTable actions={preview.actions} />
            </SpaceBetween>
          </Container>
        )}

        {allArns.length > 0 && (
          <Container header={<Header variant="h2">Policy ARNs</Header>}>
            <SpaceBetween size="m">
              <Alert type="info" header="Attach this policy to apply governance">
                Capability Insights creates the managed policy but does not attach it to any role or organization unit.
                Use the snippets below to attach all {allArns.length} part{allArns.length > 1 ? 's' : ''} to the
                workloads you want governed. Refreshing the policy updates in place — no need to re-attach.
              </Alert>
              {allArns.map((arn, i) => (
                <Container key={arn} header={<Header variant="h3">Part {i + 1}</Header>}>
                  <CopyableArn arn={arn} />
                </Container>
              ))}
              <Tabs
                tabs={[
                  {
                    id: 'cdk',
                    label: 'CDK',
                    content: <pre>{generateCdkSnippet(allArns, policy.policyName, policy.policyType)}</pre>,
                  },
                  {
                    id: 'cloudformation',
                    label: 'CloudFormation',
                    content: <pre>{generateCfnSnippet(allArns, policy.policyType)}</pre>,
                  },
                ]}
              />
            </SpaceBetween>
          </Container>
        )}
      </SpaceBetween>

      <Modal
        visible={showDeleteModal}
        onDismiss={() => setShowDeleteModal(false)}
        header="Delete policy"
        footer={
          <Box float="right">
            <SpaceBetween size="xs" direction="horizontal">
              <Button onClick={() => setShowDeleteModal(false)}>Cancel</Button>
              <Button variant="normal" onClick={() => void handleDelete()} loading={deleting}>
                Delete
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        Are you sure you want to delete{' '}
        <Box variant="strong" display="inline">
          {policyName}
        </Box>
        ? This will also delete the IAM managed policy resource(s). This action cannot be undone.
      </Modal>
    </ContentLayout>
  );
}
