import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './index';

type JsonLine = {
  level: string;
  name: string;
  message: string;
  meta?: Record<string, unknown>;
};

function parseLine(value: unknown): JsonLine {
  return JSON.parse(String(value)) as JsonLine;
}

describe('createLogger', () => {
  const originalLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLevel;
    }
  });

  it('emits JSON lines and redacts sensitive metadata keys', () => {
    process.env.LOG_LEVEL = 'info';
    const logger = createLogger('test');

    logger.info('hello', {
      apiKey: 'should-not-leak',
      authorization: 'Bearer should-not-leak',
      nested: { clientSecret: 'also-hidden', safe: 42 },
    });

    const spy = vi.mocked(console.log);
    expect(spy).toHaveBeenCalledTimes(1);
    const entry = parseLine(spy.mock.calls[0]?.[0]);
    expect(entry.level).toBe('info');
    expect(entry.name).toBe('test');
    expect(entry.message).toBe('hello');
    expect(entry.meta?.apiKey).toBe('[REDACTED]');
    expect(entry.meta?.authorization).toBe('[REDACTED]');
    const nested = entry.meta?.nested as Record<string, unknown> | undefined;
    expect(nested?.clientSecret).toBe('[REDACTED]');
    expect(nested?.safe).toBe(42);
  });

  it('filters messages below the configured level', () => {
    process.env.LOG_LEVEL = 'warn';
    const logger = createLogger('test');

    logger.debug('debug message');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');

    const spy = vi.mocked(console.log);
    expect(spy).toHaveBeenCalledTimes(2);
    const levels = spy.mock.calls.map((call) => parseLine(call[0]).level);
    expect(levels).toEqual(['warn', 'error']);
  });

  it('defaults to info for an invalid LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'not-a-level';
    const logger = createLogger('test');

    logger.debug('hidden');
    logger.info('shown');

    const spy = vi.mocked(console.log);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(parseLine(spy.mock.calls[0]?.[0]).level).toBe('info');
  });
});
