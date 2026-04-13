/**
 * Merges multiple CSV strings into one. Preserves the header from the first
 * chunk and appends data rows from all subsequent chunks, discarding their
 * duplicate headers. Empty rows are filtered out.
 *
 * @param chunks - Raw CSV strings to merge
 * @returns The merged CSV string, or empty string if no chunks provided
 */
export function mergeCsv(chunks: string[]): string {
  if (chunks.length === 0) return '';
  const [first, ...rest] = chunks;
  const lines = first.split('\n');
  const header = lines[0];
  const firstRows = lines.slice(1).filter(r => r.length > 0);
  const restRows = rest.flatMap(c =>
    c
      .split('\n')
      .slice(1)
      .filter(r => r.length > 0),
  );
  return [header, ...firstRows, ...restRows].join('\n');
}
