import { describe, expect, it } from 'vitest';
import { paginate } from '../discord/pagination';
import {
  buildPlayerClubsPageEmbed,
  buildPlayerCompareEmbed,
  buildPlayerHistoryPageEmbed,
  buildPlayerProfileEmbed,
} from './embed';
import type {
  PlayerClubsView,
  PlayerComparisonView,
  PlayerHistoryView,
  PlayerIdentity,
  PlayerMembershipRecord,
  PlayerProfileView,
} from './types';

const config = {
  emojis: {
    trophies: undefined,
    trophyRange: undefined,
    president: undefined,
    requiredTrophies: undefined,
    members: undefined,
    matches: undefined,
    progression: undefined,
    description: undefined,
  },
  playerProfileUrlTemplate: 'https://brawlify.com/player/{tag}',
  clubProfileUrlTemplate: 'https://example.test/clubs/{tag}',
  seasonStartIso: '2026-11-01T00:00:00.000Z',
} as never;

function identity(overrides: Partial<PlayerIdentity> = {}): PlayerIdentity {
  return {
    id: 'p1',
    tag: '2C0Y',
    name: 'Alpha',
    trophies: 5000,
    highestTrophies: 5200,
    expLevel: 35,
    expPoints: 12345,
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
    ...overrides,
  };
}

function profile(overrides: Partial<PlayerProfileView> = {}): PlayerProfileView {
  return {
    player: identity(),
    currentClub: {
      id: 'club-a',
      tag: '8QCL',
      name: 'Alpha Club',
      role: 'president',
      validFrom: '2026-11-01T00:00:00.000Z',
      validTo: null,
    },
    brawlers: [
      {
        name: 'Shelly',
        trophies: 900,
        highestTrophies: 900,
        power: 11,
        rank: 35,
        prestigeLevel: null,
        currentWinStreak: null,
        maxWinStreak: 7,
        gadgets: 2,
        starPowers: 2,
        gears: 1,
        hyperCharges: 1,
      },
    ],
    stats: { brawlerCount: 1, totalPrestigeLevels: null, maxedBrawlers: 1 },
    latestSnapshotAt: '2026-11-17T00:00:00.000Z',
    source: 'live',
    apiIssue: null,
    profileFetchedAt: '2026-11-18T12:00:00.000Z',
    ...overrides,
  };
}

function json(embed: ReturnType<typeof buildPlayerProfileEmbed>) {
  return embed.toJSON() as {
    title?: string;
    description?: string;
    fields?: Array<{ name: string; value: string }>;
    footer?: { text: string };
  };
}

