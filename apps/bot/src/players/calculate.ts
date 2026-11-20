/** Pure calculations shared by the Discord player commands. */

import {
  calculateTrophyProgression,
  filterSnapshotsByPeriod,
  HISTORY_PERIOD_DAYS,
} from '../clubs/calculate';
import type { ClubSnapshot, HistoryPeriod, TrophyProgression } from '../clubs/types';
import type {
  ClubMembershipStatus,
  PlayerBattleRecord,
  PlayerHistoryChange,
  PlayerHistoryPoint,
} from './types';

export { HISTORY_PERIOD_DAYS };

function parseTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function finiteNumber(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

/** Filter stored player snapshots without adding or interpolating points. */
export function filterPlayerSnapshots(
  snapshots: readonly ClubSnapshot[],
  period: HistoryPeriod,
  now: Date,
): ClubSnapshot[] {
  return filterSnapshotsByPeriod(snapshots, period, now);
}

export function toHistoryPoints(snapshots: readonly ClubSnapshot[]): PlayerHistoryPoint[] {
  return snapshots.map((snapshot) => ({
    capturedAt: snapshot.capturedAt,
    trophies: finiteNumber(snapshot.trophies),
  }));
}

/** Change between the first and last stored points; null when insufficient history. */
export function calculatePlayerHistoryChange(
  points: readonly PlayerHistoryPoint[],
): PlayerHistoryChange | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return null;
  const firstTrophies = finiteNumber(first.trophies);
  const lastTrophies = finiteNumber(last.trophies);
  if (firstTrophies === null || lastTrophies === null) return null;
  return { trophies: lastTrophies - firstTrophies };
}

/** Highest value actually present in stored snapshots or the stored player row. */
export function highestRecordedTrophies(
  points: readonly PlayerHistoryPoint[],
  fallback: number | null,
): number | null {
  const values = points
    .map((point) => finiteNumber(point.trophies))
    .filter((value): value is number => value !== null);
  const stored = finiteNumber(fallback);
  if (stored !== null) values.push(stored);
  return values.length === 0 ? null : Math.max(...values);
}

/** Calculate snapshot-backed progression for a player at a known snapshot time. */
export function playerProgression(
  snapshots: readonly ClubSnapshot[],
  currentTrophies: number | null,
  currentAt: string | null,
  now: Date,
  seasonStartIso: string | undefined,
): TrophyProgression | null {
  const trophies = finiteNumber(currentTrophies);
  const timestamp = parseTimestamp(currentAt);
  if (trophies === null || currentAt === null || timestamp === null) return null;

  return calculateTrophyProgression({
    snapshots: snapshots.filter((snapshot) => {
      const captured = parseTimestamp(snapshot.capturedAt);
      return captured !== null && captured <= timestamp;
    }),
    currentTrophies: trophies,
    currentAt,
    now,
    seasonStartIso,
  });
}

/** Duration only when both membership endpoints are present and ordered. */
export function membershipDurationMs(
  validFrom: string | null,
  validTo: string | null,
): number | null {
  const from = parseTimestamp(validFrom);
  const to = parseTimestamp(validTo);
  if (from === null || to === null || to < from) return null;
  return to - from;
}

export function isRecentSync(
  lastSyncedAt: string | null,
  now: Date,
  staleAfterMs: number,
): boolean {
  const synced = parseTimestamp(lastSyncedAt);
  if (synced === null) return false;
  const age = now.getTime() - synced;
  return age >= 0 && age <= staleAfterMs;
}

/**
 * Open memberships are only called current when the player was synced recently.
 * Older open rows are explicitly downgraded to "last recorded".
 */
export function classifyMembershipStatus(
  validFrom: string | null,
  validTo: string | null,
  lastSyncedAt: string | null,
  now: Date,
  staleAfterMs: number,
): ClubMembershipStatus {
  if (validFrom === null) return 'incomplete';
  if (validTo !== null) return 'past';
  return isRecentSync(lastSyncedAt, now, staleAfterMs) ? 'current' : 'last-recorded';
}

/** Latest completed sync shared by two snapshot sets, when one exists. */
export function sharedCompletedRunId(
  first: readonly ClubSnapshot[],
  second: readonly ClubSnapshot[],
  firstRunIds: ReadonlySet<string>,
  secondRunIds: ReadonlySet<string>,
): string | null {
  const firstRuns = new Set(
    first
      .filter((snapshot) => firstRunIds.has(snapshot.syncRunId))
      .map((snapshot) => snapshot.syncRunId),
  );
  const shared = second
    .filter(
      (snapshot) => secondRunIds.has(snapshot.syncRunId) && firstRuns.has(snapshot.syncRunId),
    )
    .sort((a, b) => (parseTimestamp(b.capturedAt) ?? 0) - (parseTimestamp(a.capturedAt) ?? 0));
  return shared[0]?.syncRunId ?? null;
}

/** True when two history windows do not cover the same stored snapshot dates. */
export function snapshotWindowsDiffer(
  firstStart: string | null,
  firstEnd: string | null,
  secondStart: string | null,
  secondEnd: string | null,
): boolean {
  return firstStart !== secondStart || firstEnd !== secondEnd;
}

/** Summarize only values actually present in stored battle-log rows. */
export function summarizePlayerBattles(battles: readonly PlayerBattleRecord[]): {
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly trophyChange: number | null;
  readonly topModes: readonly { readonly mode: string; readonly count: number }[];
} {
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let trophyChange = 0;
  let hasTrophyChange = false;
  const modeCounts = new Map<string, number>();

  for (const battle of battles) {
    const result = battle.result?.toLowerCase() ?? null;
    if (result === 'victory') wins += 1;
    else if (result === 'defeat') losses += 1;
    else if (result === 'draw' || result === 'tie') draws += 1;

    if (battle.trophyChange !== null && Number.isFinite(battle.trophyChange)) {
      trophyChange += battle.trophyChange;
      hasTrophyChange = true;
    }
    if (battle.mode !== null) {
      modeCounts.set(battle.mode, (modeCounts.get(battle.mode) ?? 0) + 1);
    }
  }

  return {
    wins,
    losses,
    draws,
    trophyChange: hasTrophyChange ? trophyChange : null,
    topModes: [...modeCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([mode, count]) => ({ mode, count })),
  };
}
