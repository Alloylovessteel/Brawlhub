import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createBrawlStarsClient: vi.fn(() => {
    throw new Error('Unexpected creation of a Brawl Stars API client');
  }),
  getSharedBrawlStarsClient: vi.fn(() => {
    throw new Error('Unexpected use of the shared Brawl Stars API client');
  }),
}));

vi.mock('@brawlhub/brawl-stars', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brawlhub/brawl-stars')>();
  return {
    ...actual,
    createBrawlStarsClient: mocks.createBrawlStarsClient,
    getSharedBrawlStarsClient: mocks.getSharedBrawlStarsClient,
  };
});

import { BrawlStarsApiError } from '@brawlhub/brawl-stars';
import {
  clearPlayerApiCache,
  loadPlayerBattles,
  loadPlayerClubs,
  loadPlayerCompare,
  loadPlayerHistory,
  loadPlayerProfile,
  searchPlayers,
} from './service';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface Call {
  readonly table: string;
  readonly filters: Row;
  readonly ins: Record<string, unknown[]>;
  readonly nulls: string[];
  readonly or: string | null;
  readonly gte: { field: string; value: unknown } | null;
  readonly orders: number;
  readonly limit: number | null;
  readonly maybeSingle: boolean;
}

interface RpcCall {
  readonly name: string;
  readonly args: Row;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function normalizedTag(value: unknown): string {
  return asText(value)?.trim().replace(/^#+/, '').toUpperCase() ?? '';
}

function clubScopedPlayerIds(tables: Tables, clubIds: readonly string[]): Set<string> {
  const allowedClubs = new Set(clubIds);
  const ids = new Set<string>();
  for (const row of tables['club_memberships'] ?? []) {
    if (!allowedClubs.has(String(row['club_id']))) continue;
    const playerId = asText(row['player_id']);
    if (playerId !== null) ids.add(playerId);
  }
  return ids;
}

function createFakeDb(tables: Tables, failingTables: readonly string[] = []) {
  const calls: Call[] = [];

  function from(table: string) {
    const state = {
      filters: {} as Row,
      ins: {} as Record<string, unknown[]>,
      nulls: [] as string[],
      or: null as string | null,
      gte: null as { field: string; value: unknown } | null,
      orders: 0,
      limit: null as number | null,
      maybeSingle: false,
    };

    function rows(): Row[] {
      let result = [...(tables[table] ?? [])];
      for (const [field, value] of Object.entries(state.filters)) {
        result = result.filter((row) => row[field] === value);
      }
      for (const [field, values] of Object.entries(state.ins)) {
        result = result.filter((row) => values.includes(row[field]));
      }
      for (const field of state.nulls) {
        result = result.filter((row) => row[field] === null);
      }
      if (state.or !== null) {
        const needle = state.or.match(/ilike\.%([^%]+)%/)?.[1]?.replace(/\\(.)/g, '$1') ?? '';
        result = result.filter((row) =>
          `${String(row['tag'] ?? '')} ${String(row['name'] ?? '')}`
            .toLowerCase()
            .includes(needle.toLowerCase()),
        );
      }
      if (state.gte !== null) {
        result = result.filter((row) => String(row[state.gte!.field] ?? '') >= String(state.gte!.value));
      }
      if (state.limit !== null) result = result.slice(0, state.limit);
      return result;
    }

    async function execute() {
      calls.push({
        table,
        filters: { ...state.filters },
        ins: { ...state.ins },
        nulls: [...state.nulls],
        or: state.or,
        gte: state.gte,
        orders: state.orders,
        limit: state.limit,
        maybeSingle: state.maybeSingle,
      });
      if (failingTables.includes(table)) {
        return { data: null, error: { message: `${table} unavailable` } };
      }
      const result = rows();
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
      in: (field: string, values: readonly unknown[]) => {
        state.ins[field] = [...values];
        return builder;
      },
      is: (field: string, value: unknown) => {
        if (value === null) state.nulls.push(field);
        else state.filters[field] = value;
        return builder;
      },
      or: (expression: string) => {
        state.or = expression;
        return builder;
      },
      gte: (field: string, value: unknown) => {
        state.gte = { field, value };
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
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        execute().then(resolve, reject),
    };
    return builder;
  }

  const rpcCalls: RpcCall[] = [];

  async function rpc(name: string, args: Row = {}) {
    rpcCalls.push({ name, args: { ...args } });
    if (failingTables.includes('players') && (name === 'player_search_scoped' || name === 'player_lookup_scoped_by_tag')) {
      return { data: null, error: { message: 'players unavailable' } };
    }

    if (name === 'player_search_scoped') {
      const clubIds = (Array.isArray(args['p_club_ids']) ? args['p_club_ids'] : []).map(String);
      const allowedPlayers = clubScopedPlayerIds(tables, clubIds);
      const query = asText(args['p_search'])?.trim().replace(/^#+/, '').toLowerCase() ?? '';
      let rows = (tables['players'] ?? []).filter((row) => {
        if (!allowedPlayers.has(String(row['id']))) return false;
        if (query === '') return true;
        return `${asText(row['tag']) ?? ''} ${asText(row['name']) ?? ''}`.toLowerCase().includes(query);
      });
      rows = rows.sort((a, b) =>
        String(a['name']).localeCompare(String(b['name'])) ||
        String(a['id']).localeCompare(String(b['id'])),
      );
      const afterName = asText(args['p_after_name']);
      const afterId = asText(args['p_after_id']);
      if (afterName !== null) {
        rows = rows.filter((row) =>
          String(row['name']) > afterName ||
          (String(row['name']) === afterName && afterId !== null && String(row['id']) > afterId),
        );
      }
      const limit = Math.min(Math.max(Number(args['p_limit'] ?? 25), 1), 25);
      return {
        data: rows.slice(0, limit).map((player) => ({ player })),
        error: null,
      };
    }

    if (name === 'player_lookup_scoped_by_tag') {
      const clubIds = (Array.isArray(args['p_club_ids']) ? args['p_club_ids'] : []).map(String);
      const allowedPlayers = clubScopedPlayerIds(tables, clubIds);
      const wanted = normalizedTag(args['p_tag']);
      const player = (tables['players'] ?? []).find(
        (row) => normalizedTag(row['tag']) === wanted && allowedPlayers.has(String(row['id'])),
      );
      return { data: player === undefined ? [] : [{ player }], error: null };
    }

    if (name === 'player_snapshot_page') {
      const playerId = asText(args['p_player_id']);
      const playerIds = (Array.isArray(args['p_player_ids']) ? args['p_player_ids'] : []).map(String);
      const clubIds = (Array.isArray(args['p_club_ids']) ? args['p_club_ids'] : []).map(String);
      const scopedPlayers = clubScopedPlayerIds(tables, clubIds);
      const since = asText(args['p_since']);
      const completedOnly = args['p_completed_only'] === true;
      const completedRuns = new Set(
        (tables['sync_runs'] ?? [])
          .filter((row) => row['status'] === 'completed')
          .map((row) => String(row['id'])),
      );
      let rows = (tables['player_snapshots'] ?? []).filter((row) => {
        const id = String(row['player_id']);
        if (playerId !== null && id !== playerId) return false;
        if (playerIds.length > 0 && !playerIds.includes(id)) return false;
        if (clubIds.length > 0 && !scopedPlayers.has(id)) return false;
        if (playerId === null && playerIds.length === 0 && clubIds.length === 0) return false;
        if (since !== null && String(row['captured_at']) < since) return false;
        if (completedOnly && !completedRuns.has(String(row['sync_run_id']))) return false;
        return true;
      });
      const newestFirst = args['p_newest_first'] === true;
      rows = rows.sort((a, b) => {
        const byTime = String(a['captured_at']).localeCompare(String(b['captured_at']));
        const byId = String(a['id']).localeCompare(String(b['id']));
        return newestFirst ? -byTime || -byId : byTime || byId;
      });
      const afterCapturedAt = asText(args['p_after_captured_at']);
      const afterId = asText(args['p_after_id']);
      if (afterCapturedAt !== null && afterId !== null) {
        rows = rows.filter((row) => {
          const time = String(row['captured_at']);
          const id = String(row['id']);
          return newestFirst
            ? time < afterCapturedAt || (time === afterCapturedAt && id < afterId)
            : time > afterCapturedAt || (time === afterCapturedAt && id > afterId);
        });
      }
      const limit = Math.min(Math.max(Number(args['p_limit'] ?? 1000), 1), 1000);
      return { data: rows.slice(0, limit), error: null };
    }

    return { data: [], error: null };
  }

  return { from, rpc, calls, rpcCalls };
}

const NOW = new Date('2026-11-18T12:00:00.000Z');
const RECENT = '2026-11-18T11:55:00.000Z';
const OLD = '2026-11-01T09:00:00.000Z';

const PLAYERS: Row[] = [
  {
    id: 'p1', tag: '2C0Y', name: 'Alpha', trophies: 5000,
    highest_trophies: 5200, exp_level: 35, last_synced_at: RECENT,
  },
  {
    id: 'p2', tag: 'Q8VR', name: 'Bravo', trophies: 4500,
    highest_trophies: 4700, exp_level: 30, last_synced_at: RECENT,
  },
  {
    id: 'p3', tag: 'G2P9', name: 'Charlie', trophies: 3000,
    highest_trophies: null, exp_level: null, last_synced_at: null,
  },
];

const RUNS: Row[] = [
  { id: 'run-1', status: 'completed', started_at: '2026-11-05T00:00:00.000Z', finished_at: '2026-11-05T00:01:00.000Z', affected_club_ids: [], club_tags: [] },
  { id: 'run-2', status: 'completed', started_at: '2026-11-10T00:00:00.000Z', finished_at: '2026-11-10T00:01:00.000Z', affected_club_ids: [], club_tags: [] },
  { id: 'run-3', status: 'completed', started_at: '2026-11-17T00:00:00.000Z', finished_at: '2026-11-17T00:01:00.000Z', affected_club_ids: [], club_tags: [] },
  { id: 'run-solo', status: 'completed', started_at: '2026-11-05T00:00:00.000Z', finished_at: '2026-11-05T00:01:00.000Z', affected_club_ids: [], club_tags: [] },
  { id: 'run-running', status: 'running', started_at: '2026-11-18T00:00:00.000Z', finished_at: null, affected_club_ids: [], club_tags: [] },
];

const SNAPSHOTS: Row[] = [
  { id: 'ps1', player_id: 'p1', sync_run_id: 'run-1', captured_at: '2026-11-05T00:00:00.000Z', trophies: 4700 },
  { id: 'ps2', player_id: 'p1', sync_run_id: 'run-2', captured_at: '2026-11-10T00:00:00.000Z', trophies: 4850 },
  { id: 'ps3', player_id: 'p1', sync_run_id: 'run-3', captured_at: '2026-11-17T00:00:00.000Z', trophies: 5000 },
  { id: 'ps4a', player_id: 'p2', sync_run_id: 'run-1', captured_at: '2026-11-05T00:00:00.000Z', trophies: 4100 },
  { id: 'ps4', player_id: 'p2', sync_run_id: 'run-2', captured_at: '2026-11-10T00:00:00.000Z', trophies: 4300 },
  { id: 'ps5', player_id: 'p2', sync_run_id: 'run-3', captured_at: '2026-11-17T00:00:00.000Z', trophies: 4500 },
  { id: 'ps6', player_id: 'p3', sync_run_id: 'run-solo', captured_at: '2026-11-01T00:00:00.000Z', trophies: 2800 },
  { id: 'ps7', player_id: 'p1', sync_run_id: 'run-running', captured_at: '2026-11-18T00:00:00.000Z', trophies: 9999 },
];

const CLUB_A = { id: 'club-a', tag: '8QCL', name: 'Alpha Club' };
const CLUB_B = { id: 'club-b', tag: '2C0Y', name: 'Bravo Club' };

const MEMBERSHIPS: Row[] = [
  { id: 'm1', player_id: 'p1', club_id: 'club-a', role: 'president', valid_from: '2026-11-01T00:00:00.000Z', valid_to: null, club: CLUB_A },
  { id: 'm2', player_id: 'p1', club_id: 'club-b', role: 'member', valid_from: '2026-10-01T00:00:00.000Z', valid_to: '2026-11-01T00:00:00.000Z', club: CLUB_B },
  { id: 'm3', player_id: 'p2', club_id: 'club-b', role: 'member', valid_from: '2026-11-10T00:00:00.000Z', valid_to: null, club: CLUB_B },
  { id: 'm4', player_id: 'p3', club_id: 'club-a', role: null, valid_from: null, valid_to: null, club: CLUB_A },
  { id: 'm5', player_id: 'p1', club_id: 'club-a', role: 'member', valid_from: '2026-10-01T00:00:00.000Z', valid_to: '2026-11-01T00:00:00.000Z', club: CLUB_A },
];

const EVENTS: Row[] = [
  { id: 'e1', player_id: 'p1', event_type: 'transfer', detected_at: RECENT, from_club: CLUB_B, to_club: CLUB_A },
  { id: 'e2', player_id: 'p2', event_type: 'join', detected_at: '2026-11-10T00:00:00.000Z', from_club: null, to_club: CLUB_B },
  { id: 'e3', player_id: 'p3', event_type: 'leave', detected_at: '2026-11-11T00:00:00.000Z', from_club: CLUB_A, to_club: null },
];

const CLUBS: Row[] = [
  { id: 'club-a', guild_id: 'guild-1', tag: '8QCL', name: 'Alpha Club', archived_at: null },
  { id: 'club-b', guild_id: 'guild-2', tag: '2C0Y', name: 'Bravo Club', archived_at: null },
];

const BATTLES: Row[] = [
  { id: 'b1', player_id: 'p1', sync_run_id: 'run-3', battle_time: '2026-11-17T12:00:00.000Z', mode: 'gemGrab', map: 'Double Trouble', battle_type: 'ranked', result: 'victory', trophy_change: 8 },
  { id: 'b2', player_id: 'p1', sync_run_id: 'run-2', battle_time: '2026-11-10T12:00:00.000Z', mode: 'brawlBall', map: null, battle_type: 'ranked', result: 'defeat', trophy_change: -4 },
  { id: 'b3', player_id: 'p1', sync_run_id: 'run-1', battle_time: '2026-11-05T12:00:00.000Z', mode: 'showdown', map: null, battle_type: 'solo', result: 'victory', trophy_change: 5 },
  { id: 'b4', player_id: 'p1', sync_run_id: 'run-running', battle_time: '2026-11-18T11:00:00.000Z', mode: 'gemGrab', map: 'Double Trouble', battle_type: 'ranked', result: 'victory', trophy_change: 8 },
  { id: 'b5', player_id: 'p2', sync_run_id: 'run-3', battle_time: '2026-11-17T12:00:00.000Z', mode: 'gemGrab', map: 'Double Trouble', battle_type: 'ranked', result: 'victory', trophy_change: 8 },
];

function tables(): Tables {
  return {
    players: PLAYERS.map((row) => ({ ...row })),
    clubs: CLUBS.map((row) => ({ ...row })),
    sync_runs: RUNS.map((row) => ({ ...row })),
    player_snapshots: SNAPSHOTS.map((row) => ({ ...row })),
    player_battles: BATTLES.map((row) => ({ ...row })),
    club_memberships: MEMBERSHIPS.map((row) => ({ ...row })),
    membership_events: EVENTS.map((row) => ({ ...row })),
  };
}

function api(getPlayer: ReturnType<typeof vi.fn> = vi.fn(async () => ({
  tag: '#2C0Y',
  name: 'Live Alpha',
  trophies: 6100,
  highscore: 6300,
  expLevel: 40,
  club: { tag: '#8QCL', name: 'Alpha Club' },
  brawlers: [
    { name: 'Shelly', trophies: 900 },
    { name: 'Colt', trophies: 800 },
  ],
}))) {
  return { getPlayer };
}

beforeEach(() => {
  clearPlayerApiCache();
  mocks.createBrawlStarsClient.mockClear();
  mocks.getSharedBrawlStarsClient.mockClear();
});

describe('player service', () => {
  it('normalises valid tags and uses fresh stored data without an API client', async () => {
    const db = createFakeDb(tables());
    const client = api();

    const result = await loadPlayerProfile(
      { tag: ' #2c0y ', now: NOW, guildId: 'guild-1' },
      { db: db as never, api: client as never },
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.player.tag).toBe('2C0Y');
    expect(result.value.player.name).toBe('Alpha');
    expect(result.value.source).toBe('stored');
    expect(result.value.currentClub?.tag).toBe('8QCL');
    expect(client.getPlayer).not.toHaveBeenCalled();
    expect(mocks.createBrawlStarsClient).not.toHaveBeenCalled();
    expect(mocks.getSharedBrawlStarsClient).not.toHaveBeenCalled();
  });

  it('rejects invalid tags before any query or API call', async () => {
    const db = createFakeDb(tables());
    const client = api();

    await expect(
      loadPlayerProfile({ tag: '#BAD-TAG!', now: NOW }, { db: db as never, api: client as never }),
    ).resolves.toEqual({ kind: 'invalid-tag' });
    expect(db.calls).toEqual([]);
    expect(client.getPlayer).not.toHaveBeenCalled();
  });

  it('reports unknown players from a 404 response safely', async () => {
    const db = createFakeDb(tables());
    const client = api(vi.fn(async () => {
      throw new BrawlStarsApiError('not found', 404);
    }));

    const result = await loadPlayerProfile(
      { tag: '#QQQ', now: NOW },
      { db: db as never, api: client as never },
    );

    expect(result).toEqual({ kind: 'not-found', tag: 'QQQ' });
  });

  it('falls back to stored data on rate limits without overwriting it', async () => {
    const db = createFakeDb(tables());
    const client = api(vi.fn(async () => {
      throw new BrawlStarsApiError('rate limited', 429);
    }));
    const data = tables();
    data['players']![0] = { ...PLAYERS[0]!, last_synced_at: OLD };

    const result = await loadPlayerProfile(
      { tag: '2C0Y', now: NOW, guildId: 'guild-1' },
      { db: createFakeDb(data) as never, api: client as never },
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.player.trophies).toBe(5000);
    expect(result.value.apiIssue).toBe('rate-limit');
    expect(result.value.source).toBe('stored');
  });

  it('merges live profile fields, brawlers and caches successful API responses', async () => {
    const data = tables();
    data['players']![0] = { ...PLAYERS[0]!, last_synced_at: OLD };
    const db = createFakeDb(data);
    const client = api();
    const options = { db: db as never, api: client as never };

    const first = await loadPlayerProfile({ tag: '2C0Y', now: NOW, guildId: 'guild-1' }, options);
    const second = await loadPlayerProfile({ tag: '2C0Y', now: NOW, guildId: 'guild-1' }, options);

    expect(first.kind).toBe('ok');
    expect(second.kind).toBe('ok');
    if (first.kind !== 'ok' || second.kind !== 'ok') return;
    expect(first.value.player.name).toBe('Live Alpha');
    expect(first.value.player.trophies).toBe(6100);
    expect(first.value.player.highestTrophies).toBe(6300);
    expect(first.value.player.expLevel).toBe(40);
    expect(first.value.brawlers).toHaveLength(2);
    expect(first.value.currentClub?.tag).toBe('8QCL');
    expect(second.value.player.trophies).toBe(6100);
    expect(client.getPlayer).toHaveBeenCalledTimes(1);
  });

  it('keeps missing profile fields null when API data is incomplete', async () => {
    const data = tables();
    data['players']![2] = { id: 'p3', tag: 'G2P9', name: 'Charlie', trophies: null, highest_trophies: null, exp_level: null, last_synced_at: null };
    const client = api(vi.fn(async () => ({
      tag: '#G2P9', name: 'Charlie Live', trophies: 3100,
    })));

    const result = await loadPlayerProfile(
      { tag: 'G2P9', now: NOW, guildId: 'guild-1' },
      { db: createFakeDb(data) as never, api: client as never },
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.player.highestTrophies).toBeNull();
    expect(result.value.player.expLevel).toBeNull();
    expect(result.value.brawlers).toEqual([]);
  });

  it('filters stored history and reports insufficient history without interpolation', async () => {
    const db = createFakeDb(tables());

    const short = await loadPlayerHistory(
      { tag: '2C0Y', period: '7d', now: NOW, guildId: 'guild-1' },
      { db: db as never },
    );
    expect(short.kind).toBe('ok');
    if (short.kind !== 'ok') return;
    expect(short.value.points).toHaveLength(1);
    expect(short.value.change).toBeNull();
    expect(short.value.firstSnapshotAt).toBe('2026-11-17T00:00:00.000Z');

    const full = await loadPlayerHistory(
      { tag: '2C0Y', period: '30d', now: NOW, guildId: 'guild-1' },
      { db: createFakeDb(tables()) as never },
    );
    expect(full.kind).toBe('ok');
    if (full.kind !== 'ok') return;
    expect(full.value.points).toHaveLength(3);
    expect(full.value.change).toEqual({ trophies: 300 });
    expect(full.value.highestRecordedTrophies).toBe(5200);
    expect(full.value.memberships.length).toBeGreaterThan(0);
  });

  it('handles a player with no stored snapshots safely', async () => {
    const data = tables();
    data['player_snapshots'] = [];
    const result = await loadPlayerHistory(
      { tag: 'G2P9', period: '30d', now: NOW, guildId: 'guild-1' },
      { db: createFakeDb(data) as never },
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.points).toEqual([]);
    expect(result.value.change).toBeNull();
    expect(result.value.progression).toBeNull();
  });

  it('distinguishes current, past, stale and incomplete membership records', async () => {
    const result = await loadPlayerClubs(
      { tag: '2C0Y', now: NOW, guildId: 'guild-1' },
      { db: createFakeDb(tables()) as never },
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.currentClub?.tag).toBe('8QCL');
    expect(result.value.memberships.map((row) => row.status)).toEqual(['current', 'past']);
    expect(result.value.memberships[1]?.durationMs).toBe(31 * 24 * 60 * 60 * 1000);
    expect(result.value.events.some((event) => event.eventType === 'transfer')).toBe(true);

    const stale = await loadPlayerClubs(
      { tag: 'G2P9', now: NOW, guildId: 'guild-1' },
      { db: createFakeDb(tables()) as never },
    );
    expect(stale.kind).toBe('ok');
    if (stale.kind !== 'ok') return;
    expect(stale.value.currentClub).toBeNull();
    expect(stale.value.memberships[0]?.status).toBe('incomplete');
  });

  it('summarizes only completed official battles in the selected period', async () => {
    const result = await loadPlayerBattles(
      { tag: '2C0Y', period: '30d', now: NOW, guildId: 'guild-1' },
      { db: createFakeDb(tables()) as never },
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.battles.map((battle) => battle.id)).toEqual(['b1', 'b2', 'b3']);
    expect(result.value.wins).toBe(2);
    expect(result.value.losses).toBe(1);
    expect(result.value.draws).toBe(0);
    expect(result.value.trophyChange).toBe(9);
    expect(result.value.topModes).toEqual([
      { mode: 'brawlBall', count: 1 },
      { mode: 'gemGrab', count: 1 },
      { mode: 'showdown', count: 1 },
    ]);
    expect(result.value.firstBattleAt).toBe('2026-11-05T12:00:00.000Z');
    expect(result.value.latestBattleAt).toBe('2026-11-17T12:00:00.000Z');

    const short = await loadPlayerBattles(
      { tag: '2C0Y', period: '7d', now: NOW, guildId: 'guild-1' },
      { db: createFakeDb(tables()) as never },
    );
    expect(short.kind).toBe('ok');
    if (short.kind !== 'ok') return;
    expect(short.value.battles.map((battle) => battle.id)).toEqual(['b1']);
  });

  it('extracts the player brawler and star player from stored raw battle data', async () => {
    const data = tables();
    const battles = data.player_battles ?? [];
    data.player_battles = battles.map((row) =>
      row['id'] === 'b1'
        ? {
            ...row,
            raw: {
              battleTime: '20261117T120000.000Z',
              battle: {
                starPlayer: { tag: '#OTHER', name: 'Rival' },
                teams: [
                  [
                    { tag: '#2C0Y', name: 'Alpha', brawler: { id: 1, name: 'Shelly' } },
                    { tag: '#TEAM', name: 'Mate', brawler: { id: 2, name: 'Colt' } },
                  ],
                ],
              },
            },
          }
        : row,
    );
    const result = await loadPlayerBattles(
      { tag: '2C0Y', period: '30d', now: NOW, guildId: 'guild-1' },
      { db: createFakeDb(data) as never },
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.battles[0]?.brawlerName).toBe('Shelly');
    expect(result.value.battles[0]?.starPlayerName).toBe('Rival');
    expect(result.value.battles[1]?.brawlerName).toBeNull();
    expect(result.value.battles[1]?.starPlayerName).toBeNull();
  });

  it('rejects stored history reads for players outside the invoking guild', async () => {
    const battleDb = createFakeDb(tables());
    await expect(
      loadPlayerBattles(
        { tag: 'Q8VR', period: '30d', now: NOW, guildId: 'guild-1' },
        { db: battleDb as never },
      ),
    ).resolves.toEqual({ kind: 'not-found', tag: 'Q8VR' });
    expect(battleDb.calls.some((call) => call.table === 'player_battles')).toBe(false);

    await expect(
      loadPlayerHistory(
        { tag: 'Q8VR', period: '30d', now: NOW, guildId: 'guild-1' },
        { db: createFakeDb(tables()) as never },
      ),
    ).resolves.toEqual({ kind: 'not-found', tag: 'Q8VR' });

    await expect(
      loadPlayerClubs(
        { tag: 'Q8VR', now: NOW, guildId: 'guild-1' },
        { db: createFakeDb(tables()) as never },
      ),
    ).resolves.toEqual({ kind: 'not-found', tag: 'Q8VR' });

    await expect(
      loadPlayerCompare(
        { firstTag: '2C0Y', secondTag: 'Q8VR', period: '30d', now: NOW, guildId: 'guild-1' },
        { db: createFakeDb(tables()) as never },
      ),
    ).resolves.toEqual({ kind: 'not-found', tag: 'Q8VR' });
  });

  it('pages more than 1000 completed history windows newest-first', async () => {
    const data = tables();
    const runs = Array.from({ length: 1201 }, (_, index) => ({
      id: `history-run-${index}`,
      status: 'completed',
      started_at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 60_000).toISOString(),
      finished_at: new Date(Date.parse('2026-01-01T00:01:00.000Z') + index * 60_000).toISOString(),
      affected_club_ids: [],
      club_tags: [],
    }));
    data['sync_runs'] = runs;
    data['player_snapshots'] = runs.map((run, index) => ({
      id: `history-snapshot-${index}`,
      player_id: 'p1',
      sync_run_id: run.id,
      captured_at: run.finished_at,
      trophies: 4000 + index,
    }));
    const db = createFakeDb(data);

    const result = await loadPlayerHistory(
      { tag: '2C0Y', period: 'all', now: NOW, guildId: 'guild-1' },
      { db: db as never },
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.points).toHaveLength(1201);
    expect(result.value.points[0]?.trophies).toBe(4000);
    expect(result.value.points[1200]?.trophies).toBe(5200);
    const snapshotCalls = db.rpcCalls.filter((call) => call.name === 'player_snapshot_page');
    expect(snapshotCalls).toHaveLength(2);
    expect(snapshotCalls[0]?.args).toMatchObject({
      p_player_id: 'p1',
      p_since: null,
      p_completed_only: true,
      p_newest_first: true,
      p_limit: 1000,
      p_after_captured_at: null,
      p_after_id: null,
    });
    expect(snapshotCalls[1]?.args['p_after_captured_at']).toBe(runs[201]?.finished_at);
  });

  it('denies stored player history when no guild context is available', async () => {
    const battleDb = createFakeDb(tables());
    await expect(
      loadPlayerBattles(
        { tag: '2C0Y', period: '30d', now: NOW, guildId: null },
        { db: battleDb as never },
      ),
    ).resolves.toEqual({ kind: 'not-found', tag: '2C0Y' });
    expect(battleDb.calls.some((call) => call.table === 'player_battles')).toBe(false);

    const historyDb = createFakeDb(tables());
    await expect(
      loadPlayerHistory(
        { tag: '2C0Y', period: '30d', now: NOW, guildId: '' },
        { db: historyDb as never },
      ),
    ).resolves.toEqual({ kind: 'not-found', tag: '2C0Y' });
    expect(historyDb.calls.some((call) => call.table === 'player_snapshots')).toBe(false);

    expect(await searchPlayers('alp', { db: createFakeDb(tables()) as never, guildId: null })).toEqual([]);
  });

  it('compares aligned players and warns when snapshot windows differ', async () => {
    const aligned = await loadPlayerCompare(
      { firstTag: '2C0Y', secondTag: 'Q8VR', period: '30d', now: NOW, guildId: 'guild-2' },
      { db: createFakeDb(tables()) as never },
    );
    expect(aligned.kind).toBe('ok');
    if (aligned.kind !== 'ok') return;
    expect(aligned.value.aligned).toBe(true);
    expect(aligned.value.first.latestSnapshotAt).toBe(aligned.value.second.latestSnapshotAt);
    expect(aligned.value.first.currentTrophies).toBeGreaterThan(aligned.value.second.currentTrophies ?? 0);

    const unaligned = await loadPlayerCompare(
      { firstTag: '2C0Y', secondTag: 'G2P9', period: '30d', now: NOW, guildId: 'guild-1' },
      { db: createFakeDb(tables()) as never },
    );
    expect(unaligned.kind).toBe('ok');
    if (unaligned.kind !== 'ok') return;
    expect(unaligned.value.aligned).toBe(false);
    expect(unaligned.value.warning).toContain('No shared completed snapshot');
  });

  it('rejects self-comparison before database access', async () => {
    const db = createFakeDb(tables());
    const result = await loadPlayerCompare(
      { firstTag: '#2c0y', secondTag: '2C0Y', period: '30d', now: NOW },
      { db: db as never },
    );
    expect(result).toEqual({ kind: 'same-player' });
    expect(db.calls).toEqual([]);
  });

  it('supports stored-player autocomplete search in SQL', async () => {
    const db = createFakeDb(tables());
    const result = await searchPlayers('alp', { db: db as never, guildId: 'guild-1' });
    expect(result.map((player) => player.tag)).toEqual(['2C0Y']);
    const searchCall = db.rpcCalls.find((call) => call.name === 'player_search_scoped');
    expect(searchCall?.args).toMatchObject({
      p_club_ids: ['club-a'],
      p_search: 'alp',
      p_limit: 25,
    });
    expect(db.calls.some((call) => call.table === 'club_memberships')).toBe(false);
    expect(db.calls.some((call) => call.table === 'players')).toBe(false);
  });

  it('applies guild scope before the autocomplete row cap', async () => {
    const data = tables();
    data.players = [
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `foreign-${index}`,
        tag: `F${index}`,
        name: `Alpha Foreign ${String(index).padStart(2, '0')}`,
        trophies: 1000 + index,
        highest_trophies: null,
        exp_level: null,
        last_synced_at: null,
      })),
      ...(data.players ?? []),
    ];
    const db = createFakeDb(data);

    const result = await searchPlayers('alp', { db: db as never, guildId: 'guild-1' });

    expect(result.map((player) => player.tag)).toEqual(['2C0Y']);
    const searchCall = db.rpcCalls.find((call) => call.name === 'player_search_scoped');
    expect(searchCall?.args).toMatchObject({
      p_club_ids: ['club-a'],
      p_search: 'alp',
      p_limit: 25,
    });
    expect(db.calls.some((call) => call.table === 'players')).toBe(false);
  });

  it('surfaces database and API-unavailable errors safely', async () => {
    const db = createFakeDb(tables(), ['players']);
    await expect(
      loadPlayerProfile({ tag: '2C0Y', now: NOW, guildId: 'guild-1' }, { db: db as never, api: api() as never }),
    ).rejects.toThrow('Read player failed');

    const emptyDb = createFakeDb({ ...tables(), players: [] });
    const failingApi = api(vi.fn(async () => {
      throw new BrawlStarsApiError('server error', 500);
    }));
    await expect(
      loadPlayerProfile({ tag: 'G2P9', now: NOW, guildId: 'guild-1' }, { db: emptyDb as never, api: failingApi as never }),
    ).resolves.toEqual({ kind: 'api-unavailable', tag: 'G2P9', issue: 'error' });
  });
});
