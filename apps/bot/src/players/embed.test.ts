import { describe, expect, it } from 'vitest';
import { paginate } from '../discord/pagination';
import {
  buildBrawlerDetailEmbed,
  buildMeMoreEmbed,
  buildPlayerBattlesPageEmbed,
  buildPlayerBrawlersPageEmbed,
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
    iconId: null,
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
    const data = json(
      buildPlayerProfileEmbed(
        profile({ player: identity({ lastBattleAt: '2026-11-18T10:00:00.000Z' }) }),
        config,
      ),
    );
    const text = JSON.stringify(data);

    expect(data.title).toContain('[Alpha](https://brawlify.com/player/2C0Y)');
    expect(text).toContain('🏆 Current Trophies');
    expect(text).toContain('👑 Highest Trophies');
    expect(text).toContain('Experience');
    expect(text).toContain('🟢 Player Activity');
    expect(text).toContain('Online status is not exposed by the official API');
    expect(text).toContain('[Alpha Club](https://example.test/clubs/8QCL)');
    expect(text).toContain('Top Brawlers (Live API)');
    expect(text).toContain('**Snapshot:**');
    expect(data.description).toContain('**Source:** live official API');
    const topBrawlers = data.fields?.find((field) => field.name === 'Top Brawlers (Live API)')?.value ?? '';
    expect(topBrawlers).toContain('**Brawlers:** 1');
    expect(topBrawlers).toContain('• `Shelly`');
  });

  it('renders brawler detail values with bold labels and code spans', () => {
    const brawler = {
      id: 1,
      name: 'Shelly',
      trophies: 900,
      highestTrophies: 1000,
      power: 11,
      rank: 1,
      prestigeLevel: 0,
      currentWinStreak: 2,
      maxWinStreak: 5,
      gadgets: [{ name: 'Clay Pigeon', id: 1, level: 1 }],
      starPowers: [],
      gears: [],
      hyperCharges: [],
    };
    const view = {
      ...profile(),
      brawlers: [brawler],
      catalog: [],
      source: 'live',
      apiIssue: null,
      fetchedAt: null,
    } as never;

    const data = json(buildBrawlerDetailEmbed(view, brawler, config));
    const fieldValue = (name: string) => data.fields?.find((field) => field.name === name)?.value ?? '';

    expect(data.description).toContain('**Source:** live official player data');
    expect(data.description).toContain('`#2C0Y`');
    expect(fieldValue('Official Profile Stats')).toContain('**Trophies:** 900');
    expect(fieldValue('Unlocks')).toContain('**Gadgets:** `Clay Pigeon`');
  });

  it('uses a resolved player icon as an optional thumbnail', () => {
    const embed = buildPlayerProfileEmbed(
      profile({ player: identity({ iconId: 28000003 }) }),
      config,
      'https://cdn.example.test/player/28000003.png',
    ).toJSON();

    expect(embed.thumbnail?.url).toBe('https://cdn.example.test/player/28000003.png');
  });

  it('uses a resolved icon on history and club-history embeds', () => {
    const historyView = {
      player: identity(),
      points: [],
      period: '30d',
      currentTrophies: null,
      highestRecordedTrophies: null,
      firstSnapshotAt: null,
      latestSnapshotAt: null,
      change: null,
      progression: null,
      memberships: [],
      events: [],
    } as never;
    const clubsView = {
      player: identity(),
      currentClub: null,
      memberships: [],
      events: [],
    } as never;
    const iconUrl = 'https://cdn.example.test/player/icon.png';

    const history = buildPlayerHistoryPageEmbed(
      historyView,
      paginate([], 1, 10),
      config,
      iconUrl,
    ).toJSON();
    const clubs = buildPlayerClubsPageEmbed(
      clubsView,
      paginate([], 1, 10),
      config,
      iconUrl,
    ).toJSON();

    expect(history.thumbnail?.url).toBe(iconUrl);
    expect(clubs.thumbnail?.url).toBe(iconUrl);
  });

  it('prefers the first brawler portrait on battle and roster embeds', () => {
    const battleItems = [{
      id: 'b1',
      syncRunId: null,
      battleTime: '2026-11-18T10:00:00.000Z',
      mode: 'gemGrab',
      map: 'Double Trouble',
      battleType: 'ranked',
      result: 'victory',
      trophyChange: 8,
      brawlerName: 'Shelly',
      starPlayerName: null,
    }];
    const brawlerItems = [{
      id: 1,
      name: 'Shelly',
      trophies: 900,
      highestTrophies: 1000,
      power: 11,
      rank: 1,
      prestigeLevel: null,
      currentWinStreak: null,
      maxWinStreak: null,
      gadgets: [],
      starPowers: [],
      gears: [],
      hyperCharges: [],
    }];
    const battlesView = {
      player: identity(),
      period: '30d',
      battles: battleItems,
      wins: 1,
      losses: 0,
      draws: 0,
      topModes: [],
    } as never;
    const brawlersView = {
      player: identity(),
      brawlers: brawlerItems,
      catalog: [],
      source: 'live',
      apiIssue: null,
      fetchedAt: null,
    } as never;
    const portraitUrl = 'https://cdn.example.test/brawlers/shelly.png';

    const battles = buildPlayerBattlesPageEmbed(
      battlesView,
      paginate(battleItems, 1, 10) as never,
      config,
      'https://cdn.example.test/player/icon.png',
      portraitUrl,
    ).toJSON();
    const roster = buildPlayerBrawlersPageEmbed(
      brawlersView,
      paginate(brawlerItems, 1, 10) as never,
      'trophies',
      'all',
      config,
      portraitUrl,
    ).toJSON();

    expect(battles.thumbnail?.url).toBe(portraitUrl);
    expect(roster.thumbnail?.url).toBe(portraitUrl);
  });

  it('uses a resolved icon on the interactive More embed', () => {
    const view = {
      history: { player: identity(), period: '30d' },
      battles: { player: identity(), period: '30d', battles: [], topModes: [] },
      clubs: { player: identity(), currentClub: null, memberships: [], events: [] },
    } as never;
    const iconUrl = 'https://cdn.example.test/player/icon.png';

    const embed = buildMeMoreEmbed(view, config, iconUrl).toJSON();

    expect(embed.thumbnail?.url).toBe(iconUrl);
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
    expect(text).toContain('**Current trophies:** 5,000');
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
    expect(text).toContain('**Duration:** 31d');
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
    expect(field('Current Trophies')).toContain('**Leader:** [Alpha](https://brawlify.com/player/2C0Y)');
    expect(fields.some((candidate) => candidate.name === 'Highest Trophies')).toBe(false);
    expect(fields.some((candidate) => candidate.name === 'Experience Level')).toBe(false);
    expect(field('Trophy Progression · Today')).toContain('**Leader:** [Alpha]');
    expect(field('Trophy Progression · Week')).toContain('**Leader:** [Bravo]');
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
