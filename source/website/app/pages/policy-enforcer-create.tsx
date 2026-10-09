import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Wizard from '@cloudscape-design/components/wizard';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import Textarea from '@cloudscape-design/components/textarea';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Button from '@cloudscape-design/components/button';
import Multiselect from '@cloudscape-design/components/multiselect';
import RadioGroup from '@cloudscape-design/components/radio-group';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import type { MultiselectProps } from '@cloudscape-design/components/multiselect';
import {
  capabilityInsightsClient,
  PolicyNameConflictError,
  PolicyValidationError,
} from '~/clients/capability-insights-client';
import type { Region } from '@capability-insights/shared/types/capability/region';
import type { PolicyTag } from '@capability-insights/shared/types/policy-enforcer/policy-configuration';

import type { RouteHandle } from '~/types/route';

const PAGE_NAME = 'Create policy';

export const handle: RouteHandle = {
  pageName: PAGE_NAME,
  breadcrumbs: [{ text: 'Policy Enforcer', href: '/policy-enforcer' }],
};

export function meta() {
  return [{ title: PAGE_NAME }];
}

export default function PolicyEnforcerCreate() {
  const navigate = useNavigate();

  const [policyName, setPolicyName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<PolicyTag[]>([]);
  const [tagKey, setTagKey] = useState('');
  const [tagValue, setTagValue] = useState('');

  const [availableRegions, setAvailableRegions] = useState<Region[]>([]);
  const [selectedRegions, setSelectedRegions] = useState<MultiselectProps.Option[]>([]);

  const [policyType, setPolicyType] = useState<'IAM' | 'SCP'>('IAM');
  const [iamVersion, setIamVersion] = useState<'deny' | 'allow'>('deny');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [activeStepIndex, setActiveStepIndex] = useState(0);

  const [nameError, setNameError] = useState('');
  const [regionsError, setRegionsError] = useState('');
  const [regionsLoadError, setRegionsLoadError] = useState('');

  useEffect(() => {
    capabilityInsightsClient.listRegions().then(
      regions => setAvailableRegions(regions),
      () => setRegionsLoadError('Failed to load regions.'),
    );
  }, []);

  const regionOptions: MultiselectProps.Option[] = useMemo(
    () =>
      availableRegions.map(r => ({
        value: r.Region,
        label: `${r.Region} — ${r.RegionLongName}`,
      })),
    [availableRegions],
  );

  const handleAddTag = () => {
    if (tagKey.trim()) {
      setTags([...tags, { key: tagKey.trim(), value: tagValue.trim() }]);
      setTagKey('');
      setTagValue('');
    }
  };

  const validateStep = async (stepIndex: number): Promise<boolean> => {
    if (stepIndex === 0) {
      if (!policyName.trim()) {
        setNameError('Policy name is required.');
        return false;
      }
      try {
        const existing = await capabilityInsightsClient.listPolicies({ search: policyName.trim() });
        if (existing.some(p => p.policyName === policyName.trim())) {
          setNameError(`Policy with name "${policyName.trim()}" already exists.`);
          return false;
        }
      } catch {
        setNameError('Unable to verify name availability. Please try again.');
        return false;
      }
      setNameError('');
      return true;
    }
    if (stepIndex === 1) {
      if (selectedRegions.length === 0) {
        setRegionsError('Select at least one region.');
        return false;
      }
      setRegionsError('');
      return true;
    }
    return true;
  };

  const handleSubmit = async () => {
    if (!policyName.trim() || selectedRegions.length === 0) {
      setSubmitError('Please complete all required fields.');
      return;
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      await capabilityInsightsClient.createPolicy({
        policyName: policyName.trim(),
        description: description.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
        regions: selectedRegions.map(r => r.value).filter((v): v is string => v !== undefined),
        mode: 'intersection',
        policyType,
      });
      const view = policyType === 'IAM' && iamVersion === 'allow' ? '?view=allow' : '';
      void navigate(`/policy-enforcer/${encodeURIComponent(policyName.trim())}${view}`);
    } catch (e) {
      if (e instanceof PolicyNameConflictError) {
        setSubmitError(e.message);
      } else if (e instanceof PolicyValidationError) {
        setSubmitError(e.message);
      } else {
        setSubmitError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ContentLayout
      header={
        <Header variant="h1" description="Configure regions and policy type to generate a policy.">
          {PAGE_NAME}
        </Header>
      }
    >
      <Wizard
        activeStepIndex={activeStepIndex}
        submitButtonText="Create policy"
        onCancel={() => void navigate('/policy-enforcer')}
        onSubmit={() => void handleSubmit()}
        isLoadingNextStep={submitting}
        onNavigate={({ detail }) => {
          if (detail.reason === 'next') {
            void validateStep(activeStepIndex).then(valid => {
              if (valid) setActiveStepIndex(detail.requestedStepIndex);
            });
            return;
          }
          setActiveStepIndex(detail.requestedStepIndex);
        }}
        steps={[
          {
            title: 'Identify',
            description: 'Give the policy a name and optional metadata.',
            content: (
              <Container>
                <SpaceBetween size="l">
                  <FormField label="Name" description="Unique within this account." errorText={nameError}>
                    <Input
                      value={policyName}
                      onChange={({ detail }) => {
                        setPolicyName(detail.value);
                        if (nameError) setNameError('');
                      }}
                      placeholder="my-policy"
                    />
                  </FormField>
                  <FormField label="Description" description="Optional">
                    <Textarea
                      value={description}
                      onChange={({ detail }) => setDescription(detail.value)}
                      placeholder="Describe what this policy is for"
                    />
                  </FormField>
                  <FormField label="Tags" description="Optional key-value pairs.">
                    <SpaceBetween size="s">
                      {tags.map(t => (
                        <SpaceBetween key={`${t.key}=${t.value}`} size="xs" direction="horizontal">
                          <Box>
                            <Box variant="strong">{t.key}</Box>
                            <Box>{t.value}</Box>
                          </Box>
                          <Button variant="link" onClick={() => setTags(tags.filter(tag => tag !== t))}>
                            Remove
                          </Button>
                        </SpaceBetween>
                      ))}
                      <SpaceBetween size="xs" direction="horizontal">
                        <Input
                          value={tagKey}
                          onChange={({ detail }) => setTagKey(detail.value)}
                          placeholder="key (e.g. team)"
                        />
                        <Input
                          value={tagValue}
                          onChange={({ detail }) => setTagValue(detail.value)}
                          placeholder="value (e.g. payments)"
                        />
                        <Button onClick={handleAddTag} disabled={!tagKey.trim() || !tagValue.trim()}>
                          Add tag
                        </Button>
                      </SpaceBetween>
                    </SpaceBetween>
                  </FormField>
                </SpaceBetween>
              </Container>
            ),
          },
          {
            title: 'Regions',
            description: 'Select your target regions.',
            content: (
              <Container>
                <FormField
                  label="Target regions"
                  description="The policy will deny capabilities not available in ALL of these regions (intersection)."
                  errorText={regionsError || regionsLoadError}
                >
                  <Multiselect
                    selectedOptions={selectedRegions}
                    onChange={({ detail }) => {
                      setSelectedRegions([...detail.selectedOptions]);
                      if (regionsError) setRegionsError('');
                    }}
                    options={regionOptions}
                    placeholder="Choose regions"
                    filteringType="auto"
                  />
                </FormField>
              </Container>
            ),
          },
          {
            title: 'Type',
            description: 'IAM customer managed policy or SCP.',
            content: (
              <Container>
                <SpaceBetween size="l">
                  <FormField label="Policy type">
                    <RadioGroup
                      value={policyType}
                      onChange={({ detail }) => setPolicyType(detail.value as 'IAM' | 'SCP')}
                      items={[
                        {
                          value: 'IAM',
                          label: 'IAM Customer Managed Policy',
                          description:
                            "Deny-only: grants no permissions; it only blocks what isn't available in the selected regions. Can be split into multiple policies if the document exceeds 6,144 chars.",
                        },
                        {
                          value: 'SCP',
                          label: 'Service Control Policy',
                          description:
                            'Attach to an OU to restrict every account in the OU. May be split into up to 5 SCP documents of 5,120 chars each; attach every part.',
                        },
                      ]}
                    />
                  </FormField>
                  {policyType === 'IAM' && (
                    <FormField label="IAM policy version">
                      <RadioGroup
                        value={iamVersion}
                        onChange={({ detail }) => setIamVersion(detail.value as 'deny' | 'allow')}
                        items={[
                          {
                            value: 'deny',
                            label: 'Deny (managed policies)',
                            description:
                              "Grants no permissions. It only blocks the capabilities that aren't available in the selected regions, so roles still need their own policies to allow anything.",
                          },
                          {
                            value: 'allow',
                            label: 'Allow (starter template)',
                            description:
                              'Allow statements for every service available in the selected regions, to download, trim, and create as your own policies — typically under an SCP from this tool. The policy page opens on this template. The Deny managed policies are created too: attach them alongside your trimmed copy unless an SCP from this tool already covers the account.',
                          },
                        ]}
                      />
                    </FormField>
                  )}
                </SpaceBetween>
              </Container>
            ),
          },
          {
            title: 'Review',
            description: 'Confirm and create.',
            content: (
              <SpaceBetween size="l">
                {submitError && <Alert type="error">{submitError}</Alert>}
                <Container>
                  <SpaceBetween size="s">
                    <Box>
                      <Box variant="awsui-key-label">Name</Box>
                      <Box>{policyName || '—'}</Box>
                    </Box>
                    <Box>
                      <Box variant="awsui-key-label">Description</Box>
                      <Box>{description || '—'}</Box>
                    </Box>
                    <Box>
                      <Box variant="awsui-key-label">Tags</Box>
                      <Box>{tags.length > 0 ? tags.map(t => `${t.key}=${t.value}`).join(', ') : '—'}</Box>
                    </Box>
                    <Box>
                      <Box variant="awsui-key-label">Regions</Box>
                      <Box>{selectedRegions.length > 0 ? selectedRegions.map(r => r.value).join(', ') : '—'}</Box>
                    </Box>
                    <Box>
                      <Box variant="awsui-key-label">Type</Box>
                      <Box>{policyType}</Box>
                    </Box>
                    {policyType === 'IAM' && (
                      <Box>
                        <Box variant="awsui-key-label">IAM policy version</Box>
                        <Box>{iamVersion === 'allow' ? 'Allow (starter template)' : 'Deny (managed policies)'}</Box>
                      </Box>
                    )}
                  </SpaceBetween>
                </Container>
              </SpaceBetween>
            ),
          },
        ]}
      />
    </ContentLayout>
  );
}
