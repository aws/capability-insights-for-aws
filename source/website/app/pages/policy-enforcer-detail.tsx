import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router';
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
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import CopyToClipboard from '@cloudscape-design/components/copy-to-clipboard';
import { capabilityInsightsClient } from '~/clients/capability-insights-client';
import { formatTimestamp } from '~/utils/time-utils';
import { downloadBlob } from '~/utils/export-utils';
import type { PolicyConfiguration } from '@capability-insights/shared/types/policy-enforcer/policy-configuration';
import type {
  AllowTemplateResponse,
  PreviewResponse,
} from '@capability-insights/shared/types/policy-enforcer/policy-api';

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
  return `// Deny-only: keep the role's own permission policies attached as well.\n${lines.join('\n\n')}`;
}

function generateCfnSnippet(arns: string[], policyType: string): string {
  if (policyType === 'SCP') {
    const entries = arns.map(arn => `      - "${arn}"`).join('\n');
    return `Type: AWS::Organizations::Policy\nProperties:\n  Type: SERVICE_CONTROL_POLICY\n  TargetIds:\n    - "ou-xxxx-xxxxxxxx"  # Replace with your OU ID\n  Content: !Sub |\n    # Policy content is managed by Capability Insights\n  ManagedPolicyArns:\n${entries}`;
  }
  const entries = arns.map(arn => `      - "${arn}"`).join('\n');
  return `Type: AWS::IAM::Role\nProperties:\n  ManagedPolicyArns:\n      # Deny-only: keep the role's own permission policies here as well.\n${entries}`;
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

function AllowTemplatePanel({
  policyName,
  template,
  loading,
  error,
}: {
  policyName: string;
  template: AllowTemplateResponse | null;
  loading: boolean;
  error: string;
}) {
  // The clipboard API needs a secure context; the S3 website endpoint serves plain HTTP.
  const canCopy = typeof window !== 'undefined' && window.isSecureContext;
  return (
    <Container
      header={
        <Header
          variant="h2"
          description="Allow statements for every service available in the selected regions. Each part fits one managed policy."
        >
          Allow starter template
        </Header>
      }
    >
      <SpaceBetween size="m">
        <Alert type="warning" header="A starting point to trim, not a guardrail">
          Each entry allows a whole service (<code>service:*</code>) that has at least one action available in the
          selected regions, IAM included. Within those services it also allows the actions that aren&apos;t available,
          so pair it with an SCP from this tool or with this policy&apos;s Deny managed policies, either of which blocks
          them. Download (or copy) the parts, remove the services your workloads don&apos;t need, and create the result
          as your own policies. Capability Insights doesn&apos;t create, attach, or refresh this template.
        </Alert>
        {loading && <StatusIndicator type="loading">Generating template</StatusIndicator>}
        {error && <Alert type="error">{error}</Alert>}
        {template?.documents.map((doc, i) => {
          const json = JSON.stringify(doc, null, 2);
          const fileName = `${policyName}-allow-template${template.documents.length > 1 ? `-part${i + 1}` : ''}.json`;
          return (
            <Container
              key={i}
              header={
                <Header
                  variant="h3"
                  actions={
                    <SpaceBetween size="xs" direction="horizontal">
                      <CopyToClipboard
                        variant="button"
                        textToCopy={json}
                        disabled={!canCopy}
                        disabledReason="Copying needs HTTPS. Use Download, or select the text below."
                        copyButtonText="Copy"
                        copyButtonAriaLabel={`Copy part ${i + 1}`}
                        copySuccessText="Copied"
                        copyErrorText="Copy failed"
                      />
                      <Button
                        iconName="download"
                        ariaLabel={`Download part ${i + 1}`}
                        onClick={() => downloadBlob(json, fileName, 'application/json')}
                      >
                        Download
                      </Button>
                    </SpaceBetween>
                  }
                >
                  Part {i + 1}
                </Header>
              }
            >
              <pre>{json}</pre>
            </Container>
          );
        })}
      </SpaceBetween>
    </Container>
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
  // `?view=allow` opens the Allow starter template, e.g. straight after creating the policy with it.
  const [searchParams, setSearchParams] = useSearchParams();
  const iamView: 'deny' | 'allow' = searchParams.get('view') === 'allow' ? 'allow' : 'deny';
  const [template, setTemplate] = useState<AllowTemplateResponse | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState('');

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

  const policyType = policy?.policyType;
  useEffect(() => {
    if (iamView !== 'allow' || policyType !== 'IAM' || !policyName || template || templateLoading || templateError) {
      return;
    }
    setTemplateLoading(true);
    capabilityInsightsClient
      .getAllowTemplate(policyName)
      .then(setTemplate, (e: unknown) => setTemplateError(e instanceof Error ? e.message : String(e)))
      .finally(() => setTemplateLoading(false));
  }, [iamView, policyType, policyName, template, templateLoading, templateError]);

  const handleIamViewChange = (view: 'deny' | 'allow') => {
    if (view === 'allow') setTemplateError('');
    setSearchParams(view === 'allow' ? { view: 'allow' } : {}, { replace: true, preventScrollReset: true });
  };

  const handleRefresh = async () => {
    if (!policyName) return;
    setRefreshing(true);
    try {
      await capabilityInsightsClient.refreshPolicy(policyName);
      setTemplate(null);
      setTemplateError('');
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
              <Box variant="awsui-key-label">Available actions</Box>
              <Box>{policy.lastActionCount ?? '—'}</Box>
            </Box>
          </SpaceBetween>
        </Container>

        {preview && (
          <Container
            header={
              <Header
                variant="h2"
                description="Catalog actions available in the selected regions. The generated policy denies the unavailable ones and does not grant these."
              >
                Availability preview
              </Header>
            }
          >
            <SpaceBetween size="m">
              <ColumnLayout columns={4}>
                <Box>
                  <Box variant="awsui-key-label">Available actions</Box>
                  <Box>{preview.actionCount}</Box>
                </Box>
                <Box>
                  <Box variant="awsui-key-label">Unavailable actions</Box>
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

        {policy.policyType === 'IAM' && (
          <SegmentedControl
            label="Policy view"
            selectedId={iamView}
            onChange={({ detail }) => handleIamViewChange(detail.selectedId as 'deny' | 'allow')}
            options={[
              { id: 'deny', text: 'Deny (managed policies)' },
              { id: 'allow', text: 'Allow (starter template)' },
            ]}
          />
        )}

        {policy.policyType === 'IAM' && iamView === 'allow' && (
          <AllowTemplatePanel
            policyName={policy.policyName}
            template={template}
            loading={templateLoading}
            error={templateError}
          />
        )}

        {allArns.length > 0 && (policy.policyType !== 'IAM' || iamView === 'deny') && (
          <Container header={<Header variant="h2">Policy ARNs</Header>}>
            <SpaceBetween size="m">
              <Alert type="info" header="Attach this policy to apply governance">
                {policy.policyType === 'SCP' ? (
                  <>
                    Capability Insights stores each SCP document as a managed policy but does not create or attach SCPs.
                    Every statement is a Deny. Copy each of the {allArns.length} part{allArns.length > 1 ? 's' : ''}{' '}
                    into an SCP in AWS Organizations and attach it to the OU or account. Refreshes, including the weekly
                    schedule, update the documents here, not your SCPs: re-copy every part after a refresh.
                  </>
                ) : (
                  <>
                    Capability Insights creates the managed policies but does not attach them to any role. Every
                    statement is a Deny, so they grant no permissions: they only restrict what the workloads&apos; own
                    permission policies allow. Use the snippets below to attach all {allArns.length} part
                    {allArns.length > 1 ? 's' : ''} to the workloads you want governed. A refresh updates the parts in
                    place but can add or remove parts: after a refresh, attach every part listed below, and detach and
                    delete any PolicyEnforcer-{policy.policyName}-Part&lt;N&gt; that is no longer listed.
                  </>
                )}
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
