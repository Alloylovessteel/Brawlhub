import { getBotConfig } from '../../config';
import { loadLeaderboardView } from '../service';
import type {
  ClubLogPeriod,
  ClubLogRow,
  ClubLogView,
  LeaderboardEntry,
  MemberDetail,
  ResolvedClubResult,
  TrophyProgression,
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

type ClubLogMember = MemberDetail & {
  readonly progression?: TrophyProgression | null;
};

function memberDetailOf(member: ClubLogMember): MemberDetail {
  return {
    tag: member.tag,
    name: member.name,
    trophies: member.trophies,
    role: member.role,
    playerId: member.playerId,
    highestTrophies: member.highestTrophies,
  };
}

/**
 * Rank every roster member by the selected stored trophy delta, sharing ranks
 * on ties. A missing baseline is shown as 0 so daily, weekly and season logs
 * always contain the whole roster rather than only calculable changes.
 */
export function rankClubLogChanges(
  members: readonly ClubLogMember[],
  period: ClubLogPeriod,
): ClubLogRow[] {
  const rows = members.map((member) => ({
    member: memberDetailOf(member),
    change: member.progression?.[period] ?? 0,
  }));

  rows.sort(
    (a, b) =>
      b.change - a.change ||
      a.member.name.localeCompare(b.member.name) ||
      a.member.tag.localeCompare(b.member.tag),
  );

  let currentRank = 0;
  let previousChange: number | null = null;
  return rows.map((row, index) => {
    if (previousChange === null || row.change !== previousChange) {
      currentRank = index + 1;
      previousChange = row.change;
    }
    return { rank: currentRank, ...row };
  });
}

/** Build the same read-only view used by the paginated `/clubs log` embed. */
export function toClubLogView(
  leaderboard: Awaited<ReturnType<typeof loadLeaderboardView>> & { kind: 'ok' },
  period: ClubLogPeriod,
): ClubLogView {
  const value = leaderboard.value;
  const progressions = new Map<string, TrophyProgression | null>();
  for (const entry of value.entries) {
    if (entry.playerId !== null) progressions.set(`player:${entry.playerId}`, entry.progression);
    progressions.set(`tag:${entry.tag}`, entry.progression);
  }

  const members: ClubLogMember[] = value.members.map((member) => ({
    ...member,
    progression:
      (member.playerId === null
        ? undefined
        : progressions.get(`player:${member.playerId}`)) ??
      progressions.get(`tag:${member.tag}`) ??
      null,
  }));

  return {
    club: value.club,
    period,
    rows: rankClubLogChanges(members, period),
    unavailable: members.filter((member) => {
      const change = member.progression?.[period];
      return change === null || change === undefined;
    }).length,
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
  /** Override the season baseline, e.g. the start of a completed season digest window. */
  readonly seasonStartIso?: string | undefined;
}): Promise<ResolvedClubResult<ClubLogView>> {
  const result = await loadLeaderboardView({
    tag: input.tag,
    guildId: input.guildId,
    seasonStartIso: input.seasonStartIso ?? getBotConfig().seasonStartIso,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (result.kind !== 'ok') return result;
  return { kind: 'ok', value: toClubLogView(result, input.period) };
}
