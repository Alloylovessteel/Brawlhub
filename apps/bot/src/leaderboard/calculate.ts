/** Pure ranking, deduplication and snapshot calculations for global leaderboards. */

import type { ClubSnapshot } from '../clubs/types';
import type { PlayerIdentity, PlayerMembershipRecord } from '../players/types';
import type { ClubChoice, ProgressionPeriod } from './types';

export const PROGRESSION_PERIOD_DAYS: Readonly<Record<ProgressionPeriod, number>> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

const DAY_MS = 24 * 60 * 60 * 1000;

const CLUB_STATUS_PRIORITY: Readonly<Record<ClubChoice['status'], number>> = {
  current: 0,
  'last-recorded': 1,
  past: 2,
  incomplete: 3,
};

function finiteNumber(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function parseTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normaliseTag(value: string): string {
  return value.trim().replace(/^#+/, '').toUpperCase();
}

export function isProgressionPeriod(value: string): value is ProgressionPeriod {
  return value === '7d' || value === '30d' || value === '90d';
}

/** Whole-number average, or null when the member count is missing or invalid. */
export function averageTrophies(total: number, memberCount: number | null): number | null {
  const totalValue = finiteNumber(total);
  const count = finiteNumber(memberCount);
  if (totalValue === null || count === null || count <= 0) return null;
  return Math.round(totalValue / count);
}

/** Keep one row per player tag, then per player id, without inventing identities. */
export function deduplicatePlayers(players: readonly PlayerIdentity[]): PlayerIdentity[] {
  const seenTags = new Set<string>();
  const seenIds = new Set<string>();
  const result: PlayerIdentity[] = [];

  for (const player of players) {
    const tag = normaliseTag(player.tag);
    if (tag === '' || seenTags.has(tag)) continue;
    if (player.id !== null && seenIds.has(player.id)) continue;
    seenTags.add(tag);
    if (player.id !== null) seenIds.add(player.id);
    result.push(player);
  }

  return result;
}

export interface Ranked<T> {
  readonly rank: number;
  readonly item: T;
}

/**
 * Sort by a valid score and assign shared positions. Rows without a score are
 * excluded rather than ranked as zero.
 */
export function rankByScore<T>(
  items: readonly T[],
  score: (item: T) => number | null,
  compare: (a: T, b: T) => number = () => 0,
): Ranked<T>[] {
  const scored = items
    .map((item) => ({ item, score: finiteNumber(score(item)) }))
    .filter((entry): entry is { item: T; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || compare(a.item, b.item));

  let rank = 0;
  let previousScore: number | null = null;

  return scored.map((entry, index) => {
    if (previousScore === null || entry.score !== previousScore) {
      rank = index + 1;
      previousScore = entry.score;
    }
    return { rank, item: entry.item };
  });
}

/** Choose the best available club record, preferring a verified current membership. */
export function chooseClub(memberships: readonly PlayerMembershipRecord[]): ClubChoice | null {
  const candidates = memberships
    .filter((membership) => membership.tag !== '')
    .sort((a, b) => {
      const priority = CLUB_STATUS_PRIORITY[a.status] - CLUB_STATUS_PRIORITY[b.status];
      if (priority !== 0) return priority;
      const fromA = parseTimestamp(a.validFrom) ?? Number.NEGATIVE_INFINITY;
      const fromB = parseTimestamp(b.validFrom) ?? Number.NEGATIVE_INFINITY;
      if (fromA !== fromB) return fromB - fromA;
      return normaliseTag(a.tag).localeCompare(normaliseTag(b.tag));
    });

  const selected = candidates[0];
  if (selected === undefined) return null;
  return { club: selected, status: selected.status };
}

/** Latest completed run shared by every supplied snapshot group. */
export function commonRunId(
  groups: readonly (readonly ClubSnapshot[])[],
): string | null {
  if (groups.length === 0) return null;
  const runSets = groups.map((group) => new Set(group.map((snapshot) => snapshot.syncRunId)));
  const first = runSets[0];
  if (first === undefined) return null;

  const shared = [...first].filter((runId) => runSets.every((set) => set.has(runId)));
  if (shared.length === 0) return null;

  let bestRunId: string | null = null;
  let bestTimestamp = Number.NEGATIVE_INFINITY;
  for (const runId of shared) {
    for (const group of groups) {
      for (const snapshot of group) {
        if (snapshot.syncRunId !== runId) continue;
        const timestamp = parseTimestamp(snapshot.capturedAt);
        if (timestamp !== null && timestamp > bestTimestamp) {
          bestTimestamp = timestamp;
          bestRunId = runId;
        }
      }
    }
  }
  return bestRunId;
}

export function timestampsDiffer(values: readonly string[]): boolean {
  return new Set(values).size > 1;
}

export interface ProgressionResult {
  readonly start: ClubSnapshot;
  readonly latest: ClubSnapshot;
  readonly difference: number;
  /** True when the latest point came from the requested shared completed run. */
  readonly alignedWithRun: boolean;
}

/** Calculate a real two-point gain from stored snapshots; never interpolate. */
export function calculateProgression(
  snapshots: readonly ClubSnapshot[],
  period: ProgressionPeriod,
  now: Date,
  preferredRunId: string | null = null,
): ProgressionResult | null {
  const sinceMs = now.getTime() - PROGRESSION_PERIOD_DAYS[period] * DAY_MS;
  const points = snapshots
    .filter((snapshot) => {
      const captured = parseTimestamp(snapshot.capturedAt);
      return (
        finiteNumber(snapshot.trophies) !== null &&
        captured !== null &&
        captured >= sinceMs
      );
    })
    .sort((a, b) => {
      const difference = (parseTimestamp(a.capturedAt) ?? 0) - (parseTimestamp(b.capturedAt) ?? 0);
      return difference !== 0 ? difference : a.id.localeCompare(b.id);
    });

  const start = points[0];
  const ownLatest = points[points.length - 1];
  if (
    start === undefined ||
    ownLatest === undefined ||
    points.length < 2 ||
    start.capturedAt === ownLatest.capturedAt
  ) {
    return null;
  }

  let latest = ownLatest;
  let alignedWithRun = false;
  if (preferredRunId !== null) {
    const aligned = points.find(
      (point) =>
        point.syncRunId === preferredRunId &&
        (parseTimestamp(point.capturedAt) ?? 0) > (parseTimestamp(start.capturedAt) ?? 0),
    );
    if (aligned !== undefined) {
      latest = aligned;
      alignedWithRun = true;
    }
  }

  const startTrophies = finiteNumber(start.trophies);
  const latestTrophies = finiteNumber(latest.trophies);
  if (startTrophies === null || latestTrophies === null) return null;

  return {
    start,
    latest,
    difference: latestTrophies - startTrophies,
    alignedWithRun,
  };
}
