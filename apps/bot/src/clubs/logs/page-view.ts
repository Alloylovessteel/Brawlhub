import { getBotConfig } from '../../config';
import { loadLeaderboardView } from '../service';
import type {
  ClubLogPeriod,
  ClubLogRow,
  ClubLogView,
  LeaderboardEntry,
  ResolvedClubResult,
} from '../types';

export const CLUB_LOG_PERIODS = ['today', 'week', 'season'] as const;

export const CLUB_LOG_PERIOD_LABELS: Readonly<Record<ClubLogPeriod, string>> = {
  today: 'Today',
  week: 'This Week',
  season: 'This Season',
};

export function isClubLogPeriod(value: string): value is ClubLogPeriod {
  return (CLUB_LOG_PERIODS as readonly string[]).includes(value);
}

/** Rank members by the selected stored trophy delta, sharing ranks on ties. */
export function rankClubLogChanges(
  entries: readonly LeaderboardEntry[],
  period: ClubLogPeriod,
): ClubLogRow[] {
  const eligible = entries
    .map((entry) => {
      const change = entry.progression?.[period] ?? null;
      return change === null ? null : { member: entry, change };
    })
    .filter((row): row is { member: LeaderboardEntry; change: number } => row !== null)
    .sort((a, b) => b.change - a.change || a.member.name.localeCompare(b.member.name));

  let currentRank = 0;
  let previousChange: number | null = null;
  return eligible.map((entry, index) => {
    if (previousChange === null || entry.change !== previousChange) {
      currentRank = index + 1;
      previousChange = entry.change;
    }
    const { progression: _progression, rank: _rank, ...member } = entry.member;
    return { rank: currentRank, member, change: entry.change };
  });
}

/** Build the same read-only view used by the paginated `/clubs log` embed. */
export function toClubLogView(
  leaderboard: Awaited<ReturnType<typeof loadLeaderboardView>> & { kind: 'ok' },
  period: ClubLogPeriod,
): ClubLogView {
  const value = leaderboard.value;
  return {
    club: value.club,
    period,
    rows: rankClubLogChanges(value.entries, period),
    unavailable: value.entries.filter((entry) => entry.progression?.[period] === null).length,
    latestSnapshotAt: value.latestSnapshot?.capturedAt ?? null,
    latestSyncAt: value.latestSyncAt,
  };
}

/** Load a guild-scoped log page from stored official snapshot data. */
export async function loadClubLogView(input: {
  readonly guildId: string | null;
  readonly tag?: string | undefined;
  readonly period: ClubLogPeriod;
  readonly now?: Date;
}): Promise<ResolvedClubResult<ClubLogView>> {
  const result = await loadLeaderboardView({
    tag: input.tag,
    guildId: input.guildId,
    seasonStartIso: getBotConfig().seasonStartIso,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (result.kind !== 'ok') return result;
  return { kind: 'ok', value: toClubLogView(result, input.period) };
}
