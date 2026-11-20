import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createBrawlStarsClient: vi.fn(() => ({
    getClub: vi.fn(),
    getClubMembers: vi.fn(),
    getPlayer: vi.fn(),
  })),
}));

vi.mock('@brawlhub/brawl-stars', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brawlhub/brawl-stars')>();
  return { ...actual, createBrawlStarsClient: mocks.createBrawlStarsClient };
});

import {
  loadClubMemberDetails,
  loadClubPreviousMembers,
  loadCompareView,
  loadHistoryView,
  loadLeaderboardView,
  loadMemberView,
  loadSyncedClub,
} from './service';

type Db = NonNullable<NonNullable<Parameters<typeof loadMemberView>[1]>['db']>;
type Row = Record<string, unknown>;
type QueryCall = {
  readonly table: string;
  readonly filters: Record<string, unknown>;
  readonly ins: Record<string, readonly unknown[]>;
  readonly nots: readonly string[];
  readonly ors: readonly string[];
  readonly orders: readonly string[];
  readonly limit: number | undefined;
  readonly select: string;
};
type Handler = (call: QueryCall) => { data?: unknown; error?: unknown };

interface Fixture {
  readonly clubs?: Row[];
  readonly runs?: Row[];
  readonly snapshotsByClub?: Readonly<Record<string, Row[]>>;
  readonly membershipRows?: Row[];
  readonly verifications?: Row[];
  readonly players?: Row[];
  readonly playerSnapshots?: Row[];
  readonly events?: Row[];
  readonly errors?: Readonly<Record<string, string>>;
}

