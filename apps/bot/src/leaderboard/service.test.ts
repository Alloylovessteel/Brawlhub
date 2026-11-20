import { describe, expect, it } from 'vitest';
import {
  loadClubLeaderboard,
  loadPlayerLeaderboard,
  loadProgressionLeaderboard,
  loadTrophyLeaderboard,
} from './service';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface Call {
  readonly table: string;
  readonly filters: Row;
  readonly orders: number;
  readonly limit: number | null;
}

/** Read-only fake: no insert/update/delete methods exist on purpose. */
function createFakeDb(tables: Tables, failingTables: readonly string[] = []) {
  const calls: Call[] = [];

  function from(table: string) {
    const state = {
      filters: {} as Row,
      orders: 0,
      limit: null as number | null,
      maybeSingle: false,
    };

    async function execute() {
      calls.push({
        table,
        filters: { ...state.filters },
        orders: state.orders,
        limit: state.limit,
      });
      if (failingTables.includes(table)) {
        return { data: null, error: { message: `${table} unavailable` } };
      }
      let result = [...(tables[table] ?? [])];
      for (const [field, value] of Object.entries(state.filters)) {
        result = result.filter((row) => (row[field] ?? null) === value);
      }
      if (state.limit !== null) result = result.slice(0, state.limit);
      return {
        data: state.maybeSingle ? (result[0] ?? null) : result,
        error: null,
      };
    }

    const builder = {
      select: () => builder,
      eq: (field: string, value: unknown) => {
        state.filters[field] = value;
        return builder;
      },
      is: (field: string, value: unknown) => {
        state.filters[field] = value;
        return builder;
      },
      order: () => {
        state.orders += 1;
        return builder;
      },
      limit: (value: number) => {
        state.limit = value;
        return builder;
      },
      maybeSingle: () => {
        state.maybeSingle = true;
        return execute();
      },
      then: (
        resolve: (value: { data: unknown; error: unknown }) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => execute().then(resolve, reject),
    };
    return builder;
  }

  return { from, calls };
}

const NOW = new Date('2026-11-18T12:00:00.000Z');
const RECENT = '2026-11-18T11:55:00.000Z';
const OLD = '2026-11-01T09:00:00.000Z';

const RUNS: Row[] = [
  run('run-0', '2026-09-01T00:00:00.000Z'),
  run('run-1', '2026-11-05T00:00:00.000Z'),
  run('run-2', '2026-11-10T00:00:00.000Z'),
  run('run-3', '2026-11-17T00:00:00.000Z'),
  {
    id: 'run-running', status: 'running',
    started_at: '2026-11-18T00:00:00.000Z', finished_at: null,
    affected_club_ids: [], club_tags: [],
  },
];

function run(id: string, finishedAt: string): Row {
  return {
    id,
    status: 'completed',
    started_at: finishedAt,
    finished_at: finishedAt.replace('00:00:00', '00:01:00'),
    affected_club_ids: [],
    club_tags: [],
  };
}

const CLUBS: Row[] = [
  club('club-a', '2C0Y', 'Alpha'),
  club('club-b', 'Q8VR', 'Bravo'),
  club('club-c', 'G2P9', 'Charlie'),
];

function club(id: string, tag: string, name: string): Row {
  return {
    id, tag, name, description: null, trophies: null,
    required_trophies: null, member_count: null, last_synced_at: null,
  };
}

const CLUB_SNAPSHOTS: Row[] = [
  clubSnapshot('cs1', 'club-a', 'run-1', '2026-11-05T00:00:00.000Z', 1_000_000, 20),
  clubSnapshot('cs2', 'club-a', 'run-3', '2026-11-17T00:00:00.000Z', 1_200_000, 30),
  clubSnapshot('cs3', 'club-b', 'run-2', '2026-11-10T00:00:00.000Z', 900_000, 30),
  clubSnapshot('cs4', 'club-b', 'run-running', '2026-11-18T00:00:00.000Z', 9_999_999, 30),
  clubSnapshot('cs5', 'club-c', 'run-1', '2026-11-05T00:00:00.000Z', null, 30),
];

function clubSnapshot(
  id: string,
  clubId: string,
  syncRunId: string,
  capturedAt: string,
  trophies: number | null,
  memberCount: number | null,
): Row {
  return { id, club_id: clubId, sync_run_id: syncRunId, captured_at: capturedAt, trophies, member_count: memberCount, raw: null };
}

const PLAYERS: Row[] = [
  player('p1', '2C0Y', 'Alpha', 5000, 5200, RECENT),
  player('p2', 'Q8VR', 'Bravo', 5000, null, RECENT),
  player('p3', 'G2P9', 'Charlie', null, null, null),
  player('p4', 'P9Q8', 'Delta', 4500, 4800, OLD),
  player('p5', '2c0y', 'Alpha Duplicate', 9999, 9999, RECENT),
  player('p6', 'V9L2', 'Echo', null, null, null),
];

function player(
  id: string,
  tag: string,
  name: string,
  trophies: number | null,
  highestTrophies: number | null,
  lastSyncedAt: string | null,
): Row {
  return {
    id, tag, name, trophies, highest_trophies: highestTrophies,
    exp_level: null, last_synced_at: lastSyncedAt,
  };
}

const CLUB_A = { id: 'club-a', tag: '2C0Y', name: 'Alpha Club' };
const CLUB_B = { id: 'club-b', tag: 'Q8VR', name: 'Bravo Club' };

const MEMBERSHIPS: Row[] = [
  membership('m1', 'p1', CLUB_A, '2026-11-01T00:00:00.000Z', null),
  membership('m2', 'p1', CLUB_B, '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z'),
  membership('m3', 'p2', CLUB_B, '2026-11-10T00:00:00.000Z', null),
  membership('m4', 'p3', CLUB_A, null, null),
  membership('m5', 'p4', CLUB_A, '2026-11-01T00:00:00.000Z', null),
];

function membership(
  id: string,
  playerId: string,
  clubRef: Row,
  validFrom: string | null,
  validTo: string | null,
): Row {
  return {
    id,
    player_id: playerId,
    club_id: clubRef['id'],
    role: 'member',
    valid_from: validFrom,
    valid_to: validTo,
    club: clubRef,
  };
}

const PLAYER_SNAPSHOTS: Row[] = [
  playerSnapshot('ps1a', 'p1', 'run-0', '2026-09-01T00:00:00.000Z', 4000),
  playerSnapshot('ps1b', 'p1', 'run-1', '2026-11-05T00:00:00.000Z', 4700),
  playerSnapshot('ps1c', 'p1', 'run-2', '2026-11-12T00:00:00.000Z', 4850),
  playerSnapshot('ps1d', 'p1', 'run-3', '2026-11-17T00:00:00.000Z', 5000),
  playerSnapshot('ps1null', 'p1', 'run-3', '2026-11-18T00:00:00.000Z', null),
  playerSnapshot('ps2a', 'p2', 'run-0', '2026-09-01T00:00:00.000Z', 3500),
  playerSnapshot('ps2b', 'p2', 'run-1', '2026-11-05T00:00:00.000Z', 4100),
  playerSnapshot('ps2c', 'p2', 'run-2', '2026-11-12T00:00:00.000Z', 4300),
  playerSnapshot('ps2d', 'p2', 'run-3', '2026-11-17T00:00:00.000Z', 5000),
  playerSnapshot('ps3a', 'p3', 'run-1', '2026-11-05T00:00:00.000Z', 6000),
  playerSnapshot('ps4a', 'p4', 'run-1', '2026-11-05T00:00:00.000Z', 4200),
  playerSnapshot('ps4b', 'p4', 'run-3', '2026-11-17T00:00:00.000Z', 4500),
  playerSnapshot('ps4running', 'p4', 'run-running', '2026-11-18T00:00:00.000Z', 9999),
  playerSnapshot('ps5a', 'p5', 'run-3', '2026-11-17T00:00:00.000Z', 9999),
];

function playerSnapshot(
  id: string,
  playerId: string,
  syncRunId: string,
  capturedAt: string,
  trophies: number | null,
): Row {
  return { id, player_id: playerId, sync_run_id: syncRunId, captured_at: capturedAt, trophies };
}

function tables(): Tables {
  return {
    clubs: CLUBS.map((row) => ({ ...row })),
    sync_runs: RUNS.map((row) => ({ ...row })),
    club_snapshots: CLUB_SNAPSHOTS.map((row) => ({ ...row })),
    players: PLAYERS.map((row) => ({ ...row })),
    club_memberships: MEMBERSHIPS.map((row) => ({ ...row })),
    player_snapshots: PLAYER_SNAPSHOTS.map((row) => ({ ...row })),
  };
}

describe('global leaderboard services', () => {
  it('ranks registered clubs by their latest valid completed snapshot', async () => {
    const db = createFakeDb(tables());
    const result = await loadClubLeaderboard({ db: db as never, now: NOW });

    expect(
      result.rows.map((row) => [row.club.tag, row.totalTrophies, row.rank, row.memberCount]),
    ).toEqual([
      ['2C0Y', 1_200_000, 1, 30],
      ['Q8VR', 900_000, 2, 30],
    ]);
    expect(result.rows[0]?.averageTrophies).toBe(40_000);
    expect(result.rows[0]?.snapshotAt).toBe('2026-11-17T00:00:00.000Z');
    expect(result.warning).toContain('different times');
    expect(db.calls.some((call) => call.table === 'club_snapshots')).toBe(true);
  });

  it('ranks valid current trophies, deduplicates tags and prefers current memberships', async () => {
    const db = createFakeDb(tables());
    const result = await loadPlayerLeaderboard({ db: db as never, now: NOW });

    expect(
      result.rows.map((row) => [
        row.player.tag, row.trophies, row.rank, row.club?.tag ?? null, row.clubStatus,
      ]),
    ).toEqual([
      ['2C0Y', 5000, 1, '2C0Y', 'current'],
      ['Q8VR', 5000, 1, 'Q8VR', 'current'],
      ['P9Q8', 4500, 3, '2C0Y', 'last-recorded'],
    ]);
    expect(result.warning).toContain('different times');
  });

  it('ranks recorded personal bests without treating missing values as zero', async () => {
    const db = createFakeDb(tables());
    const result = await loadTrophyLeaderboard({ db: db as never, now: NOW });

    expect(
      result.rows.map((row) => [
        row.player.tag, row.highestTrophies, row.currentTrophies, row.rank,
      ]),
    ).toEqual([
      ['G2P9', 6000, null, 1],
      ['2C0Y', 5200, 5000, 2],
      ['Q8VR', 5000, 5000, 3],
      ['P9Q8', 4800, 4500, 4],
    ]);
  });

  it('ranks real gains for each period and excludes insufficient history', async () => {
    const db = createFakeDb(tables());
    const options = { db: db as never, now: NOW };

    const sevenDays = await loadProgressionLeaderboard({ period: '7d' }, options);
    expect(
      sevenDays.rows.map((row) => [row.player.tag, row.difference, row.rank, row.startTrophies]),
    ).toEqual([
      ['Q8VR', 700, 1, 4300],
      ['2C0Y', 150, 2, 4850],
    ]);
    expect(sevenDays.warning).toBeNull();

    const thirtyDays = await loadProgressionLeaderboard({ period: '30d' }, options);
    expect(
      thirtyDays.rows.map((row) => [row.player.tag, row.difference, row.rank]),
    ).toEqual([
      ['Q8VR', 900, 1],
      ['2C0Y', 300, 2],
      ['P9Q8', 300, 2],
    ]);
    expect(thirtyDays.warning).toBeNull();

    const ninetyDays = await loadProgressionLeaderboard({ period: '90d' }, options);
    expect(
      ninetyDays.rows.map((row) => [row.player.tag, row.difference, row.rank]),
    ).toEqual([
      ['Q8VR', 1500, 1],
      ['2C0Y', 1000, 2],
      ['P9Q8', 300, 3],
    ]);
    expect(ninetyDays.warning).toContain('different times');
    expect(ninetyDays.rows.every((row) => row.syncRunId === 'run-3')).toBe(true);
  });

  it('returns empty views when no stored data is available', async () => {
    const db = createFakeDb({});
    const options = { db: db as never, now: NOW };

    await expect(loadClubLeaderboard(options)).resolves.toMatchObject({ rows: [] });
    await expect(loadPlayerLeaderboard(options)).resolves.toMatchObject({ rows: [] });
    await expect(loadTrophyLeaderboard(options)).resolves.toMatchObject({ rows: [] });
    await expect(
      loadProgressionLeaderboard({ period: '30d' }, options),
    ).resolves.toMatchObject({ period: '30d', rows: [] });
  });

  it('rejects unsupported progression periods and propagates database failures', async () => {
    const db = createFakeDb(tables());

    await expect(
      loadProgressionLeaderboard({ period: 'all' as never }, { db: db as never, now: NOW }),
    ).rejects.toThrow('Unsupported progression period');
    await expect(
      loadPlayerLeaderboard({ db: createFakeDb(tables(), ['players']) as never, now: NOW }),
    ).rejects.toThrow('Read players failed');
  });
});
