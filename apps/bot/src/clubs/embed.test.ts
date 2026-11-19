import { describe, expect, it } from 'vitest';
import { paginate } from '../discord/pagination';
import {
  buildClubsPageEmbed,
  buildClubEmbed,
  buildClubMembersPageEmbed,
  buildCompareEmbed,
  buildHistoryPageEmbed,
  buildLeaderboardPageEmbed,
  CLUB_MEMBER_CAPACITY,
  formatAbsoluteTime,
} from './embed';
import type { BotConfig } from '../config';
import type {
  ClubRecord,
  ClubSummary,
  ClubView,
  ComparisonSide,
  ComparisonView,
  HistoryPoint,
  HistoryView,
  LeaderboardEntry,
  LeaderboardView,
  MemberDetail,
  MemberView,
  SyncedClubView,
  TrophyProgression,
} from './types';

const CONFIG: Pick<
  BotConfig,
  'emojis' | 'playerProfileUrlTemplate' | 'clubProfileUrlTemplate' | 'seasonStartIso'
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
    megaPig: undefined,
    wins: undefined,
    online: undefined,
  },
  playerProfileUrlTemplate: 'https://brawlify.com/player/{tag}',
  clubProfileUrlTemplate: undefined,
  seasonStartIso: '2026-11-02T00:00:00Z',
};

const NOW = new Date('2026-11-18T12:00:00.000Z');

function view(overrides: Partial<ClubView> = {}): ClubView {
  return {
    club: {
      id: 'club-1',
      tag: '2C0Y',
      name: 'Alpha',
      description: 'Club description',
      trophies: 1000,
      requiredTrophies: 500,
      memberCount: 30,
      lastSyncedAt: null,
    },
    roster: [
      { tag: 'G2P9', name: 'Leader', trophies: 900, role: 'president' },
      { tag: 'Q8VR', name: 'Senior', trophies: 700, role: 'senior' },
      { tag: '2C0Y', name: 'Vice', trophies: 600, role: 'vicePresident' },
    ],
    rosterAvailable: true,
    rosterSource: 'live',
    snapshots: [
      {
        id: 's1',
        syncRunId: 'r1',
        capturedAt: '2026-11-01T23:59:00.000Z',
        trophies: 1000,
        memberCount: 30,
        raw: null,
      },
      {
        id: 's2',
        syncRunId: 'r2',
        capturedAt: '2026-11-16T00:00:00.000Z',
        trophies: 1100,
        memberCount: 30,
        raw: null,
      },
      {
        id: 's3',
        syncRunId: 'r3',
        capturedAt: '2026-11-18T00:00:00.000Z',
        trophies: 1200,
        memberCount: 30,
        raw: null,
      },
    ],
    currentTrophies: 1300,
    currentAt: NOW.toISOString(),
    description: 'Club description',
    requiredTrophies: 500,
    type: null,
    badgeId: null,
    matchActivity: null,
    megaPigEstimate: null,
    latestSyncAt: '2026-11-17T10:00:00.000Z',
    liveStatus: 'live',
    apiIssue: null,
    ...overrides,
  };
}

function summary(index: number): ClubSummary {
  return {
    club: {
      id: `club-${index}`,
      tag: `TAG${index}`,
      name: `Club ${index}`,
      description: null,
      trophies: 1000 + index,
      requiredTrophies: 100_000,
      memberCount: 20,
      lastSyncedAt: null,
    },
    totalTrophies: 1000 + index,
    averageTrophies: 50 + index,
    memberCount: 20,
    latestSyncAt: '2026-11-17T10:00:00.000Z',
    leader: { name: `Leader ${index}`, tag: `L${index}` },
    trophyRange: { low: 90_000 + index, high: 120_000 + index },
    rankedRange: { low: 'Diamond I', high: 'Mythic II' },
    megaPigEstimate: {
      matches: 64,
      wins: 42,
      trophyChange: 120,
      sampleSize: 30,
      windowStart: '2026-11-01T00:00:00.000Z',
      windowEnd: '2026-11-08T00:00:00.000Z',
    },
    activeMembers24h: 12,
  };
}

const CLUB_A: ClubRecord = {
  id: 'club-a',
  tag: '2C0Y',
  name: 'Alpha',
  description: null,
  trophies: 1000,
  requiredTrophies: 500,
  memberCount: 2,
  lastSyncedAt: null,
};

const CLUB_B: ClubRecord = {
  id: 'club-b',
  tag: 'Q8VR',
  name: 'Bravo',
  description: null,
  trophies: 900,
  requiredTrophies: 400,
  memberCount: 2,
  lastSyncedAt: null,
};

