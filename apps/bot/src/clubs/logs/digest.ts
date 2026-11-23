/** UTC boundaries for scheduled trophy-progression digests. Pure logic, no I/O. */

import type { ClubLogPeriod } from '../types';

export interface ClubLogDigestBoundary {
  readonly period: ClubLogPeriod;
  /** Stable idempotency key for one completed window. */
  readonly periodKey: string;
  /** First instant of the completed window (used as the season baseline). */
  readonly windowStart: Date;
  /** Last instant of the completed window; used as `now` when rendering. */
  readonly windowEnd: Date;
  /** Short human-readable label for the message header. */
  readonly label: string;
}

export interface ClubLogDigestConfig {
  readonly seasonStartIso?: string | undefined;
  readonly seasonEndIso?: string | undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseIso(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function shiftDays(date: Date, days: number): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days),
  );
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatDay(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function formatRange(start: Date, end: Date): string {
  const last = formatDay(end);
  if (dateKey(start) === dateKey(end)) return `${last}, ${end.getUTCFullYear()}`;
  return `${formatDay(start)} – ${last}, ${end.getUTCFullYear()}`;
}

/**
 * Digests due at this instant. Daily is always due (for the day that just
 * ended); weekly is due only on Monday; season is due only at the first UTC
 * midnight on or after the configured season reset. Because the delivery
 * ledger is keyed by period/window, rechecking on every poll is safe.
 */
export function dueClubLogDigests(now: Date, config: ClubLogDigestConfig): ClubLogDigestBoundary[] {
  const midnight = utcMidnight(now);
  const windowEnd = new Date(midnight.getTime() - 1);
  const completedDay = shiftDays(midnight, -1);
  const boundaries: ClubLogDigestBoundary[] = [
    {
      period: 'today',
      periodKey: dateKey(completedDay),
      windowStart: completedDay,
      windowEnd,
      label: formatDay(completedDay),
    },
  ];

  if (now.getUTCDay() === 1) {
    const completedWeekStart = shiftDays(midnight, -7);
    boundaries.push({
      period: 'week',
      periodKey: dateKey(completedWeekStart),
      windowStart: completedWeekStart,
      windowEnd,
      label: formatRange(completedWeekStart, completedDay),
    });
  }

  const seasonStart = parseIso(config.seasonStartIso);
  const configuredSeasonEnd = parseIso(config.seasonEndIso);
  if (
    seasonStart !== null &&
    configuredSeasonEnd !== null &&
    configuredSeasonEnd > seasonStart
  ) {
    const seasonLength = configuredSeasonEnd - seasonStart;
    let seasonEndMs = configuredSeasonEnd;
    while (seasonEndMs + seasonLength <= now.getTime()) seasonEndMs += seasonLength;

    if (seasonEndMs <= now.getTime()) {
      const seasonEnd = new Date(seasonEndMs);
      const midnightOfEnd = utcMidnight(seasonEnd);
      const firstPostMidnight =
        midnightOfEnd.getTime() >= seasonEndMs ? midnightOfEnd : shiftDays(midnightOfEnd, 1);
      if (midnight.getTime() >= firstPostMidnight.getTime()) {
        boundaries.push({
          period: 'season',
          periodKey: dateKey(seasonEnd),
          windowStart: new Date(seasonEndMs - seasonLength),
          windowEnd: new Date(seasonEndMs - 1),
          label: formatRange(new Date(seasonEndMs - seasonLength), new Date(seasonEndMs - 1)),
        });
      }
    }
  }

  return boundaries;
}
