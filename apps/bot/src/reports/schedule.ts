import { createLogger } from '@brawlhub/logging';
import { REST } from 'discord.js';
import { getBotConfig } from '../config.js';
import { postInactivityReports } from './inactivity.js';
import { currentReportPeriod, REPORT_TYPES, type ReportType } from './period';
import { runScheduledReports, type ScheduledReportRunResult } from './service';

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

/** Auto-post the inactivity digest only at the UTC boundary; never on startup. */
function runInactivitySafely(now: Date, onComplete: (succeeded: boolean) => void): void {
  const token = getBotConfig().token;
  if (token === undefined) return;
  const rest = new REST({ version: '10' }).setToken(token);
  void postInactivityReports(now, rest, token).then(
    (result) => {
      if (result.posted > 0) {
        logger.info('Inactivity reports posted', { posted: result.posted, failed: result.failed });
      }
      onComplete(result.failed === 0);
    },
    (error: unknown) => {
      logger.warn('Inactivity report tick failed', { error: safeScheduleError(error) });
      onComplete(false);
    },
  );
}

/** Start the in-process UTC report schedule; returns a stop function for shutdown. */
export function startReportsSchedule(): () => void {
  const lastRun = new Map<ReportType, string>();
  const inFlight = new Set<ReportType>();
  let lastInactivityKey: string | null = null;
  let inactivityInFlight = false;

  const launchReports = (
    now: Date,
    types: readonly ReportType[],
    reason: string,
    markComplete: boolean,
  ): void => {
    if (types.length === 0) return;
    for (const type of types) inFlight.add(type);
    void runScheduledReports(now, types).then(
      (result: ScheduledReportRunResult | undefined) => {
        if (!markComplete) return;
        const failed = new Set<ReportType>(result?.failedTypes ?? []);
        for (const type of types) {
          if (failed.has(type)) continue;
          lastRun.set(type, currentReportPeriod(now, type).periodKey);
        }
      },
      (error: unknown) => {
        logger.warn('Scheduled reports tick failed', {
          reason,
          error: safeScheduleError(error),
        });
      },
    ).finally(() => {
      for (const type of types) inFlight.delete(type);
    });
  };

  const tick = (): void => {
    const now = new Date();
    if (now.getUTCHours() !== 0 || now.getUTCMinutes() >= BOUNDARY_WINDOW_MINUTES) return;

    const inactivityKey = now.toISOString().slice(0, 10);
    if (
      getBotConfig().token !== undefined &&
      lastInactivityKey !== inactivityKey &&
      !inactivityInFlight
    ) {
      inactivityInFlight = true;
      runInactivitySafely(now, (succeeded) => {
        inactivityInFlight = false;
        // Advance the digest marker only once every configured guild succeeded.
        if (succeeded) lastInactivityKey = inactivityKey;
      });
    }

    const due: ReportType[] = ['daily'];
    if (now.getUTCDay() === 1) due.push('weekly');
    if (now.getUTCDate() === 1) due.push('monthly');

    const retryable = due.filter((type) => {
      const periodKey = currentReportPeriod(now, type).periodKey;
      return lastRun.get(type) !== periodKey && !inFlight.has(type);
    });
    if (retryable.length > 0) launchReports(now, retryable, 'UTC boundary', true);
  };

  const intervalTimer = setInterval(tick, TICK_MS);
  let immediateTimer: ReturnType<typeof setTimeout> | undefined;
  if (process.env.REPORTS_IMMEDIATE_ON_START === '1') {
    immediateTimer = setTimeout(() => {
      launchReports(new Date(), REPORT_TYPES, 'startup', false);
    }, IMMEDIATE_DELAY_MS);
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
