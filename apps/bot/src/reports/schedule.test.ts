import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runScheduledReports: vi.fn(async (_now: Date, _types?: readonly string[]) => ({
    failedTypes: [] as string[],
    skippedTypes: [] as string[],
    claimedTypes: [] as string[],
  })),
  readMissingReportDeliveries: vi.fn(async (_now: Date) => ({
    periods: [] as Array<{ type: 'daily' | 'weekly' | 'monthly'; periodKey: string }>,
    inactivityPeriodKey: null as string | null,
  })),
  postInactivityReports: vi.fn(async (_now: Date, _rest?: unknown, _token?: string | undefined) => ({
    posted: 0,
    failed: 0,
  })),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./service', () => ({
  runScheduledReports: mocks.runScheduledReports,
  readMissingReportDeliveries: mocks.readMissingReportDeliveries,
}));
vi.mock('./inactivity', () => ({ postInactivityReports: mocks.postInactivityReports }));
vi.mock('@brawlhub/logging', () => ({
  createLogger: () => mocks.logger,
}));

import { startReportsSchedule } from './schedule';

type ReportType = 'daily' | 'weekly' | 'monthly';

function missing(types: readonly ReportType[], inactivityPeriodKey: string | null = null) {
  return {
    periods: types.map((type) => ({ type, periodKey: `${type}-period` })),
    inactivityPeriodKey,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env.REPORTS_IMMEDIATE_ON_START;
  delete process.env.DISCORD_TOKEN;
  mocks.runScheduledReports.mockReset();
  mocks.runScheduledReports.mockResolvedValue({
    failedTypes: [],
    skippedTypes: [],
    claimedTypes: [],
  });
  mocks.readMissingReportDeliveries.mockReset();
  mocks.readMissingReportDeliveries.mockResolvedValue(missing([]));
  mocks.postInactivityReports.mockReset();
  mocks.postInactivityReports.mockResolvedValue({ posted: 0, failed: 0 });
  mocks.logger.info.mockReset();
  mocks.logger.warn.mockReset();
  mocks.logger.error.mockReset();
  mocks.logger.debug.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.REPORTS_IMMEDIATE_ON_START;
  delete process.env.DISCORD_TOKEN;
});

