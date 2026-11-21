import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runScheduledReports: vi.fn(async (_now: Date, _types?: readonly string[]) => undefined),
  postInactivityReports: vi.fn(
    async (_now: Date, _rest?: unknown, _token?: string | undefined) => 0,
  ),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./service', () => ({ runScheduledReports: mocks.runScheduledReports }));
vi.mock('./inactivity', () => ({ postInactivityReports: mocks.postInactivityReports }));
vi.mock('@brawlhub/logging', () => ({
  createLogger: () => mocks.logger,
}));

import { startReportsSchedule } from './schedule';

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env.REPORTS_IMMEDIATE_ON_START;
  delete process.env.DISCORD_TOKEN;
  mocks.runScheduledReports.mockReset();
  mocks.postInactivityReports.mockReset();
  mocks.logger.info.mockReset();
  mocks.logger.warn.mockReset();
  mocks.logger.error.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.REPORTS_IMMEDIATE_ON_START;
  delete process.env.DISCORD_TOKEN;
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

describe('inactivity report schedule', () => {
  it('posts once at the UTC boundary when a token is configured', () => {
    process.env.DISCORD_TOKEN = 'test-token';
    const stop = startReportsSchedule();
    tickAt('2026-11-19T00:00:05Z');

    expect(mocks.postInactivityReports).toHaveBeenCalledOnce();
    expect(mocks.postInactivityReports.mock.calls[0]?.[0]).toEqual(expect.any(Date));
    stop();
  });

  it('does not repost the inactivity digest on repeated ticks in the same day', () => {
    process.env.DISCORD_TOKEN = 'test-token';
    const stop = startReportsSchedule();
    tickAt('2026-11-19T00:00:05Z');
    tickAt('2026-11-19T00:01:00Z');
    tickAt('2026-11-19T00:02:00Z');

    expect(mocks.postInactivityReports).toHaveBeenCalledOnce();
    stop();
  });

  it('never posts the inactivity digest on startup, even if immediate reports are enabled', () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.REPORTS_IMMEDIATE_ON_START = '1';
    const stop = startReportsSchedule();
    vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
    vi.advanceTimersByTime(31_000);

    expect(mocks.runScheduledReports).toHaveBeenCalledOnce();
    expect(mocks.postInactivityReports).not.toHaveBeenCalled();
    stop();
  });

  it('skips the inactivity digest when no Discord token is configured', () => {
    const stop = startReportsSchedule();
    tickAt('2026-11-19T00:00:05Z');

    expect(mocks.postInactivityReports).not.toHaveBeenCalled();
    stop();
  });
});
