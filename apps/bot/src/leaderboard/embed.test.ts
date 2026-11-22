import { describe, expect, it } from 'vitest';
import type { BotConfig } from '../config';
import { formatAbsoluteTime } from '../clubs/embed';
import type { ClubRecord } from '../clubs/types';
import { paginate } from '../discord/pagination';
import type { ClubMembershipStatus, PlayerClubRef, PlayerIdentity } from '../players/types';
import {
  buildClubLeaderboardPageEmbed,
  buildPlayerLeaderboardPageEmbed,
  buildProgressionLeaderboardPageEmbed,
  buildTrophyLeaderboardPageEmbed,
} from './embed';
import type {
  ClubLeaderboardRow,
  ClubLeaderboardView,
  PlayerLeaderboardRow,
  PlayerLeaderboardView,
  ProgressionLeaderboardRow,
  ProgressionLeaderboardView,
  TrophyLeaderboardRow,
  TrophyLeaderboardView,
} from './types';

const CONFIG: Pick<
  BotConfig,
  'emojis' | 'playerProfileUrlTemplate' | 'clubProfileUrlTemplate'
> = {
  emojis: {
    trophies: undefined,
    trophyRange: undefined,
    president: undefined,
    requiredTrophies: undefined,
    members: undefined,
    matches: undefined,
    progression: undefined,
    description: undefined,
    ranked: undefined,
    rank: undefined,
    rankMythic: undefined,
    rankLegendary: undefined,
    rankMasters: undefined,
    rankPro: undefined,
    megaPig: undefined,
    wins: undefined,
    online: undefined,
  },
  playerProfileUrlTemplate: 'https://brawlify.com/player/{tag}',
  clubProfileUrlTemplate: 'https://example.test/clubs/{tag}',
};

const TAGS = ['2C0Y', 'Q8VR', 'G2P9', 'P9Q8', 'V9L2', '8QCL', 'L8R2', 'J0K9', 'R4P7', 'M3N5', 'T1W6', 'X7Y2'] as const;

interface Meta {
  readonly generatedAt: string;
  readonly latestSyncAt: string;
  readonly warning: string | null;
}

function meta(warning: string | null = null): Meta {
  return {
    generatedAt: '2026-11-18T12:00:00.000Z',
    latestSyncAt: '2026-11-17T00:01:00.000Z',
    warning,
  };
}

function tagAt(index: number): string {
  return TAGS[index % TAGS.length] ?? '2C0Y';
}

function clubRecord(index: number, name = `Club ${index + 1}`): ClubRecord {
  return {
    id: `club-${index}`,
    tag: tagAt(index),
    name,
    description: null,
    trophies: 1_200_000,
    requiredTrophies: null,
    memberCount: 30,
    lastSyncedAt: null,
  };
}

function identity(index: number, name = `Player ${index + 1}`): PlayerIdentity {
  return {
    id: `p${index}`,
    tag: tagAt(index),
    name,
    iconId: null,
    trophies: 5_000,
    highestTrophies: 5_200,
    expLevel: 35,
    expPoints: null,
    lastSyncedAt: '2026-11-18T11:55:00.000Z',
    lastBattleAt: null,
    fame: null,
    fameTierName: null,
    totalPrestigeLevel: null,
    threeVsThreeVictories: null,
    soloVictories: null,
    duoVictories: null,
    bestRoboRumbleTime: null,
    bestTimeAsBigBrawler: null,
    rankedRankName: null,
    rankedElo: null,
    highestSeasonRankedRankName: null,
    highestSeasonRankedElo: null,
    highestAllTimeRankedRankName: null,
    highestAllTimeRankedElo: null,
    isQualifiedFromChampionshipChallenge: null,
    megaPig: null,
  };
}

function playerClub(index: number, status: ClubMembershipStatus = 'current'): PlayerClubRef {
  return {
    id: `club-${index}`,
    tag: tagAt(index),
    name: `Club ${index + 1}`,
    role: 'member',
    validFrom: '2026-11-01T00:00:00.000Z',
    validTo: null,
  };
}