function synced(overrides: Partial<SyncedClubView> = {}): SyncedClubView {
  return {
    club: CLUB_A,
    snapshots: [],
    completedRunIds: new Set(['run-1']),
    latestSnapshot: {
      id: 'snapshot-1',
      syncRunId: 'run-1',
      capturedAt: '2026-11-18T06:00:00.000Z',
      trophies: 1200,
      memberCount: 2,
      raw: null,
    },
    roster: [],
    rosterSource: 'snapshot',
    latestSyncAt: '2026-11-18T06:05:00.000Z',
    ...overrides,
  };
}

function detail(
  tag: string,
  name: string,
  trophies: number | null,
  role: string | null = 'member',
  playerId: string | null = null,
  highestTrophies: number | null = null,
): MemberDetail {
  return { tag, name, trophies, role, playerId, highestTrophies };
}

function leaderEntry(
  tag: string,
  name: string,
  trophies: number,
  rank: number,
  progression: TrophyProgression | null,
): LeaderboardEntry {
  return { ...detail(tag, name, trophies, 'member', tag, trophies + 50), rank, progression };
}

function point(capturedAt: string, trophies: number, average: number, count: number): HistoryPoint {
  return {
    capturedAt,
    syncRunId: 'run-1',
    trophies,
    averageTrophies: average,
    memberCount: count,
  };
}

function comparisonSide(
  club: ClubRecord,
  overrides: Partial<ComparisonSide> = {},
): ComparisonSide {
  return {
    club,
    trophies: null,
    averageTrophies: null,
    memberCount: null,
    highestTrophies: null,
    lowestTrophies: null,
    progression: null,
    latestSyncAt: null,
    snapshotAt: null,
    syncRunId: null,
    ...overrides,
  };
}

