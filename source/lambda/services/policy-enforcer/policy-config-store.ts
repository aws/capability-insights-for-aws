import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { logger } from '../../util/logger';
import type { PolicyConfiguration } from '@capability-insights/shared/types/policy-enforcer/policy-configuration';
import type {
  CreatePolicyRequest,
  ListPoliciesQuery,
} from '@capability-insights/shared/types/policy-enforcer/policy-api';
import { PolicyStatus } from '@capability-insights/shared/types/policy-enforcer/policy-enums';

/**
 * Persistence layer for `PolicyConfiguration` records.
 *
 * Schema:
 *   - Partition key: `accountId`
 *   - Sort key:      `policyName`
 *
 * The composite primary key gives us atomic per-account name uniqueness
 * for free — `Put` with `attribute_not_exists(policyName)` fails on
 * duplicate without races, and listing is a single primary-key Query.
 *
 * `policyName` is therefore the policy's stable identifier; rename is
 * not supported and would require delete + create.
 */
export class PolicyConfigStore {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    private readonly accountId: string,
    client?: DynamoDBDocumentClient,
  ) {
    this.client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  /**
   * Creates a new Policy_Configuration. Throws when the policyName is
   * already in use within this account.
   */
  async createPolicy(request: CreatePolicyRequest): Promise<PolicyConfiguration> {
    const now = new Date().toISOString();
    const policy: PolicyConfiguration = {
      policyName: request.policyName,
      description: request.description,
      tags: request.tags ?? [],
      regions: request.regions,
      mode: request.mode,
      policyType: request.policyType,
      exceptions: request.exceptions ?? [],
      status: PolicyStatus.PENDING,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...policy, accountId: this.accountId },
          // Atomic uniqueness on the (accountId, policyName) primary key —
          // a duplicate insert is rejected with ConditionalCheckFailed.
          ConditionExpression: 'attribute_not_exists(policyName)',
        }),
      );
    } catch (error: unknown) {
      const code = (error as { name?: string }).name;
      if (code === 'ConditionalCheckFailedException') {
        throw new PolicyNameConflictError(request.policyName);
      }
      logger.error('createPolicy failed', { policyName: request.policyName, error: String(error) });
      throw new Error(`Failed to create policy "${request.policyName}": ${error}`);
    }

    logger.info('createPolicy succeeded', { policyName: policy.policyName });
    return policy;
  }

  /** Returns the configuration for `policyName`, or null if absent. */
  async getPolicy(policyName: string): Promise<PolicyConfiguration | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { accountId: this.accountId, policyName },
      }),
    );

    if (!result.Item) return null;
    return result.Item as PolicyConfiguration;
  }

  /**
   * Lists policies for the configured account, optionally filtered. Uses
   * a primary-key Query (no GSI). Tag filtering is applied in-memory
   * because DynamoDB filter expressions can't natively scope into a
   * list-of-maps attribute.
   */
  async listPolicies(query: ListPoliciesQuery = {}): Promise<PolicyConfiguration[]> {
    const items: PolicyConfiguration[] = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'accountId = :a',
          ExpressionAttributeValues: { ':a': this.accountId },
          ExclusiveStartKey: lastKey,
        }),
      );

      for (const item of page.Items ?? []) {
        items.push(item as PolicyConfiguration);
      }

      lastKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    return applyClientSideFilters(items, query);
  }

  /**
   * Applies a partial update to a Policy_Configuration. Throws if the policy
   * does not exist. `policyName`, `accountId`, and `createdAt` are immutable
   * and silently stripped from the input.
   */
  async updatePolicy(policyName: string, updates: Partial<PolicyConfiguration>): Promise<PolicyConfiguration> {
    // Strip immutable fields so callers can hand us an arbitrary partial.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { policyName: _name, createdAt: _created, ...rest } = updates as Record<string, unknown>;
    delete (rest as Record<string, unknown>).accountId;

    const setExpressions: string[] = [];
    const removeExpressions: string[] = [];
    const expressionNames: Record<string, string> = {};
    const expressionValues: Record<string, unknown> = {};
    let i = 0;

    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      const nameAlias = `#a${i}`;
      const valueAlias = `:v${i}`;
      expressionNames[nameAlias] = key;
      if (value === null) {
        removeExpressions.push(nameAlias);
      } else {
        expressionValues[valueAlias] = value;
        setExpressions.push(`${nameAlias} = ${valueAlias}`);
      }
      i++;
    }

    // Always bump updatedAt.
    expressionNames['#updated'] = 'updatedAt';
    expressionValues[':now'] = new Date().toISOString();
    setExpressions.push('#updated = :now');

    const updateExpression = [
      setExpressions.length ? `SET ${setExpressions.join(', ')}` : '',
      removeExpressions.length ? `REMOVE ${removeExpressions.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' ');

    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { accountId: this.accountId, policyName },
          UpdateExpression: updateExpression,
          ExpressionAttributeNames: expressionNames,
          ExpressionAttributeValues: expressionValues,
          ConditionExpression: 'attribute_exists(policyName)',
          ReturnValues: 'ALL_NEW',
        }),
      );

      logger.info('updatePolicy succeeded', { policyName });
      return result.Attributes as PolicyConfiguration;
    } catch (error: unknown) {
      const code = (error as { name?: string }).name;
      if (code === 'ConditionalCheckFailedException') {
        throw new PolicyNotFoundError(policyName);
      }
      logger.error('updatePolicy failed', { policyName, error: String(error) });
      throw new Error(`Failed to update policy "${policyName}": ${error}`);
    }
  }

  /** Deletes a Policy_Configuration. Throws if the policy does not exist. */
  async deletePolicy(policyName: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { accountId: this.accountId, policyName },
          ConditionExpression: 'attribute_exists(policyName)',
        }),
      );
    } catch (error: unknown) {
      const code = (error as { name?: string }).name;
      if (code === 'ConditionalCheckFailedException') {
        throw new PolicyNotFoundError(policyName);
      }
      logger.error('deletePolicy failed', { policyName, error: String(error) });
      throw new Error(`Failed to delete policy "${policyName}": ${error}`);
    }

    logger.info('deletePolicy succeeded', { policyName });
  }
}

/** Throws when create is called with a name that already exists. */
export class PolicyNameConflictError extends Error {
  constructor(public readonly policyName: string) {
    super(`Policy with name "${policyName}" already exists`);
    this.name = 'PolicyNameConflictError';
  }
}

/** Throws when an operation references a non-existent policyName. */
export class PolicyNotFoundError extends Error {
  constructor(public readonly policyName: string) {
    super(`Policy "${policyName}" not found`);
    this.name = 'PolicyNotFoundError';
  }
}

/** Applies the optional `ListPoliciesQuery` filters in-memory. */
function applyClientSideFilters(items: PolicyConfiguration[], query: ListPoliciesQuery): PolicyConfiguration[] {
  let filtered = items;

  if (query.status) {
    filtered = filtered.filter(p => p.status === query.status);
  }

  if (query.tagKey && query.tagValue) {
    filtered = filtered.filter(p => p.tags.some(t => t.key === query.tagKey && t.value === query.tagValue));
  }

  if (query.search) {
    const needle = query.search.toLowerCase();
    filtered = filtered.filter(p => {
      const name = p.policyName.toLowerCase().includes(needle);
      const desc = p.description?.toLowerCase().includes(needle) ?? false;
      return name || desc;
    });
  }

  return filtered;
}
