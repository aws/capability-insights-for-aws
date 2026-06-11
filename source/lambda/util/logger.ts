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