describe('player embeds', () => {
  it('renders profile details with Brawlify and configured club links', () => {
    const data = json(buildPlayerProfileEmbed(profile(), config));
    const text = JSON.stringify(data);

    expect(data.title).toContain('[Alpha](https://brawlify.com/player/2C0Y)');
    expect(text).toContain('Current Trophies');
    expect(text).toContain('Highest Trophies');
    expect(text).toContain('Experience');
    expect(text).toContain('[Alpha Club](https://example.test/clubs/8QCL)');
    expect(text).toContain('Top Brawlers (Live API)');
    expect(text).toContain('Snapshot:');
  });

  it('omits missing profile fields instead of showing placeholders', () => {
    const data = json(
      buildPlayerProfileEmbed(
        profile({
          player: identity({ trophies: null, highestTrophies: null, expLevel: null, expPoints: null }),
          currentClub: null,
          brawlers: [],
          stats: null,
          latestSnapshotAt: null,
          source: 'stored',
          apiIssue: null,
          profileFetchedAt: null,
        }),
        config,
      ),
    );
    const text = JSON.stringify(data);

    expect(text).not.toContain('Unavailable');
    expect(text).not.toContain('Current Trophies');
    expect(text).not.toContain('Highest Trophies');
    expect(text).not.toContain('"name":"Experience"');
    expect(text).not.toContain('Current Club');
    expect(text).toContain('Stored data only');
  });

  it('clearly indicates insufficient history while showing stored snapshots', () => {
    const view: PlayerHistoryView = {
      player: identity(),
      period: '30d',
      points: [{ capturedAt: '2026-11-17T00:00:00.000Z', trophies: 5000 }],
      currentTrophies: 5000,
      highestRecordedTrophies: 5200,
      firstSnapshotAt: '2026-11-17T00:00:00.000Z',
      latestSnapshotAt: '2026-11-17T00:00:00.000Z',
      change: null,
      progression: null,
      memberships: [],
      events: [],
    };
    const data = json(buildPlayerHistoryPageEmbed(view, paginate(view.points, 1, 10), config));
    const text = JSON.stringify(data);

    expect(text).toContain('At least two stored snapshots');
    expect(text).toContain('1 stored snapshot');
    expect(text).toContain('Current trophies: 5,000');
  });

  it('distinguishes confirmed, stale and incomplete membership records', () => {
    const view: PlayerClubsView = {
      player: identity(),
      currentClub: {
        id: 'club-a', tag: '8QCL', name: 'Alpha Club', role: 'president',
        validFrom: '2026-11-01T00:00:00.000Z', validTo: null,
      },
      memberships: [],
      events: [],
      latestSyncAt: '2026-11-18T11:55:00.000Z',
      lastBattleAt: null,
    };
    const memberships: PlayerMembershipRecord[] = [
      {
        id: 'm1',
        tag: '8QCL', name: 'Alpha Club', role: 'president',
        validFrom: '2026-11-01T00:00:00.000Z', validTo: null,
        status: 'current', durationMs: null,
      },
      {
        id: 'm2',
        tag: '2C0Y', name: 'Bravo Club', role: 'member',
        validFrom: '2026-10-01T00:00:00.000Z', validTo: '2026-11-01T00:00:00.000Z',
        status: 'past', durationMs: 31 * 24 * 60 * 60 * 1000,
      },
      {
        id: 'm3',
        tag: 'Q8VR', name: 'Charlie Club', role: null,
        validFrom: null, validTo: null,
        status: 'incomplete', durationMs: null,
      },
    ];
    const data = json(buildPlayerClubsPageEmbed(view, paginate(memberships, 1, 10), config));
    const text = JSON.stringify(data);

    expect(text).toContain('Current (verified by latest sync)');
    expect(text).toContain('Confirmed previous membership');
    expect(text).toContain('Incomplete record');
    expect(text).toContain('Duration: 31d');
  });

  it('labels comparison leaders only for comparable values and warns about different periods', () => {
    const first = identity({ tag: '2C0Y', name: 'Alpha', trophies: 5000, highestTrophies: 5200, expLevel: 35 });
    const second = identity({ id: 'p2', tag: 'Q8VR', name: 'Bravo', trophies: 4500, highestTrophies: null, expLevel: null });
    const view: PlayerComparisonView = {
      first: {
        player: first, currentClub: null, currentTrophies: first.trophies,
        highestTrophies: first.highestTrophies, expLevel: first.expLevel,
        highestRecordedTrophies: 5200, progression: { today: 10, week: 20, season: null },
        firstSnapshotAt: '2026-11-01T00:00:00.000Z', latestSnapshotAt: '2026-11-17T00:00:00.000Z',
        snapshotTrophies: 5000,
      },
      second: {
        player: second, currentClub: null, currentTrophies: second.trophies,
        highestTrophies: null, expLevel: null, highestRecordedTrophies: 4700,
        progression: { today: 5, week: 30, season: null },
        firstSnapshotAt: '2026-11-02T00:00:00.000Z', latestSnapshotAt: '2026-11-16T00:00:00.000Z',
        snapshotTrophies: 4500,
      },
      period: '30d',
      aligned: false,
      warning: 'Stored snapshots cover different periods; compare with care.',
    };
    const data = json(buildPlayerCompareEmbed(view, config));
    const fields = data.fields ?? [];
    const field = (name: string) => fields.find((candidate) => candidate.name === name)?.value ?? '';

    expect(data.description).toContain('different periods');
    expect(field('Current Trophies')).toContain('Leader: [Alpha](https://brawlify.com/player/2C0Y)');
    expect(fields.some((candidate) => candidate.name === 'Highest Trophies')).toBe(false);
    expect(fields.some((candidate) => candidate.name === 'Experience Level')).toBe(false);
    expect(field('Trophy Progression · Today')).toContain('Leader: [Alpha]');
    expect(field('Trophy Progression · Week')).toContain('Leader: [Bravo]');
    expect(JSON.stringify(data)).toContain('[Alpha](https://brawlify.com/player/2C0Y)');
  });

  it('keeps very long names inside Discord embed limits', () => {
    const longName = 'Long'.repeat(80);
    const first = identity({ name: longName });
    const second = identity({ id: 'p2', tag: 'Q8VR', name: longName, trophies: 4000 });
    const view: PlayerComparisonView = {
      first: {
        player: first, currentClub: null, currentTrophies: 5000, highestTrophies: 5200,
        expLevel: 35, highestRecordedTrophies: 5200,
        progression: { today: 10, week: 20, season: 30 },
        firstSnapshotAt: '2026-11-01T00:00:00.000Z', latestSnapshotAt: '2026-11-17T00:00:00.000Z',
        snapshotTrophies: 5000,
      },
      second: {
        player: second, currentClub: null, currentTrophies: 4000, highestTrophies: 4200,
        expLevel: 20, highestRecordedTrophies: 4200,
        progression: { today: 5, week: 10, season: 15 },
        firstSnapshotAt: '2026-11-01T00:00:00.000Z', latestSnapshotAt: '2026-11-17T00:00:00.000Z',
        snapshotTrophies: 4000,
      },
      period: '30d', aligned: true, warning: null,
    };
    const data = json(buildPlayerCompareEmbed(view, config));
    const total =
      (data.title?.length ?? 0) +
      (data.description?.length ?? 0) +
      (data.footer?.text.length ?? 0) +
      (data.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);

    expect(total).toBeLessThanOrEqual(6000);
    for (const field of data.fields ?? []) {
      expect(field.name.length).toBeLessThanOrEqual(256);
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
  });
});