function createFakeDb(fixture: Fixture = {}): { db: Db; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const clubs = fixture.clubs ?? [CLUB_A, CLUB_B];
  const runs = fixture.runs ?? [RUN_2, RUN_3, RUN_WEEK, RUN_1];
  const membershipRows = fixture.membershipRows ?? [];
  const verifications = fixture.verifications ?? [];
  const players = fixture.players ?? PLAYERS;
  const playerSnapshots = fixture.playerSnapshots ?? PLAYER_SNAPSHOTS;
  const events = fixture.events ?? EVENTS;

  const errorResult = (table: string) => {
    const message = fixture.errors?.[table];
    return message === undefined ? null : { error: { message } };
  };

  const handlers: Record<string, Handler> = {
    'clubs:select': ({ filters }) => {
      const failure = errorResult('clubs');
      if (failure !== null) return failure;
      let rows = clubs;
      if (filters['archived_at'] === null) {
        rows = rows.filter((club) => (club['archived_at'] ?? null) === null);
      }
      if (filters['guild_id'] !== undefined) {
        rows = rows.filter((club) => club['guild_id'] === filters['guild_id']);
      }
      if (filters['tag'] !== undefined) {
        rows = rows.filter((club) => club['tag'] === filters['tag']);
      }
      if (filters['id'] !== undefined) {
        rows = rows.filter((club) => club['id'] === filters['id']);
      }
      return { data: rows };
    },
    'sync_runs:select': () => errorResult('sync_runs') ?? { data: runs },
    'club_snapshots:select': ({ filters }) =>
      errorResult('club_snapshots') ?? {
        data: fixture.snapshotsByClub?.[String(filters['club_id'])] ?? [],
      },
    'club_memberships:select': ({ nots }) => {
      const failure = errorResult('club_memberships');
      if (failure !== null) return failure;
      const rows = nots.includes('valid_to:is:null')
        ? membershipRows.filter((row) => (row['valid_to'] ?? null) !== null)
        : membershipRows;
      return { data: rows };
    },
    'player_verifications:select': () =>
      errorResult('player_verifications') ?? { data: verifications },
    'players:select': ({ ins }) => {
      const failure = errorResult('players');
      if (failure !== null) return failure;
      const tags = ins['tag'] as readonly string[] | undefined;
      return {
        data: tags === undefined ? players : players.filter((player) => tags.includes(String(player['tag']))),
      };
    },
    'player_snapshots:select': ({ ins }) => {
      const failure = errorResult('player_snapshots');
      if (failure !== null) return failure;
      const ids = ins['player_id'] as readonly string[] | undefined;
      return {
        data:
          ids === undefined
            ? playerSnapshots
            : playerSnapshots.filter((snapshot) => ids.includes(String(snapshot['player_id']))),
      };
    },
    'membership_events:select': () => errorResult('membership_events') ?? { data: events },
  };

  class FakeQuery {
    private readonly filters: Record<string, unknown> = {};
    private readonly ins: Record<string, readonly unknown[]> = {};
    private readonly nots: string[] = [];
    private readonly ors: string[] = [];
    private readonly orders: string[] = [];
    private limitValue: number | undefined;
    private mode: 'array' | 'maybeSingle' = 'array';

    constructor(
      private readonly table: string,
      private selectClause: string,
    ) {}

    select(selectClause: string): this {
      this.selectClause = selectClause;
      return this;
    }

    eq(column: string, value: unknown): this {
      this.filters[column] = value;
      return this;
    }

    is(column: string, value: unknown): this {
      this.filters[column] = value;
      return this;
    }

    not(column: string, operator: string, value: unknown): this {
      this.nots.push(`${column}:${operator}:${String(value)}`);
      return this;
    }

    in(column: string, values: readonly unknown[]): this {
      this.ins[column] = values;
      return this;
    }

    or(condition: string): this {
      this.ors.push(condition);
      return this;
    }

    order(column: string): this {
      this.orders.push(column);
      return this;
    }

    limit(value: number): this {
      this.limitValue = value;
      return this;
    }

    private execute(): Promise<{ data: unknown; error: unknown }> {
      const call: QueryCall = {
        table: this.table,
        filters: { ...this.filters },
        ins: { ...this.ins },
        nots: [...this.nots],
        ors: [...this.ors],
        orders: [...this.orders],
        limit: this.limitValue,
        select: this.selectClause,
      };
      calls.push(call);
      const handler = handlers[`${this.table}:select`];
      if (handler === undefined) throw new Error(`Unexpected query: ${this.table}`);
      const result = handler(call);
      const raw = result.data ?? null;
      const data = this.mode === 'maybeSingle' && Array.isArray(raw) ? (raw[0] ?? null) : raw;
      return Promise.resolve({ data, error: result.error ?? null });
    }

    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return this.execute().then(onfulfilled, onrejected);
    }

    maybeSingle(): Promise<{ data: unknown; error: unknown }> {
      this.mode = 'maybeSingle';
      return this.execute();
    }
  }

  return {
    db: {
      from(table: string) {
        return new FakeQuery(table, '');
      },
    } as unknown as Db,
    calls,
  };
}

const CLUB_A: Row = {
  id: 'club-a',
  guild_id: 'guild-1',
  tag: '2C0Y',
  name: 'Alpha',
  description: 'Alpha club',
  trophies: 1000,
  required_trophies: 500,
  member_count: 2,
  last_synced_at: null,
};

const CLUB_B: Row = {
  id: 'club-b',
  guild_id: 'guild-1',
  tag: 'Q8VR',
  name: 'Bravo',
  description: 'Bravo club',
  trophies: 900,
  required_trophies: 400,
  member_count: 2,
  last_synced_at: null,
};

function run(id: string, finishedAt: string, club: Row): Row {
  return {
    id,
    status: 'completed',
    started_at: finishedAt,
    finished_at: finishedAt,
    affected_club_ids: [club['id']],
    club_tags: [club['tag']],
  };
}

const RUN_1: Row = {
  id: 'run-1',
  status: 'completed',
  started_at: '2026-11-01T00:00:00.000Z',
  finished_at: '2026-11-01T00:05:00.000Z',
  affected_club_ids: [CLUB_A['id'], CLUB_B['id']],
  club_tags: [CLUB_A['tag'], CLUB_B['tag']],
};

