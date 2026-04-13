export const FileFormat = {
  JSON: 'json',
  CSV: 'csv',
} as const;

export const ContentType: Record<string, string> = {
  [FileFormat.JSON]: 'application/json',
  [FileFormat.CSV]: 'text/csv',
};
