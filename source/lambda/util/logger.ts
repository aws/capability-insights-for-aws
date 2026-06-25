type LogLevel = 'INFO' | 'WARN' | 'ERROR';

function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
  const entry = { timestamp: new Date().toISOString(), level, message, ...data };
  const output = JSON.stringify(entry);
  if (level === 'ERROR') console.error(output);
  else if (level === 'WARN') console.warn(output);
  else console.log(output);
}

export const logger = {
  info: (message: string, data?: Record<string, unknown>) => log('INFO', message, data),
  warn: (message: string, data?: Record<string, unknown>) => log('WARN', message, data),
  error: (message: string, data?: Record<string, unknown>) => log('ERROR', message, data),
};

/**
 * Normalizes an unknown caught value into structured log fields, preserving
 * the stack trace when available. Use as `logger.warn('msg', errorFields(e))`.
 */
export function errorFields(e: unknown): { error: string; stack?: string } {
  if (e instanceof Error) {
    return { error: e.message, stack: e.stack };
  }
  return { error: String(e) };
}

/** One metric value plus its CloudWatch unit (defaults to Count). */
export interface Metric {
  value: number;
  unit?: 'Count' | 'Milliseconds' | 'Seconds' | 'Bytes' | 'Percent' | 'None';
}

/**
 * Emit a CloudWatch Embedded Metric Format (EMF) line. CloudWatch automatically
 * extracts each named value as a metric under `namespace` — no SDK and no
 * PutMetricData API call, just a structured stdout line (the same mechanism the
 * JSON logger above relies on). Use for cheap operational metrics you want to
 * chart or alarm on (e.g. agent turn counts) without standing up instrumentation.
 *
 * Dimensionless on purpose: every value aggregates across all invocations, so
 * there is no per-value metric-stream cardinality cost.
 */
export function emitMetrics(namespace: string, metrics: Record<string, Metric>): void {
  const entries = Object.entries(metrics);
  const definitions = entries.map(([name, m]) => ({ Name: name, Unit: m.unit ?? 'Count' }));
  const values = Object.fromEntries(entries.map(([name, m]) => [name, m.value]));
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [[]], Metrics: definitions }],
      },
      ...values,
    }),
  );
}
