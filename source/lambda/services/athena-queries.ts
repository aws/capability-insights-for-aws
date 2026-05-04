/**
 * Athena SQL query templates for CloudTrail analysis.
 * Kept separate from the client to keep the client slim.
 *
 * The Glue database and table are pre-provisioned by CDK (usage-analysis-stack).
 * These templates are for runtime queries only.
 */

/**
 * Queries CloudTrail logs for distinct service/API/region/account combinations.
 * Filters to AwsApiCall events within the specified time window.
 * @param safeDays - Pre-sanitized integer between 1 and 365.
 */
export function cloudTrailUsageQuery(database: string, tableName: string, safeDays: number): string {
  return `
    SELECT DISTINCT
      eventsource,
      eventname,
      awsregion,
      recipientaccountid
    FROM ${database}.${tableName}
    WHERE eventtime >= date_format(current_date - interval '${safeDays}' day, '%Y-%m-%d')
      AND eventtype = 'AwsApiCall'
    ORDER BY eventsource, eventname
  `;
}
