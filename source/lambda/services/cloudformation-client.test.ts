import { describe, it, expect, beforeEach } from 'vitest';
import { CloudFormationClient, GetTemplateCommand, ListStacksCommand } from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { ACTIVE_STACK_STATUSES } from '../constants/cloudformation';
import { getProcessedTemplate, listActiveStacks } from './cloudformation-client';

const cfnMock = mockClient(CloudFormationClient);

describe('getProcessedTemplate', () => {
  beforeEach(() => {
    cfnMock.reset();
  });

  it('parses a JSON template body', async () => {
    cfnMock.on(GetTemplateCommand).resolves({
      TemplateBody: JSON.stringify({
        Resources: {
          MyFunction: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'python3.11' } },
        },
      }),
    });

    const result = await getProcessedTemplate(new CloudFormationClient({}), 'stack-json');

    expect(result).toEqual({
      Resources: {
        MyFunction: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'python3.11' } },
      },
    });
  });

  it('parses a YAML template body with CloudFormation intrinsic tags', async () => {
    // Mirrors the real-world case: CloudFormation's GetTemplate returns
    // whatever format was submitted. YAML templates use !Ref, !GetAtt,
    // !Sub, etc. which standard YAML parsers reject.
    const yamlTemplate = `
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  MyInstance:
    Type: AWS::EC2::Instance
    Properties:
      InstanceType: t3.medium
      ImageId: !Sub '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/amzn2-ami-hvm-x86_64-gp2}}'
      SubnetId: !Ref MySubnet
      SecurityGroupIds:
        - !Ref MySecurityGroup
      IamInstanceProfile: !GetAtt MyRole.Arn
`;
    cfnMock.on(GetTemplateCommand).resolves({ TemplateBody: yamlTemplate });

    const result = await getProcessedTemplate(new CloudFormationClient({}), 'stack-yaml');

    // Confirms the resource type + scalar properties survive the parse.
    // Intrinsic tags are kept as opaque objects; downstream code only
    // cares about scalar properties so this is enough.
    const resources = result?.Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>;
    expect(resources.MyInstance.Type).toBe('AWS::EC2::Instance');
    expect(resources.MyInstance.Properties.InstanceType).toBe('t3.medium');
  });

  it('parses YAML using newer intrinsic tags (!Length, !ToJsonString)', async () => {
    // Locks in the recent addition of Length and ToJsonString to the
    // intrinsic-tag list. If either is removed, this test fails before
    // any production stack does.
    const yamlTemplate = `
Resources:
  MyBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: my-bucket
      Tags:
        - Key: ItemCount
          Value: !Length [a, b, c]
        - Key: Config
          Value: !ToJsonString { foo: bar }
`;
    cfnMock.on(GetTemplateCommand).resolves({ TemplateBody: yamlTemplate });

    const result = await getProcessedTemplate(new CloudFormationClient({}), 'stack-newer-tags');

    const resources = result?.Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>;
    expect(resources.MyBucket.Type).toBe('AWS::S3::Bucket');
    expect(resources.MyBucket.Properties.BucketName).toBe('my-bucket');
  });

  it('returns null when TemplateBody is absent', async () => {
    cfnMock.on(GetTemplateCommand).resolves({});

    const result = await getProcessedTemplate(new CloudFormationClient({}), 'stack-empty');

    expect(result).toBeNull();
  });

  it('returns an empty result for a fully empty TemplateBody string', async () => {
    // CFN itself wouldn't return this, but the fallback path (YAML branch
    // when body doesn't start with '{') gracefully handles it.
    cfnMock.on(GetTemplateCommand).resolves({ TemplateBody: '' });

    const result = await getProcessedTemplate(new CloudFormationClient({}), 'stack-blank');

    // yaml.load('') returns null; downstream code's `if (!resources)` guard
    // handles that. The function shouldn't throw.
    expect(result).toBeNull();
  });

  it('returns null when JSON parse fails', async () => {
    cfnMock.on(GetTemplateCommand).resolves({ TemplateBody: '{ broken: json' });

    const result = await getProcessedTemplate(new CloudFormationClient({}), 'stack-bad');

    expect(result).toBeNull();
  });
});

describe('listActiveStacks', () => {
  beforeEach(() => {
    cfnMock.reset();
  });

  it('filters by ACTIVE_STACK_STATUSES', async () => {
    cfnMock.on(ListStacksCommand).resolves({ StackSummaries: [] });

    await listActiveStacks(new CloudFormationClient({}));

    const calls = cfnMock.commandCalls(ListStacksCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.StackStatusFilter).toEqual([...ACTIVE_STACK_STATUSES]);
  });

  it('paginates through multiple pages until NextToken is absent', async () => {
    cfnMock
      .on(ListStacksCommand)
      .resolvesOnce({
        StackSummaries: [{ StackName: 'stack-1', StackStatus: 'CREATE_COMPLETE', CreationTime: new Date() }],
        NextToken: 'page-2',
      })
      .resolvesOnce({
        StackSummaries: [
          { StackName: 'stack-2', StackStatus: 'UPDATE_COMPLETE', CreationTime: new Date() },
          { StackName: 'stack-3', StackStatus: 'CREATE_COMPLETE', CreationTime: new Date() },
        ],
        NextToken: 'page-3',
      })
      .resolvesOnce({
        StackSummaries: [{ StackName: 'stack-4', StackStatus: 'CREATE_COMPLETE', CreationTime: new Date() }],
        // No NextToken — terminates the loop
      });

    const stacks = await listActiveStacks(new CloudFormationClient({}));

    expect(stacks.map(s => s.StackName)).toEqual(['stack-1', 'stack-2', 'stack-3', 'stack-4']);

    // Three calls; second and third receive the prior NextToken.
    const calls = cfnMock.commandCalls(ListStacksCommand);
    expect(calls).toHaveLength(3);
    expect(calls[0].args[0].input.NextToken).toBeUndefined();
    expect(calls[1].args[0].input.NextToken).toBe('page-2');
    expect(calls[2].args[0].input.NextToken).toBe('page-3');
  });

  it('returns [] when the API yields no stacks', async () => {
    cfnMock.on(ListStacksCommand).resolves({ StackSummaries: [] });

    const stacks = await listActiveStacks(new CloudFormationClient({}));

    expect(stacks).toEqual([]);
  });

  it('handles a missing StackSummaries field as an empty page', async () => {
    cfnMock.on(ListStacksCommand).resolves({});

    const stacks = await listActiveStacks(new CloudFormationClient({}));

    expect(stacks).toEqual([]);
  });
});
