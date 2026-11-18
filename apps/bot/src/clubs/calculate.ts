import type { ClubSnapshot, RosterMember } from './types';

export interface TrophyRange {
  readonly low: number;
  readonly high: number;
}

export interface TrophyProgression {
  readonly today: number | null;
  readonly week: number | null;
  readonly season: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Rounded mean of the supplied values. Values that are not finite are ignored. */
export function calculateAverage(values: readonly (number | null | undefined)[]): number | null {
  const numbers = values
    .map((value) => finiteNumber(value))
    .filter((value): value is number => value !== null);
  if (numbers.length === 0) return null;
  return Math.round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

/** Lowest and highest valid member trophy counts, or null for an empty roster. */
export function calculateTrophyRange(roster: readonly RosterMember[]): TrophyRange | null {
  const values = roster
    .map((member) => finiteNumber(member.trophies))
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return { low: Math.min(...values), high: Math.max(...values) };
}

function utcMidnight(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Monday 00:00 UTC for the supplied date. */
function utcWeekStart(date: Date): number {
  const midnight = utcMidnight(date);
  const mondayOffset = (new Date(midnight).getUTCDay() + 6) % 7;
  return midnight - mondayOffset * DAY_MS;
}

function seasonStartMs(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function baselineTrophies(
  snapshots: readonly ClubSnapshot[],
  boundaryMs: number,
): number | null {
  let baseline: number | null = null;
  for (const snapshot of snapshots) {
    const capturedMs = Date.parse(snapshot.capturedAt);
    if (Number.isNaN(capturedMs) || capturedMs > boundaryMs) continue;
    const trophies = finiteNumber(snapshot.trophies);
    if (trophies !== null) baseline = trophies;
  }
  return baseline;
}

function deltaFrom(
  snapshots: readonly ClubSnapshot[],
  boundaryMs: number | null,
  currentTrophies: number | null,
  currentAtMs: number,
): number | null {
  if (boundaryMs === null || currentTrophies === null || currentAtMs < boundaryMs) return null;
  const baseline = baselineTrophies(snapshots, boundaryMs);
  return baseline === null ? null : currentTrophies - baseline;
}

/**
 * Calculate snapshot-backed trophy deltas. A value is returned only when there is
 * a snapshot at or before the window boundary and a current value inside the window.
 * Season requires an explicit, valid `BRAWL_SEASON_START_ISO` value.
 */
export function calculateTrophyProgression(input: {
  readonly snapshots: readonly ClubSnapshot[];
  readonly currentTrophies: number | null;
  readonly currentAt: string;
  readonly now: Date;
  readonly seasonStartIso?: string | undefined;
}): TrophyProgression {
  const ordered = [...input.snapshots].sort(
    (a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt),
  );
  const currentAtMs = Date.parse(input.currentAt);
  if (Number.isNaN(currentAtMs)) {
    return { today: null, week: null, season: null };
  }

  return {
    today: deltaFrom(ordered, utcMidnight(input.now), input.currentTrophies, currentAtMs),
    week: deltaFrom(ordered, utcWeekStart(input.now), input.currentTrophies, currentAtMs),
    season: deltaFrom(
      ordered,
      seasonStartMs(input.seasonStartIso),
      input.currentTrophies,
      currentAtMs,
    ),
  };
}

/** Count a Brawl Stars club role only when at least one role is present. */
export function countRole(
  roster: readonly RosterMember[],
  role: string,
): number | null {
  const rolesAvailable = roster.some((member) => member.role !== null && member.role !== '');
  if (!rolesAvailable) return null;
  return roster.filter((member) => member.role === role).length;
}