describe('club embeds', () => {
  it('renders supported sections in the required order', () => {
    const json = buildClubEmbed(view(), CONFIG, NOW).toJSON();
    const names = (json.fields ?? []).map((field) => field.name);

    expect(names).toEqual([
      'Trophies',
      'Trophy Range',
      'President',
      'Required Trophies',
      'Members',
      'Trophy Progression',
      'Description',
    ]);
    expect(json.title).toBe('Alpha • #2C0Y');
    expect(json.fields?.[0]?.value).toContain('1,300');
    expect(json.fields?.[0]?.value).toContain('Average');
    expect(json.fields?.[0]?.value).toContain('733');
    expect(json.fields?.[2]?.value).toBe('[Leader](https://brawlify.com/player/G2P9)');
    expect(json.fields?.[4]?.value).toContain(`3/${CLUB_MEMBER_CAPACITY}`);
    expect(json.fields?.[4]?.value).toContain('Vice-Presidents 1');
    expect(json.fields?.[4]?.value).toContain('Seniors 1');
    expect(json.fields?.[5]?.value).toContain('Today +100');
    expect(json.fields?.[5]?.value).toContain('Week +200');
    expect(json.fields?.[5]?.value).toContain('Season +300');
  });

  it('omits unsupported and unavailable fields instead of showing placeholders', () => {
    const empty = view({
      roster: [],
      rosterAvailable: false,
      snapshots: [],
      currentTrophies: null,
      currentAt: '',
      description: null,
      requiredTrophies: null,
      latestSyncAt: null,
    });
    const json = buildClubEmbed(empty, CONFIG, NOW).toJSON();
    const text = JSON.stringify(json);

    expect(json.fields ?? []).toHaveLength(0);
    expect(text).not.toContain('Unavailable');
    expect(text).not.toContain('Average Matches Played');
    expect(text).not.toContain('Mega Pig');
    expect(text).not.toContain('Type');
  });

  it('keeps long descriptions and titles inside Discord embed limits', () => {
    const long = view({
      club: { ...view().club, name: 'A'.repeat(400) },
      description: 'D'.repeat(5000),
    });
    const json = buildClubEmbed(long, CONFIG, NOW).toJSON();

    expect(json.title?.length).toBeLessThanOrEqual(256);
    for (const field of json.fields ?? []) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    expect(JSON.stringify(json).length).toBeLessThan(6000);
    expect(JSON.stringify(json)).not.toContain('Unavailable');
  });

  it('renders a bounded BrawlTools-style club overview page', () => {
    const summaries = Array.from({ length: 12 }, (_, index) => summary(index + 1));
    const page = paginate(summaries, 2, 5);
    const json = buildClubsPageEmbed(summaries, page, CONFIG).toJSON();
    const value = json.fields?.[0]?.value ?? '';

    expect(json.fields).toHaveLength(5);
    expect(json.fields?.[0]?.name).toBe('Club 6');
    expect(value).toContain('👑 [Leader 6](https://brawlify.com/player/L6)');
    expect(value).toContain('🏆1,006');
    expect(value).toContain('📈90k-120k');
    expect(value).toContain('🎖️ 🔹Diamond I - 🔹Mythic II');
    expect(value).toContain('🐷 ✅42/64 (est.)');
    expect(value).toContain('🔒 Req: 100,000');
    expect(value).toContain('👥20/30 • 🟢12 active 24h');
    const syncSeconds = Math.floor(Date.parse('2026-11-17T10:00:00.000Z') / 1000);
    expect(value).toContain(`🕒 Synced <t:${syncSeconds}:R>`);
    expect(json.footer?.text).toContain('Page 2 / 3');
    expect(json.footer?.text).toContain('not exposed by the Brawl Stars API');
  });

  it('renders club roster pages with stored details and Brawlify links', () => {
    const members = Array.from({ length: 12 }, (_, index) =>
      detail(
        `G2P${index}`,
        index === 0 ? 'A'.repeat(200) : `Player ${index + 1}`,
        2000 - index * 100,
        index === 0 ? 'president' : 'member',
        `p${index}`,
        2500 - index * 100,
      ),
    );
    const view: MemberView = { ...synced(), members };
    const json = buildClubMembersPageEmbed(view, paginate(members, 2, 10), CONFIG).toJSON();

    expect(json.title).toContain('#2C0Y');
    expect(json.description).toContain(`Current roster: 12 / ${CLUB_MEMBER_CAPACITY}`);
    expect(json.fields).toHaveLength(2);
    expect(json.fields?.[0]?.name).toContain('11.');
    expect(json.fields?.[0]?.name).toContain('https://brawlify.com/player/G2P10');
    expect(json.fields?.[0]?.value).toContain('Highest trophies: 1,500');
    expect(json.footer?.text).toContain('Page 2 / 2');
    expect(JSON.stringify(json).length).toBeLessThanOrEqual(6000);
  });

  it('handles roster members with missing player information safely', () => {
    const members = [detail('Q8VR', '', null, 'senior')];
    const view: MemberView = { ...synced(), members };
    const json = buildClubMembersPageEmbed(view, paginate(members, 1, 10), CONFIG).toJSON();

    expect(json.fields?.[0]?.name).toContain('https://brawlify.com/player/Q8VR');
    expect(json.fields?.[0]?.value).toContain('Tag: #Q8VR');
    expect(json.fields?.[0]?.value).toContain('Role: Senior');
    expect(json.fields?.[0]?.value).not.toContain('Current trophies');
    expect(JSON.stringify(json)).not.toContain('Unavailable');
  });

  it('separates current trophies from stored historical progression in leaderboards', () => {
    const entries: LeaderboardEntry[] = [
      leaderEntry('G2P9', 'Leader', 1000, 1, { today: 100, week: 200, season: null }),
      leaderEntry('Q8VR', 'Senior', 900, 2, { today: 50, week: null, season: null }),
    ];
    const view: LeaderboardView = { ...synced(), entries };
    const json = buildLeaderboardPageEmbed(view, paginate(entries, 1, 10), CONFIG).toJSON();

    expect(json.description).toContain('Snapshot');
    expect(json.fields).toHaveLength(2);
    expect(json.fields?.[0]?.name).toContain('#1');
    expect(json.fields?.[0]?.name).toContain('https://brawlify.com/player/G2P9');
    expect(json.fields?.[0]?.value).toContain('Current trophies: 1,000');
    expect(json.fields?.[0]?.value).toContain('Historical Today: +100');
    expect(json.fields?.[0]?.value).toContain('Historical Week: +200');
    expect(json.fields?.[0]?.value).not.toContain('Season');
    expect(json.fields?.[1]?.value).not.toContain('Week');
  });

  it('clearly handles history with no stored snapshots', () => {
    const view: HistoryView = {
      ...synced(),
      period: '30d',
      points: [],
      latestSnapshotAt: null,
      rangeStart: null,
      rangeEnd: null,
      change: null,
      progression: null,
      membershipChanges: [],
    };
    const json = buildHistoryPageEmbed(view, paginate([], 1, 10), CONFIG).toJSON();

    expect((json.fields ?? []).map((field) => field.name)).toEqual([
      'Available Range',
      'Changes',
      'Snapshots',
    ]);
    expect(JSON.stringify(json)).toContain('No stored snapshots');
    expect(JSON.stringify(json)).not.toContain('Unavailable');
  });

  it('renders stored history ranges, changes and progression within embed limits', () => {
    const points = Array.from({ length: 12 }, (_, index) =>
      point(new Date(Date.UTC(2026, 10, 1 + index)).toISOString(), 1000 + index * 100, 700 + index * 20, 10),
    );
    const view: HistoryView = {
      ...synced({
        club: { ...CLUB_A, name: 'A'.repeat(400) },
        latestSnapshot: null,
      }),
      period: 'all',
      points,
      latestSnapshotAt: points[11]?.capturedAt ?? null,
      rangeStart: points[0]?.capturedAt ?? null,
      rangeEnd: points[11]?.capturedAt ?? null,
      change: { trophies: 1100, averageTrophies: 220, memberCount: 0 },
      progression: { today: 100, week: 200, season: 300 },
      membershipChanges: [
        {
          detectedAt: '2026-11-17T12:00:00.000Z',
          eventType: 'join',
          playerName: 'B'.repeat(300),
          playerTag: 'P9LQ',
        },
      ],
    };
    const json = buildHistoryPageEmbed(view, paginate(points, 1, 10), CONFIG).toJSON();

    expect(json.title?.length).toBeLessThanOrEqual(256);
    expect(json.description).toContain(formatAbsoluteTime(view.latestSnapshotAt));
    expect(json.fields?.find((field) => field.name === 'Available Range')?.value).toContain('→');
    expect(json.fields?.find((field) => field.name === 'Club Trophies')?.value).toContain('+1,100');
    expect(json.fields?.find((field) => field.name === 'Trophy Progression')?.value).toContain('Week: +200');
    expect(json.fields?.length).toBeLessThanOrEqual(25);
    for (const field of json.fields ?? []) {
      expect(field.name.length).toBeLessThanOrEqual(256);
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    expect(JSON.stringify(json).length).toBeLessThanOrEqual(6000);
  });

  it('labels comparison leaders only for comparable values and warns about different sync times', () => {
    const view: ComparisonView = {
      first: comparisonSide(CLUB_A, {
        trophies: 1000,
        averageTrophies: 700,
        memberCount: 10,
        highestTrophies: 900,
        lowestTrophies: 500,
        progression: { today: 100, week: 0, season: 200 },
        latestSyncAt: '2026-11-18T06:05:00.000Z',
        snapshotAt: '2026-11-18T06:00:00.000Z',
        syncRunId: 'run-1',
      }),
      second: comparisonSide(CLUB_B, {
        trophies: 900,
        averageTrophies: null,
        memberCount: 10,
        highestTrophies: 800,
        lowestTrophies: 400,
        progression: { today: 50, week: null, season: null },
        latestSyncAt: '2026-11-17T06:05:00.000Z',
        snapshotAt: '2026-11-17T06:00:00.000Z',
        syncRunId: 'run-2',
      }),
      aligned: false,
    };
    const json = buildCompareEmbed(view, CONFIG).toJSON();
    const field = (name: string) => (json.fields ?? []).find((item) => item.name === name);

    expect(json.description).toContain('different completed sync times');
    expect(field('Total Trophies')?.value).toContain('Leader: Alpha (#2C0Y)');
    expect(field('Average Member Trophies')).toBeUndefined();
    expect(field('Member Count')?.value).toContain('Leader: Tied');
    expect(field('Lowest Member Trophies')?.value).toContain('Leader: Alpha (#2C0Y)');
    expect(field('Trophy Progression · Today')?.value).toContain('Leader: Alpha (#2C0Y)');
    expect(field('Trophy Progression · Week')).toBeUndefined();
    expect(field('Trophy Progression · Season')).toBeUndefined();
    expect(field('Latest Successful Sync')).toBeDefined();
    expect(field('Snapshot Times')?.value).toContain('Different snapshot times.');
  });

  it('marks aligned comparisons and keeps very long club names inside embed limits', () => {
    const first = comparisonSide(
      { ...CLUB_A, name: 'A'.repeat(300) },
      {
        trophies: 1000,
        averageTrophies: 700,
        memberCount: 10,
        highestTrophies: 900,
        lowestTrophies: 500,
        progression: { today: 100, week: 200, season: 300 },
        latestSyncAt: '2026-11-18T06:05:00.000Z',
        snapshotAt: '2026-11-18T06:00:00.000Z',
        syncRunId: 'run-1',
      },
    );
    const second = comparisonSide(
      { ...CLUB_B, name: 'B'.repeat(300) },
      {
        trophies: 900,
        averageTrophies: 600,
        memberCount: 10,
        highestTrophies: 800,
        lowestTrophies: 400,
        progression: { today: 50, week: 100, season: 150 },
        latestSyncAt: '2026-11-18T06:05:00.000Z',
        snapshotAt: '2026-11-18T06:00:00.000Z',
        syncRunId: 'run-1',
      },
    );
    const json = buildCompareEmbed({ first, second, aligned: true }, CONFIG).toJSON();

    expect(json.description).toContain('same completed sync');
    expect(json.fields?.length).toBeLessThanOrEqual(25);
    for (const field of json.fields ?? []) {
      expect(field.name.length).toBeLessThanOrEqual(256);
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    expect(JSON.stringify(json).length).toBeLessThanOrEqual(6000);
  });
});