const RUN_WEEK = run('run-week', '2026-11-16T00:05:00.000Z', CLUB_A);
const RUN_2 = run('run-2', '2026-11-18T06:05:00.000Z', CLUB_A);
const RUN_3 = run('run-3', '2026-11-17T06:05:00.000Z', CLUB_B);

function snapshot(
  id: string,
  runId: string,
  capturedAt: string,
  trophies: number,
  members: readonly Row[],
): Row {
  return {
    id,
    sync_run_id: runId,
    captured_at: capturedAt,
    trophies,
    member_count: members.length,
    raw: { description: 'Stored description', members: [...members] },
  };
}

function member(tag: string, name: string, trophies: number | null, role: string): Row {
  return { tag, name, trophies, role };
}

const SNAPSHOT_A_1 = snapshot('a1', 'run-1', '2026-11-01T00:00:00.000Z', 1000, [
  member('G2P9', 'Alpha Leader', 800, 'president'),
  member('Q8VR', 'Alpha Senior', 600, 'senior'),
]);
const SNAPSHOT_A_WEEK = snapshot('aw', 'run-week', '2026-11-16T00:00:00.000Z', 1100, [
  member('G2P9', 'Alpha Leader', 900, 'president'),
  member('Q8VR', 'Alpha Senior', 700, 'senior'),
]);
const SNAPSHOT_A_2 = snapshot('a2', 'run-2', '2026-11-18T06:00:00.000Z', 1200, [
  member('G2P9', 'Alpha Leader', 1000, 'president'),
  member('Q8VR', 'Alpha Senior', 800, 'senior'),
]);
const SNAPSHOT_B_1 = snapshot('b1', 'run-1', '2026-11-01T00:00:00.000Z', 900, [
  member('P9LQ', 'Bravo Leader', 700, 'president'),
  member('U8YQ', 'Bravo Member', 500, 'member'),
]);
const SNAPSHOT_B_3 = snapshot('b3', 'run-3', '2026-11-17T06:00:00.000Z', 950, [
  member('P9LQ', 'Bravo Leader', 750, 'president'),
  member('U8YQ', 'Bravo Member', 550, 'member'),
]);

const PLAYERS: Row[] = [
  { id: 'p1', tag: 'G2P9', name: 'Alpha Leader', trophies: 1000, highest_trophies: 1050 },
  { id: 'p2', tag: 'Q8VR', name: 'Alpha Senior', trophies: 800, highest_trophies: 850 },
  { id: 'p3', tag: 'P9LQ', name: 'Bravo Leader', trophies: 750, highest_trophies: 800 },
  { id: 'p4', tag: 'U8YQ', name: 'Bravo Member', trophies: 550, highest_trophies: 600 },
];

function playerSnapshot(id: string, playerId: string, runId: string, capturedAt: string, trophies: number): Row {
  return {
    id,
    player_id: playerId,
    sync_run_id: runId,
    captured_at: capturedAt,
    trophies,
  };
}

const PLAYER_SNAPSHOTS: Row[] = [
  playerSnapshot('ps1', 'p1', 'run-1', '2026-11-01T00:00:00.000Z', 800),
  playerSnapshot('ps2', 'p1', 'run-week', '2026-11-16T00:00:00.000Z', 900),
  playerSnapshot('ps3', 'p1', 'run-2', '2026-11-18T06:00:00.000Z', 1000),
  playerSnapshot('ps4', 'p2', 'run-1', '2026-11-01T00:00:00.000Z', 600),
  playerSnapshot('ps5', 'p2', 'run-week', '2026-11-16T00:00:00.000Z', 700),
  playerSnapshot('ps6', 'p2', 'run-2', '2026-11-18T06:00:00.000Z', 800),
  playerSnapshot('ps7', 'p3', 'run-1', '2026-11-01T00:00:00.000Z', 700),
  playerSnapshot('ps8', 'p3', 'run-3', '2026-11-17T06:00:00.000Z', 750),
  playerSnapshot('ps9', 'p4', 'run-1', '2026-11-01T00:00:00.000Z', 500),
  playerSnapshot('ps10', 'p4', 'run-3', '2026-11-17T06:00:00.000Z', 550),
];

