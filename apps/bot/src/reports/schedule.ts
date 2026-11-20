import { createLogger } from '@brawlhub/logging';
import { currentReportPeriod, REPORT_TYPES, type ReportType } from './period';
import { runScheduledReports } from './service';

const logger = createLogger('bot');
const TICK_MS = 60_000;
const BOUNDARY_WINDOW_MINUTES = 5;
const IMMEDIATE_DELAY_MS = 30_000;
const REDACTED = '[REDACTED]';

function safeScheduleError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const configuredToken = process.env.DISCORD_TOKEN?.trim();
  const withoutConfiguredToken =
    configuredToken !== undefined && configuredToken !== '' && message.includes(configuredToken)
      ? message.split(configuredToken).join(REDACTED)
      : message;
  return withoutConfiguredToken.replace(
    /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g,
    REDACTED,
  );
}

function runSafely(reason: string, types: readonly ReportType[]): void {
  void runScheduledReports(new Date(), types).catch((error: unknown) => {
    logger.warn('Scheduled reports tick failed', {
      reason,
      error: safeScheduleError(error),
    });
  });
}

/** Start the in-process UTC report schedule; returns a stop function for shutdown. */
export function startReportsSchedule(): () => void {
  const lastRun = new Map<ReportType, string>();

  const tick = (): void => {
    const now = new Date();
    if (now.getUTCHours() !== 0 || now.getUTCMinutes() >= BOUNDARY_WINDOW_MINUTES) return;

    const due: ReportType[] = ['daily'];
    if (now.getUTCDay() === 1) due.push('weekly');
    if (now.getUTCDate() === 1) due.push('monthly');

    const changedTypes = due.filter((type) => {
      const periodKey = currentReportPeriod(now, type).periodKey;
      if (lastRun.get(type) === periodKey) return false;
      lastRun.set(type, periodKey);
      return true;
    });
    if (changedTypes.length > 0) runSafely('UTC boundary', changedTypes);
  };

  const intervalTimer = setInterval(tick, TICK_MS);
  let immediateTimer: ReturnType<typeof setTimeout> | undefined;
  if (process.env.REPORTS_IMMEDIATE_ON_START === '1') {
    immediateTimer = setTimeout(() => runSafely('startup', REPORT_TYPES), IMMEDIATE_DELAY_MS);
  }

  logger.info('Scheduled reports enabled', {
    tickMs: TICK_MS,
    boundaryWindowMinutes: BOUNDARY_WINDOW_MINUTES,
    immediateOnStart: process.env.REPORTS_IMMEDIATE_ON_START === '1',
  });

  return () => {
    clearInterval(intervalTimer);
    if (immediateTimer !== undefined) clearTimeout(immediateTimer);
  };
}