function clubRow(index: number, rank = index + 1): ClubLeaderboardRow {
  return {
    rank,
    club: clubRecord(index),
    totalTrophies: 1_200_000,
    memberCount: 30,
    averageTrophies: 40_000,
    snapshotAt: '2026-11-17T00:00:00.000Z',
    syncRunId: 'run-3',
  };
}

function playerRow(index: number, rank = index + 1): PlayerLeaderboardRow {
  return {
    rank,
    player: identity(index),
    trophies: 5_000,
    club: playerClub(index),
    clubStatus: 'current',
  };
}

function trophyRow(index: number, rank = index + 1): TrophyLeaderboardRow {
  return {
    rank,
    player: identity(index),
    highestTrophies: 6_000,
    currentTrophies: index === 0 ? null : 5_000,
    club: playerClub(index),
    clubStatus: 'current',
  };
}

function progressionRow(index: number, rank = index + 1): ProgressionLeaderboardRow {
  return {
    rank,
    player: identity(index),
    startTrophies: 4_300,
    latestTrophies: 5_000,
    difference: 700,
    startAt: '2026-11-12T00:00:00.000Z',
    latestAt: '2026-11-17T00:00:00.000Z',
    syncRunId: 'run-3',
    club: playerClub(index),
    clubStatus: 'current',
  };
}

function clubView(count: number, warning: string | null = null): ClubLeaderboardView {
  return {
    rows: Array.from({ length: count }, (_, index) =>
      clubRow(index, index < 2 ? 1 : index + 1),
    ),
    ...meta(warning),
  };
}

function playerView(count: number): PlayerLeaderboardView {
  return {
    rows: Array.from({ length: count }, (_, index) => playerRow(index)),
    ...meta(),
  };
}

function trophyView(count: number): TrophyLeaderboardView {
  return {
    rows: Array.from({ length: count }, (_, index) => trophyRow(index)),
    ...meta(),
  };
}

function progressionView(count: number): ProgressionLeaderboardView {
  return {
    period: '7d',
    rows: Array.from({ length: count }, (_, index) => progressionRow(index)),
    ...meta(),
  };
}

