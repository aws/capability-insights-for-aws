/** CloudFormation stack statuses considered "active" (deployed and usable). */
export const ACTIVE_STACK_STATUSES = [
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
  'IMPORT_COMPLETE',
] as const;

/** CloudFormation template stage — PROCESSED returns the fully resolved template. */
export const TemplateStage = {
  ORIGINAL: 'Original',
  PROCESSED: 'Processed',
} as const;

/** Prefix that indicates a CloudFormation resource type belongs to AWS. */
export const AWS_RESOURCE_TYPE_PREFIX = 'AWS::';
