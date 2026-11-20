import { describe, expect, it } from 'vitest';
import { currentReportPeriod, reportChannelFor } from './period';

describe('currentReportPeriod', () => {
  it('describes the previous UTC day for daily reports', () => {
    expect(currentReportPeriod(new Date('2026-11-20T00:00:05Z'), 'daily')).toEqual({
      type: 'daily',
      periodKey: '2026-11-19',
      start: new Date('2026-11-19T00:00:00.000Z'),
      end: new Date('2026-11-20T00:00:00.000Z'),
    });
  });

  it('describes the Monday-based week containing the previous day', () => {
    expect(currentReportPeriod(new Date('2026-11-20T00:00:05Z'), 'weekly')).toEqual({
      type: 'weekly',
      periodKey: '2026-W47',
      start: new Date('2026-11-16T00:00:00.000Z'),
      end: new Date('2026-11-23T00:00:00.000Z'),
    });
  });

  it('describes the month containing the previous day', () => {
    expect(currentReportPeriod(new Date('2026-11-20T00:00:05Z'), 'monthly')).toEqual({
      type: 'monthly',
      periodKey: '2026-11',
      start: new Date('2026-11-01T00:00:00.000Z'),
      end: new Date('2026-12-01T00:00:00.000Z'),
    });
  });

  it('reports the just-ended periods at the Monday 00:00 boundary', () => {
    const now = new Date('2026-11-16T00:00:01Z');
    expect(currentReportPeriod(now, 'daily').periodKey).toBe('2026-11-15');
    expect(currentReportPeriod(now, 'weekly')).toEqual({
      type: 'weekly',
      periodKey: '2026-W46',
      start: new Date('2026-11-09T00:00:00.000Z'),
      end: new Date('2026-11-16T00:00:00.000Z'),
    });
  });

  it('reports the just-ended month at the 1st 00:00 boundary', () => {
    expect(currentReportPeriod(new Date('2026-12-01T00:00:01Z'), 'monthly')).toEqual({
      type: 'monthly',
      periodKey: '2026-11',
      start: new Date('2026-11-01T00:00:00.000Z'),
      end: new Date('2026-12-01T00:00:00.000Z'),
    });
  });

  it('handles calendar and ISO week year rollover', () => {
    const now = new Date('2026-01-01T00:00:01Z');
    expect(currentReportPeriod(now, 'daily').periodKey).toBe('2025-12-31');
    expect(currentReportPeriod(now, 'weekly')).toEqual({
      type: 'weekly',
      periodKey: '2026-W01',
      start: new Date('2025-12-29T00:00:00.000Z'),
      end: new Date('2026-01-05T00:00:00.000Z'),
    });
    expect(currentReportPeriod(now, 'monthly').periodKey).toBe('2025-12');
  });

  it('handles a 53-week ISO year', () => {
    expect(currentReportPeriod(new Date('2027-01-01T00:00:01Z'), 'weekly')).toEqual({
      type: 'weekly',
      periodKey: '2026-W53',
      start: new Date('2026-12-28T00:00:00.000Z'),
      end: new Date('2027-01-04T00:00:00.000Z'),
    });
  });
});

describe('reportChannelFor', () => {
  const settings = {
    overviewChannelId: '111111111111111111',
    reportDailyChannelId: '222222222222222222',
    reportWeeklyChannelId: null,
    reportMonthlyChannelId: '   ',
  } as const;

  it('uses a configured override for its own report type', () => {
    expect(reportChannelFor(settings, 'daily')).toBe('222222222222222222');
  });

  it('falls back to the overview channel when the override is missing or blank', () => {
    expect(reportChannelFor(settings, 'weekly')).toBe('111111111111111111');
    expect(reportChannelFor(settings, 'monthly')).toBe('111111111111111111');
  });

  it('returns null when neither an override nor an overview channel exists', () => {
    expect(
      reportChannelFor(
        {
          overviewChannelId: null,
          reportDailyChannelId: null,
          reportWeeklyChannelId: null,
          reportMonthlyChannelId: null,
        },
        'daily',
      ),
    ).toBeNull();
  });
});