describe('global leaderboard embeds', () => {
  it('renders club positions, shared ties, totals, averages and pagination metadata', () => {
    const view = clubView(12, 'Snapshots were captured at different times.');
    const page = paginate(view.rows, 1, 10);
    const data = buildClubLeaderboardPageEmbed(view, page, CONFIG).toJSON();
    const fields = data.fields ?? [];

    expect(fields).toHaveLength(10);
    expect(fields[0]?.name).toContain('1. 1.');
    expect(fields[0]?.name).toContain('(shared)');
    expect(fields[1]?.name).toContain('2. 1.');
    expect(fields[0]?.value).toContain('1,200,000');
    expect(fields[0]?.value).toContain('40,000');
    expect(fields[0]?.value).toContain(formatAbsoluteTime('2026-11-17T00:00:00.000Z'));
    expect(data.description).toContain('different times');
    expect(data.footer?.text).toContain('Page 1 / 2');
    expect(data.footer?.text).toContain('1–10 of 12');
  });

  it('distinguishes current trophies from recorded personal bests', () => {
    const players = buildPlayerLeaderboardPageEmbed(
      playerView(1),
      paginate(playerView(1).rows, 1, 10),
      CONFIG,
    ).toJSON();
    const trophies = buildTrophyLeaderboardPageEmbed(
      trophyView(1),
      paginate(trophyView(1).rows, 1, 10),
      CONFIG,
    ).toJSON();

    expect(players.fields?.[0]?.value).toContain('Trophies: 5,000');
    expect(players.fields?.[0]?.value).toContain('Club: [Club 1](https://example.test/clubs/2C0Y)');
    expect(players.fields?.[0]?.value).toContain('— Current');
    expect(trophies.fields?.[0]?.value).toContain('Personal best: 6,000');
    expect(trophies.fields?.[0]?.value).toContain('Current trophies: Unavailable');
    expect(trophies.description).toContain('do not affect the ranking');
  });

  it('shows progression periods with real start and latest snapshot values', () => {
    const view = progressionView(1);
    const data = buildProgressionLeaderboardPageEmbed(view, paginate(view.rows, 1, 10), CONFIG).toJSON();

    expect(data.title).toContain('Last 7 days');
    expect(data.description).toContain('last 7 days');
    expect(data.description).toContain('Missing snapshots are never estimated');
    expect(data.fields?.[0]?.value).toContain('Gain: +700');
    expect(data.fields?.[0]?.value).toContain('Start: 4,300');
    expect(data.fields?.[0]?.value).toContain('Latest: 5,000');
  });

  it('shows graceful empty states for every leaderboard', () => {
    const clubData = buildClubLeaderboardPageEmbed(
      clubView(0),
      paginate(clubView(0).rows, 1, 10),
      CONFIG,
    ).toJSON();
    const players = playerView(0);
    const playerData = buildPlayerLeaderboardPageEmbed(
      players,
      paginate(players.rows, 1, 10),
      CONFIG,
    ).toJSON();
    const trophies = trophyView(0);
    const trophyData = buildTrophyLeaderboardPageEmbed(
      trophies,
      paginate(trophies.rows, 1, 10),
      CONFIG,
    ).toJSON();
    const progression = progressionView(0);
    const progressionData = buildProgressionLeaderboardPageEmbed(
      progression,
      paginate(progression.rows, 1, 10),
      CONFIG,
    ).toJSON();

    expect(clubData.fields?.[0]?.name).toBe('No ranked clubs');
    expect(playerData.fields?.[0]?.name).toBe('No ranked players');
    expect(trophyData.fields?.[0]?.value).toContain('personal-best');
    expect(progressionData.fields?.[0]?.name).toBe('Insufficient progression history');
    expect(progressionData.fields?.[0]?.value).toContain('at least two valid stored snapshots');
  });

  it('fits oversized pages inside Discord embed and field limits', () => {
    const longName = 'Very Long '.repeat(40);
    const clubSource = clubView(10);
    const clubs: ClubLeaderboardView = {
      ...clubSource,
      rows: clubSource.rows.map((row, index) => ({
        ...row,
        club: clubRecord(index, longName),
      })),
    };
    const playerSource = playerView(10);
    const players: PlayerLeaderboardView = {
      ...playerSource,
      rows: playerSource.rows.map((row, index) => ({
        ...row,
        player: identity(index, longName),
        club: { ...playerClub(index), name: longName },
      })),
    };
    const trophySource = trophyView(10);
    const trophies: TrophyLeaderboardView = {
      ...trophySource,
      rows: trophySource.rows.map((row, index) => ({
        ...row,
        player: identity(index, longName),
        club: { ...playerClub(index), name: longName },
      })),
    };
    const progressionSource = progressionView(10);
    const progression: ProgressionLeaderboardView = {
      ...progressionSource,
      rows: progressionSource.rows.map((row, index) => ({
        ...row,
        player: identity(index, longName),
        club: { ...playerClub(index), name: longName },
      })),
    };

    const embeds = [
      buildClubLeaderboardPageEmbed(clubs, paginate(clubs.rows, 1, 10), CONFIG),
      buildPlayerLeaderboardPageEmbed(players, paginate(players.rows, 1, 10), CONFIG),
      buildTrophyLeaderboardPageEmbed(trophies, paginate(trophies.rows, 1, 10), CONFIG),
      buildProgressionLeaderboardPageEmbed(
        progression,
        paginate(progression.rows, 1, 10),
        CONFIG,
      ),
    ];

    for (const data of embeds.map((embed) => embed.toJSON())) {
      const fields = data.fields ?? [];
      const total =
        (data.title?.length ?? 0) +
        (data.description?.length ?? 0) +
        (data.footer?.text.length ?? 0) +
        fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);

      expect(total).toBeLessThanOrEqual(6000);
      expect(data.title?.length ?? 0).toBeLessThanOrEqual(256);
      expect(data.description?.length ?? 0).toBeLessThanOrEqual(2048);
      expect(data.footer?.text.length ?? 0).toBeLessThanOrEqual(2048);
      for (const field of fields) {
        expect(field.name.length).toBeLessThanOrEqual(256);
        expect(field.value.length).toBeLessThanOrEqual(1024);
      }
    }
  });
});
