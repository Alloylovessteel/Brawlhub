export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /token|secret|key|authorization/i;

function parseLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'debug' ||
    normalized === 'info' ||
    normalized === 'warn' ||
    normalized === 'error'
  ) {
    return normalized;
  }
  return 'info';
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const result: unknown[] = value.map((item) => redact(item, seen));
    seen.delete(value);
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(entry, seen);
  }
  seen.delete(value);
  return result;
}

/**
 * Creates a minimal structured logger that writes one JSON object per line.
 * Log level is read from LOG_LEVEL at creation time; invalid values fall back to `info`.
 */
export function createLogger(name: string): Logger {
  const threshold = LEVEL_RANK[parseLevel(process.env.LOG_LEVEL)];

  const emit = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (LEVEL_RANK[level] < threshold) {
      return;
    }

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      name,
      message,
    };
    if (meta !== undefined) {
      entry.meta = redact(meta, new WeakSet<object>());
    }
    console.log(JSON.stringify(entry));
  };

  return {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
  };
}