async function tickAt(instant: string): Promise<void> {
  vi.setSystemTime(new Date(instant));
  vi.advanceTimersByTime(60_000);
  await flush();
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('startReportsSchedule', () => {
  it('posts only the daily report when that is the missing completed period', async () => {
    mocks.readMissingReportDeliveries.mockResolvedValue(missing(['daily']));
    const stop = startReportsSchedule();
    await tickAt('2026-11-19T12:00:00Z');

    expect(mocks.runScheduledReports).toHaveBeenCalledTimes(1);
    expect(mocks.runScheduledReports).toHaveBeenCalledWith(expect.any(Date), ['daily']);
    stop();
  });

  it('includes the weekly report when that completed period is missing', async () => {
    mocks.readMissingReportDeliveries.mockResolvedValue(missing(['daily', 'weekly']));
    const stop = startReportsSchedule();
    await tickAt('2026-11-23T00:00:05Z');

    expect(mocks.runScheduledReports).toHaveBeenCalledWith(expect.any(Date), [
      'daily',
      'weekly',
    ]);
    stop();
  });

  it('includes the monthly report when that completed period is missing', async () => {
    mocks.readMissingReportDeliveries.mockResolvedValue(missing(['daily', 'monthly']));
    const stop = startReportsSchedule();
    await tickAt('2026-12-01T00:00:05Z');

    expect(mocks.runScheduledReports).toHaveBeenCalledWith(expect.any(Date), [
      'daily',
      'monthly',
    ]);
    stop();
  });

  it('checks durable state every minute, not only in a five-minute boundary window', async () => {
    mocks.readMissingReportDeliveries.mockResolvedValue(missing(['daily']));
    const stop = startReportsSchedule();
    await tickAt('2026-11-19T12:00:00Z');
    await tickAt('2026-11-19T12:01:00Z');
    await tickAt('2026-11-19T12:02:00Z');

    expect(mocks.readMissingReportDeliveries).toHaveBeenCalledTimes(3);
    expect(mocks.runScheduledReports).toHaveBeenCalledTimes(3);
    stop();
  });

  it('does not repost a period once the durable ledger says it was delivered', async () => {
    mocks.readMissingReportDeliveries
      .mockResolvedValueOnce(missing(['daily']))
      .mockResolvedValue(missing([]));
    const stop = startReportsSchedule();
    await tickAt('2026-11-19T00:01:00Z');
    await tickAt('2026-11-19T00:02:00Z');
    await tickAt('2026-11-19T00:03:00Z');

    expect(mocks.runScheduledReports).toHaveBeenCalledTimes(1);
    stop();
  });

  it('retries a failed report type while its ledger key is still missing', async () => {
    mocks.runScheduledReports
      .mockResolvedValueOnce({
        failedTypes: ['daily'],
        skippedTypes: [],
        claimedTypes: [],
      })
      .mockResolvedValue({ failedTypes: [], skippedTypes: [], claimedTypes: [] });
    mocks.readMissingReportDeliveries.mockResolvedValue(missing(['daily']));
    const stop = startReportsSchedule();

    await tickAt('2026-11-19T00:00:05Z');
    await tickAt('2026-11-19T00:01:00Z');
    await tickAt('2026-11-19T00:02:00Z');

    expect(mocks.runScheduledReports).toHaveBeenCalledTimes(3);
    stop();
  });

  it('retries when the report runner throws', async () => {
    mocks.runScheduledReports
      .mockRejectedValueOnce(new Error('runner down'))
      .mockResolvedValue({ failedTypes: [], skippedTypes: [], claimedTypes: [] });
    mocks.readMissingReportDeliveries.mockResolvedValue(missing(['daily']));
    const stop = startReportsSchedule();

    await tickAt('2026-11-19T00:00:05Z');
    await tickAt('2026-11-19T00:01:00Z');

    expect(mocks.runScheduledReports).toHaveBeenCalledTimes(2);
    stop();
  });

  it('only retries types whose ledger keys are still missing', async () => {
    mocks.runScheduledReports.mockResolvedValue({
      failedTypes: ['weekly'],
      skippedTypes: [],
      claimedTypes: [],
    });
    mocks.readMissingReportDeliveries
      .mockResolvedValueOnce(missing(['daily', 'weekly']))
      .mockResolvedValue(missing(['weekly']));
    const stop = startReportsSchedule();

    await tickAt('2026-11-23T00:00:05Z');
    await tickAt('2026-11-23T00:01:00Z');

    expect(mocks.runScheduledReports.mock.calls[1]?.[1]).toEqual(['weekly']);
    stop();
  });

  it('does not let inFlight block a retry after a completed run', async () => {
    mocks.runScheduledReports.mockResolvedValue({
      failedTypes: ['daily'],
      skippedTypes: [],
      claimedTypes: [],
    });
    mocks.readMissingReportDeliveries.mockResolvedValue(missing(['daily']));
    const stop = startReportsSchedule();

    await tickAt('2026-11-19T00:00:05Z');
    await tickAt('2026-11-19T00:01:00Z');

    expect(mocks.runScheduledReports).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('inactivity report schedule', () => {
  it('posts once when the inactivity ledger has no durable row for the day', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    mocks.readMissingReportDeliveries
      .mockResolvedValueOnce(missing([], '2026-11-19'))
      .mockResolvedValue(missing([]));
    const stop = startReportsSchedule();
    await tickAt('2026-11-19T00:00:05Z');

    expect(mocks.postInactivityReports).toHaveBeenCalledOnce();
    expect(mocks.postInactivityReports.mock.calls[0]?.[0]).toEqual(expect.any(Date));
    stop();
  });

  it('does not repost the inactivity digest once the ledger has the day', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    mocks.readMissingReportDeliveries
      .mockResolvedValueOnce(missing([], '2026-11-19'))
      .mockResolvedValue(missing([]));
    const stop = startReportsSchedule();
    await tickAt('2026-11-19T00:00:05Z');
    await tickAt('2026-11-19T00:01:00Z');
    await tickAt('2026-11-19T00:02:00Z');

    expect(mocks.postInactivityReports).toHaveBeenCalledOnce();
    stop();
  });

  it('never posts the inactivity digest on startup, even if immediate reports are enabled', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.REPORTS_IMMEDIATE_ON_START = '1';
    const stop = startReportsSchedule();
    vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
    vi.advanceTimersByTime(31_000);
    await flush();

    expect(mocks.runScheduledReports).toHaveBeenCalledOnce();
    expect(mocks.postInactivityReports).not.toHaveBeenCalled();
    stop();
  });

  it('retries the inactivity digest after a failed guild post', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    mocks.postInactivityReports
      .mockResolvedValueOnce({ posted: 0, failed: 1 })
      .mockResolvedValue({ posted: 1, failed: 0 });
    mocks.readMissingReportDeliveries.mockResolvedValue(missing([], '2026-11-19'));
    const stop = startReportsSchedule();

    await tickAt('2026-11-19T00:00:05Z');
    await tickAt('2026-11-19T00:01:00Z');
    await tickAt('2026-11-19T00:02:00Z');

    expect(mocks.postInactivityReports).toHaveBeenCalledTimes(3);
    stop();
  });

  it('skips the inactivity digest when no Discord token is configured', async () => {
    mocks.readMissingReportDeliveries.mockResolvedValue(missing([], '2026-11-19'));
    const stop = startReportsSchedule();
    await tickAt('2026-11-19T00:00:05Z');

    expect(mocks.postInactivityReports).not.toHaveBeenCalled();
    stop();
  });
});
