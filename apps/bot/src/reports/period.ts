/** Fixed UTC reporting boundaries: reports always describe the period before the boundary. */
export type ReportType = 'daily' | 'weekly' | 'monthly';

export const REPORT_TYPES: readonly ReportType[] = ['daily', 'weekly', 'monthly'] as const;

export interface ReportPeriod {
  readonly type: ReportType;
  readonly periodKey: string;
  readonly start: Date;
  readonly end: Date;
}

export interface ReportChannelSettings {
  readonly overviewChannelId: string | null;
  readonly reportDailyChannelId: string | null;
  readonly reportWeeklyChannelId: string | null;
  readonly reportMonthlyChannelId: string | null;
}

const DAY_MS = 86_400_000;

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** ISO 8601 week-year and week number (Monday-based, week 1 contains the first Thursday). */
function isoWeek(date: Date): { readonly year: number; readonly week: number } {
  const thursday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - day);
  const year = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((thursday.getTime() - yearStart.getTime()) / DAY_MS) + 1) / 7);
  return { year, week };
}

/**
 * Resolve the report that a scheduled boundary post should describe.
 *
 * The daily report covers the previous UTC day. Weekly and monthly reports are
 * derived from that same completed day, so a Monday 00:00 run describes the
 * week that just ended and a 1st 00:00 run describes the month that just ended.
 */
export function currentReportPeriod(now: Date, type: ReportType): ReportPeriod {
  const previousDayEnd = utcMidnight(now);
  const previousDayStart = new Date(previousDayEnd.getTime() - DAY_MS);

  if (type === 'daily') {
    return {
      type,
      periodKey: previousDayStart.toISOString().slice(0, 10),
      start: previousDayStart,
      end: previousDayEnd,
    };
  }

  if (type === 'weekly') {
    const isoDay = previousDayStart.getUTCDay() || 7;
    const start = new Date(previousDayStart.getTime() - (isoDay - 1) * DAY_MS);
    const end = new Date(start.getTime() + 7 * DAY_MS);
    const { year, week } = isoWeek(previousDayStart);
    return {
      type,
      periodKey: `${year}-W${String(week).padStart(2, '0')}`,
      start,
      end,
    };
  }

  const start = new Date(
    Date.UTC(previousDayStart.getUTCFullYear(), previousDayStart.getUTCMonth(), 1),
  );
  const end = new Date(
    Date.UTC(previousDayStart.getUTCFullYear(), previousDayStart.getUTCMonth() + 1, 1),
  );
  return {
    type,
    periodKey: start.toISOString().slice(0, 7),
    start,
    end,
  };
}

function usableChannel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Per-report channel override with a fallback to the guild overview channel. */
export function reportChannelFor(settings: ReportChannelSettings, type: ReportType): string | null {
  const override =
    type === 'daily'
      ? settings.reportDailyChannelId
      : type === 'weekly'
        ? settings.reportWeeklyChannelId
        : settings.reportMonthlyChannelId;
  return usableChannel(override) ?? usableChannel(settings.overviewChannelId);
}
