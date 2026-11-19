import type {
  ClubSnapshot,
  HistoryChange,
  HistoryPeriod,
  HistoryPoint,
  LeaderboardEntry,
  MatchActivity,
  MegaPigEstimate,
  MemberDetail,
  RosterMember,
  TrophyProgression,
} from './types';

export type { TrophyProgression } from './types';

export interface TrophyRange {
  readonly low: number;
  readonly high: number;
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

/** Sort roster members by stored trophies, placing incomplete rows last. */
export function sortMembersByTrophies(
  members: readonly MemberDetail[],
): MemberDetail[] {
  return [...members].sort((a, b) => {
    const aTrophies = finiteNumber(a.trophies);
    const bTrophies = finiteNumber(b.trophies);
    if (aTrophies !== null && bTrophies !== null && aTrophies !== bTrophies) {
      return bTrophies - aTrophies;
    }
    if (aTrophies !== null && bTrophies === null) return -1;
    if (aTrophies === null && bTrophies !== null) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Rank members by current trophies. Members without a valid trophy value are
 * omitted rather than given a fabricated position; equal values share a rank.
 */
export function rankByTrophies(members: readonly MemberDetail[]): LeaderboardEntry[] {
  const ranked = members
    .map((member) => ({ member, trophies: finiteNumber(member.trophies) }))
    .filter((entry): entry is { member: MemberDetail; trophies: number } => entry.trophies !== null)
    .sort((a, b) => b.trophies - a.trophies || a.member.name.localeCompare(b.member.name));

  let currentRank = 0;
  let previousTrophies: number | null = null;

  return ranked.map((entry, index) => {
    if (previousTrophies === null || entry.trophies !== previousTrophies) {
      currentRank = index + 1;
      previousTrophies = entry.trophies;
    }
    return { ...entry.member, rank: currentRank, progression: null };
  });
}

export const HISTORY_PERIOD_DAYS: Readonly<Record<HistoryPeriod, number | null>> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: null,
};

/** Filter stored snapshots to a bounded period without creating missing points. */
export function filterSnapshotsByPeriod(
  snapshots: readonly ClubSnapshot[],
  period: HistoryPeriod,
  now: Date,
): ClubSnapshot[] {
  const days = HISTORY_PERIOD_DAYS[period];
  const sinceMs = days === null ? null : now.getTime() - days * DAY_MS;
  return snapshots
    .filter((snapshot) => {
      const capturedMs = Date.parse(snapshot.capturedAt);
      if (Number.isNaN(capturedMs)) return false;
      return sinceMs === null || capturedMs >= sinceMs;
    })
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
}

function difference(later: number | null, earlier: number | null): number | null {
  const laterValue = finiteNumber(later);
  const earlierValue = finiteNumber(earlier);
  return laterValue === null || earlierValue === null ? null : laterValue - earlierValue;
}

/** Change between the first and last stored history points in a period. */
export function calculateHistoryChange(
  points: readonly HistoryPoint[],
): HistoryChange | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return null;

  return {
    trophies: difference(last.trophies, first.trophies),
    averageTrophies: difference(last.averageTrophies, first.averageTrophies),
    memberCount: difference(last.memberCount, first.memberCount),
  };
}

function averageRounded(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function calculateAverageMatches(input: {
  readonly countsByPlayer: ReadonlyMap<string, { today: number; week: number; season: number }>;
  readonly memberPlayerIds: readonly string[];
  readonly lastBattleAt: string | null;
}): MatchActivity | null {
  if (input.memberPlayerIds.length === 0) return null;
  const today: number[] = [];
  const week: number[] = [];
  const season: number[] = [];
  for (const playerId of input.memberPlayerIds) {
    const counts = input.countsByPlayer.get(playerId) ?? { today: 0, week: 0, season: 0 };
    today.push(counts.today);
    week.push(counts.week);
    season.push(counts.season);
  }
  return {
    today: averageRounded(today),
    week: averageRounded(week),
    season: averageRounded(season),
    sampleSize: input.memberPlayerIds.length,
    lastBattleAt: input.lastBattleAt,
  };
}

export function calculateMegaPigEstimate(input: {
  readonly rows: readonly { matches: number; wins: number; trophyChange: number }[];
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
}): MegaPigEstimate | null {
  if (input.windowStart === null || input.windowEnd === null) return null;
  if (input.rows.length === 0) {
    return {
      matches: 0,
      wins: 0,
      trophyChange: 0,
      sampleSize: 0,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
    };
  }
  return {
    matches: input.rows.reduce((sum, row) => sum + row.matches, 0),
    wins: input.rows.reduce((sum, row) => sum + row.wins, 0),
    trophyChange: input.rows.reduce((sum, row) => sum + row.trophyChange, 0),
    sampleSize: input.rows.length,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
  };
}