const EVENTS: Row[] = [
  {
    id: 'event-recent',
    event_type: 'join',
    detected_at: '2026-11-17T12:00:00.000Z',
    player: { tag: 'P9LQ', name: 'Bravo Leader' },
  },
  {
    id: 'event-old',
    event_type: 'join',
    detected_at: '2026-10-25T00:00:00.000Z',
    player: { tag: 'G2P9', name: 'Alpha Leader' },
  },
];

const FULL_SNAPSHOTS: Readonly<Record<string, Row[]>> = {
  [String(CLUB_A['id'])]: [SNAPSHOT_A_1, SNAPSHOT_A_WEEK, SNAPSHOT_A_2],
  [String(CLUB_B['id'])]: [SNAPSHOT_B_1, SNAPSHOT_B_3],
};

const NOW = new Date('2026-11-18T12:00:00.000Z');
const SEASON_START = '2026-11-01T00:00:00.000Z';

beforeEach(() => {
  mocks.createBrawlStarsClient.mockClear();
});

describe('advanced club loaders', () => {
  it('handles an empty stored roster without querying player details or the API', async () => {
    const { db, calls } = createFakeDb({
      snapshotsByClub: {
        [String(CLUB_A['id'])]: [snapshot('empty', 'run-2', '2026-11-18T06:00:00.000Z', 1200, [])],
      },
    });

    const result = await loadMemberView({ tag: CLUB_A.tag as string }, { db });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.members).toEqual([]);
    expect(result.value.rosterSource).toBe('none');
    expect(calls.some((call) => call.table === 'players')).toBe(false);
    expect(mocks.createBrawlStarsClient).not.toHaveBeenCalled();
  });

  it('sorts an incomplete roster safely and keeps missing player information nullable', async () => {
    const partialSnapshot = snapshot('partial', 'run-2', '2026-11-18T06:00:00.000Z', 1200, [
      member('G2P9', 'Alpha Leader', 1000, 'president'),
      member('P9LQ', 'Missing Player Row', 500, 'member'),
      member('Q8VR', 'Unknown Trophies', null, 'senior'),
      member('BAD', 'Invalid Tag', 999, 'member'),
    ]);
    const { db, calls } = createFakeDb({
      snapshotsByClub: { [String(CLUB_A['id'])]: [partialSnapshot] },
      players: PLAYERS.slice(0, 2),
    });

    const result = await loadMemberView({ tag: CLUB_A.tag as string }, { db });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.members.map((entry) => entry.tag)).toEqual(['G2P9', 'P9LQ', 'Q8VR']);
    expect(result.value.members[0]).toMatchObject({ playerId: 'p1', highestTrophies: 1050 });
    expect(result.value.members[1]).toMatchObject({
      playerId: null,
      highestTrophies: null,
      trophies: 500,
    });
    expect(result.value.members[2]).toMatchObject({ trophies: null, highestTrophies: 850 });
    expect(calls.find((call) => call.table === 'players')?.ins['tag']).toEqual([
      'G2P9',
      'P9LQ',
      'Q8VR',
    ]);
    expect(mocks.createBrawlStarsClient).not.toHaveBeenCalled();
  });

  it('ranks leaderboard entries and adds stored player progression', async () => {
    const { db } = createFakeDb({ snapshotsByClub: FULL_SNAPSHOTS });

    const result = await loadLeaderboardView(
      {
        tag: CLUB_A.tag as string,
        now: NOW,
        seasonStartIso: SEASON_START,
      },
      { db },
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.entries.map((entry) => [entry.rank, entry.tag])).toEqual([
      [1, 'G2P9'],
      [2, 'Q8VR'],
    ]);
    expect(result.value.entries[0]?.trophies).toBe(1000);
    expect(result.value.entries[0]?.progression).toEqual({ today: 100, week: 100, season: 200 });
    expect(mocks.createBrawlStarsClient).not.toHaveBeenCalled();
  });

  it('filters history to the selected period and calculates stored changes', async () => {
    const { db } = createFakeDb({ snapshotsByClub: FULL_SNAPSHOTS });

    const week = await loadHistoryView(
      { tag: CLUB_A.tag as string, period: '7d', now: NOW, seasonStartIso: SEASON_START },
      { db },
    );
    const all = await loadHistoryView(
      { tag: CLUB_A.tag as string, period: 'all', now: NOW, seasonStartIso: SEASON_START },
      { db },
    );

    expect(week.kind).toBe('ok');
    expect(all.kind).toBe('ok');
    if (week.kind !== 'ok' || all.kind !== 'ok') return;
    expect(week.value.points).toHaveLength(2);
    expect(week.value.change).toEqual({ trophies: 100, averageTrophies: 100, memberCount: 0 });
    expect(all.value.points).toHaveLength(3);
    expect(all.value.change).toEqual({ trophies: 200, averageTrophies: 200, memberCount: 0 });
    expect(all.value.latestSnapshotAt).toBe('2026-11-18T06:00:00.000Z');
    expect(all.value.rangeStart).toBe('2026-11-01T00:00:00.000Z');
    expect(all.value.progression).toEqual({ today: 100, week: 100, season: 200 });
    expect(week.value.membershipChanges.map((change) => change.detectedAt)).toEqual([
      '2026-11-17T12:00:00.000Z',
    ]);
    expect(all.value.membershipChanges.map((change) => change.detectedAt)).toEqual([
      '2026-11-17T12:00:00.000Z',
      '2026-10-25T00:00:00.000Z',
    ]);
    expect(mocks.createBrawlStarsClient).not.toHaveBeenCalled();
  });

  it('handles clubs with no stored history and no membership events', async () => {
    const { db } = createFakeDb({
      snapshotsByClub: { [String(CLUB_A['id'])]: [] },
      events: [],
    });

    const result = await loadHistoryView(
      { tag: CLUB_A.tag as string, period: '30d', now: NOW },
      { db },
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.points).toEqual([]);
    expect(result.value.change).toBeNull();
    expect(result.value.progression).toBeNull();
    expect(result.value.rangeStart).toBeNull();
    expect(result.value.latestSnapshotAt).toBeNull();
    expect(result.value.membershipChanges).toEqual([]);
  });

  it('compares two clubs from the latest shared completed sync when possible', async () => {
    const { db } = createFakeDb({ snapshotsByClub: FULL_SNAPSHOTS });

    const result = await loadCompareView(
      {
        firstTag: CLUB_A.tag as string,
        secondTag: CLUB_B.tag as string,
        now: NOW,
        seasonStartIso: SEASON_START,
      },
      { db },
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.aligned).toBe(true);
    expect(result.value.first.syncRunId).toBe('run-1');
    expect(result.value.second.syncRunId).toBe('run-1');
    expect(result.value.first.trophies).toBe(1000);
    expect(result.value.second.trophies).toBe(900);
    expect(result.value.first.averageTrophies).toBe(700);
    expect(result.value.second.averageTrophies).toBe(600);
    expect(result.value.first.highestTrophies).toBe(800);
    expect(result.value.second.lowestTrophies).toBe(500);
    expect(result.value.first.latestSyncAt).toBe(RUN_2['finished_at']);
    expect(result.value.second.latestSyncAt).toBe(RUN_3['finished_at']);
    expect(mocks.createBrawlStarsClient).not.toHaveBeenCalled();
  });

  it('marks comparisons unaligned when only different completed snapshots exist', async () => {
    const { db } = createFakeDb({
      snapshotsByClub: {
        [String(CLUB_A['id'])]: [SNAPSHOT_A_2],
        [String(CLUB_B['id'])]: [SNAPSHOT_B_3],
      },
    });

    const result = await loadCompareView(
      { firstTag: CLUB_A.tag as string, secondTag: CLUB_B.tag as string, now: NOW },
      { db },
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.aligned).toBe(false);
    expect(result.value.first.snapshotAt).toBe('2026-11-18T06:00:00.000Z');
    expect(result.value.second.snapshotAt).toBe('2026-11-17T06:00:00.000Z');
    expect(result.value.first.trophies).toBe(1200);
    expect(result.value.second.trophies).toBe(950);
  });

  it('rejects self-comparison before querying the database', async () => {
    const { db, calls } = createFakeDb();

    const result = await loadCompareView(
      { firstTag: '#2c0y', secondTag: '2C0Y' },
      { db },
    );

    expect(result).toEqual({ kind: 'same-club' });
    expect(calls).toEqual([]);
  });

  it('rejects invalid and unregistered tags without calling the API', async () => {
    const { db, calls } = createFakeDb({ clubs: [] });

    await expect(loadSyncedClub({ tag: '#BAD-TAG!' }, { db })).resolves.toEqual({
      kind: 'invalid-tag',
    });
    await expect(loadMemberView({ tag: 'G2P9' }, { db })).resolves.toEqual({
      kind: 'unregistered',
      tag: 'G2P9',
    });

    expect(calls.every((call) => call.table === 'clubs')).toBe(true);
    expect(mocks.createBrawlStarsClient).not.toHaveBeenCalled();
  });

  it('uses the only registered guild club when no tag is supplied', async () => {
    const { db } = createFakeDb({
      clubs: [CLUB_B],
      snapshotsByClub: FULL_SNAPSHOTS,
    });

    const result = await loadSyncedClub({ guildId: 'guild-1' }, { db });

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.club.id).toBe(CLUB_B['id']);
  });

  it('surfaces database errors without leaking details to Discord-facing callers', async () => {
    const playerFailure = createFakeDb({
      snapshotsByClub: FULL_SNAPSHOTS,
      errors: { players: 'connection reset' },
    });
    await expect(loadMemberView({ tag: CLUB_A.tag as string }, { db: playerFailure.db })).rejects.toThrow(
      'Read player details failed',
    );

    const historyFailure = createFakeDb({
      snapshotsByClub: FULL_SNAPSHOTS,
      errors: { player_snapshots: 'query timeout' },
    });
    await expect(
      loadLeaderboardView(
        { tag: CLUB_A.tag as string, now: NOW, seasonStartIso: SEASON_START },
        { db: historyFailure.db },
      ),
    ).rejects.toThrow('Read player history failed');

    const eventFailure = createFakeDb({
      snapshotsByClub: FULL_SNAPSHOTS,
      errors: { membership_events: 'permission denied' },
    });
    await expect(
      loadHistoryView({ tag: CLUB_A.tag as string, period: 'all', now: NOW }, { db: eventFailure.db }),
    ).rejects.toThrow('Read membership history failed');
  });

  it('hides archived clubs and keeps club reads within the invoking guild', async () => {
    const archived = {
      ...CLUB_A,
      id: 'club-archived',
      tag: 'C8L',
      name: 'Archived',
      archived_at: '2026-11-18T00:00:00.000Z',
    };
    const otherGuild = {
      ...CLUB_B,
      id: 'club-other',
      tag: 'QVY',
      name: 'Other',
      guild_id: 'guild-2',
    };
    const { db, calls } = createFakeDb({
      clubs: [CLUB_A, archived, otherGuild],
      snapshotsByClub: FULL_SNAPSHOTS,
    });

    const result = await loadSyncedClub({ guildId: 'guild-1' }, { db });

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.club.id).toBe(CLUB_A['id']);
    expect(
      calls.some(
        (call) =>
          call.table === 'clubs' &&
          call.filters['archived_at'] === null &&
          call.filters['guild_id'] === 'guild-1',
      ),
    ).toBe(true);
    await expect(loadSyncedClub({ tag: 'C8L', guildId: 'guild-1' }, { db })).resolves.toEqual({
      kind: 'unregistered',
      tag: 'C8L',
    });
    await expect(loadSyncedClub({ tag: 'QVY', guildId: 'guild-1' }, { db })).resolves.toEqual({
      kind: 'unregistered',
      tag: 'QVY',
    });
  });

  it('sorts and filters member details using stored values only', async () => {
    const players: Row[] = [
      {
        ...(PLAYERS[0] ?? {}),
        last_battle_at: '2026-11-18T10:00:00.000Z',
        ranked_rank_name: 'Gold I',
        highest_all_time_ranked_rank_name: null,
        solo_victories: 12,
        duo_victories: null,
        three_vs_three_victories: 4,
      },
      {
        ...(PLAYERS[1] ?? {}),
        last_battle_at: null,
        ranked_rank_name: null,
        highest_all_time_ranked_rank_name: 'Mythic II',
        solo_victories: null,
        duo_victories: 7,
        three_vs_three_victories: null,
      },
    ];
    const { db, calls } = createFakeDb({
      snapshotsByClub: FULL_SNAPSHOTS,
      players,
      membershipRows: [{ player_id: 'p1', valid_from: '2026-11-10T00:00:00.000Z' }],
      verifications: [{ player_id: 'p1' }],
    });

    const ranked = await loadClubMemberDetails(
      {
        tag: '2C0Y',
        sort: 'highest',
        filter: 'ranked',
        now: NOW,
        seasonStartIso: SEASON_START,
      },
      { db },
    );

    expect(ranked.kind).toBe('ok');
    if (ranked.kind !== 'ok') return;
    expect(ranked.value.members.map((member) => member.tag)).toEqual(['G2P9']);
    expect(ranked.value.members[0]).toMatchObject({
      rankedRankName: 'Gold I',
      verified: true,
      joinedAt: '2026-11-10T00:00:00.000Z',
    });
    expect(
      calls.some(
        (call) => call.table === 'player_verifications' && call.filters['status'] === 'active',
      ),
    ).toBe(true);
    expect(mocks.createBrawlStarsClient).not.toHaveBeenCalled();

    const byName = await loadClubMemberDetails({ tag: '2C0Y', sort: 'name' }, { db });
    expect(byName.kind).toBe('ok');
    if (byName.kind === 'ok') {
      expect(byName.value.members.map((member) => member.tag)).toEqual(['G2P9', 'Q8VR']);
    }
  });

  it('loads previous members only from closed, guild-scoped memberships', async () => {
    const { db, calls } = createFakeDb({
      membershipRows: [
        {
          player_id: 'p1',
          role: 'member',
          valid_to: '2026-11-16T00:00:00.000Z',
          player: { tag: 'G2P9', name: 'Alpha Leader', trophies: 1050 },
        },
        {
          player_id: 'p2',
          role: 'senior',
          valid_to: null,
          player: { tag: 'Q8VR', name: 'Alpha Senior', trophies: 850 },
        },
      ],
      snapshotsByClub: FULL_SNAPSHOTS,
    });

    const result = await loadClubPreviousMembers({ tag: '2C0Y', guildId: 'guild-1' }, { db });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.previous).toEqual([
      {
        playerId: 'p1',
        tag: 'G2P9',
        name: 'Alpha Leader',
        trophies: 1050,
        role: 'member',
        leftAt: '2026-11-16T00:00:00.000Z',
      },
    ]);
    expect(
      calls.some(
        (call) => call.table === 'club_memberships' && call.filters['club_id'] === CLUB_A['id'],
      ),
    ).toBe(true);
  });
});
