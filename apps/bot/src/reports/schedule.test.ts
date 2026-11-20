import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runScheduledReports: vi.fn(async () => undefined),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./service', () => ({ runScheduledReports: mocks.runScheduledReports }));
vi.mock('@brawlhub/logging', () => ({
  createLogger: () => mocks.logger,
}));

import { startReportsSchedule } from './schedule';

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env.REPORTS_IMMEDIATE_ON_START;
  mocks.runScheduledReports.mockReset();
  mocks.logger.info.mockReset();
  mocks.logger.warn.mockReset();
  mocks.logger.error.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.REPORTS_IMMEDIATE_ON_START;
});

function tickAt(instant: string): void {
  vi.setSystemTime(new Date(instant));
  vi.advanceTimersByTime(60_000);
}

describe('startReportsSchedule', () => {
  it('posts only the daily report on an ordinary boundary', () => {
    const stop = startReportsSchedule();
    tickAt('2026-11-19T00:00:05Z');

    expect(mocks.runScheduledReports).toHaveBeenCalledTimes(1);
    expect(mocks.runScheduledReports).toHaveBeenCalledWith(expect.any(Date), ['daily']);
    stop();
  });

  it('includes the weekly report on the Monday boundary', () => {
    const stop = startReportsSchedule();
    tickAt('2026-11-23T00:00:05Z');

    expect(mocks.runScheduledReports).toHaveBeenCalledWith(expect.any(Date), [
      'daily',
      'weekly',
    ]);
    stop();
  });

  it('includes the monthly report on the first-of-month boundary', () => {
    const stop = startReportsSchedule();
    tickAt('2026-12-01T00:00:05Z');

    expect(mocks.runScheduledReports).toHaveBeenCalledWith(expect.any(Date), [
      'daily',
      'monthly',
    ]);
    stop();
  });

  it('does not repost the same period on repeated ticks in the boundary window', () => {
    const stop = startReportsSchedule();
    tickAt('2026-11-19T00:01:00Z');
    tickAt('2026-11-19T00:02:00Z');
    tickAt('2026-11-19T00:03:00Z');

    expect(mocks.runScheduledReports).toHaveBeenCalledTimes(1);
    stop();
  });

  it('ignores non-boundary times', () => {
    const stop = startReportsSchedule();
    tickAt('2026-11-19T12:00:00Z');

    expect(mocks.runScheduledReports).not.toHaveBeenCalled();
    stop();
  });
});
