import type { BrawlStarsClient } from '@brawlhub/brawl-stars';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearBrawlerCatalogCache } from './catalog.js';
import {
  filterPlayerBrawlers,
  loadPlayerBrawlers,
  sortPlayerBrawlers,
} from './service.js';
import type { PlayerBrawlerDetail } from './types.js';

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>): SupabaseClient {
  function from(table: string) {
    const filters: Row = {};
    const ins: Record<string, unknown[]> = {};
    let limit: number | null = null;

    function rows(): Row[] {
      let result = [...(tables[table] ?? [])];
      for (const [field, value] of Object.entries(filters)) {
        result = result.filter((row) => row[field] === value);
      }
      for (const [field, values] of Object.entries(ins)) {
        result = result.filter((row) => values.includes(row[field]));
      }
      return limit === null ? result : result.slice(0, limit);
    }

    const execute = async () => ({ data: rows(), error: null });
    const builder = {
      select: () => builder,
      eq: (field: string, value: unknown) => {
        filters[field] = value;
        return builder;
      },
      in: (field: string, values: readonly unknown[]) => {
        ins[field] = [...values];
        return builder;
      },
      is: (field: string, value: unknown) => {
        filters[field] = value;
        return builder;
      },
      order: () => builder,
      limit: (value: number) => {
        limit = value;
        return builder;
      },
      maybeSingle: async () => {
        const result = await execute();
        return { data: result.data[0] ?? null, error: null };
      },
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        execute().then(resolve, reject),
    };
    return builder;
  }

  async function rpc(name: string, args: Record<string, unknown> = {}) {
    if (name !== 'player_lookup_scoped_by_tag') return { data: [], error: null };
    const clubIds = (Array.isArray(args['p_club_ids']) ? args['p_club_ids'] : []).map(String);
    const wanted = String(args['p_tag'] ?? '').replace(/^#+/, '').toUpperCase();
    const memberships = tables['club_memberships'] ?? [];
    const player = (tables['players'] ?? []).find((row) => {
      if (String(row['tag'] ?? '').replace(/^#+/, '').toUpperCase() !== wanted) return false;
      return memberships.some(
        (membership) =>
          clubIds.includes(String(membership['club_id'])) &&
          String(membership['player_id']) === String(row['id']),
      );
    });
    return { data: player === undefined ? [] : [{ player }], error: null };
  }

  return { from, rpc } as unknown as SupabaseClient;
}

function brawler(name: string, overrides: Partial<PlayerBrawlerDetail> = {}): PlayerBrawlerDetail {
  return {
    id: null,
    name,
    trophies: null,
    highestTrophies: null,
    power: null,
    rank: null,
    prestigeLevel: null,
    currentWinStreak: null,
    maxWinStreak: null,
    gadgets: [],
    starPowers: [],
    gears: [],
    hyperCharges: [],
    ...overrides,
  };
}

function fakeApi(getPlayer: () => Promise<unknown>): BrawlStarsClient {
  return {
    getClub: vi.fn(),
    getClubMembers: vi.fn(),
    getPlayer,
    getBattleLog: vi.fn(),
    getBrawlers: vi.fn(async () => [
      { id: 1, name: 'Shelly' },
      { id: 2, name: 'Colt' },
      { id: 3, name: 'Nita' },
    ]),
    getEventRotation: vi.fn(),
  } as unknown as BrawlStarsClient;
}

const STORED_BRAWLERS = Array.from({ length: 12 }, (_, index) => ({
  id: index + 1,
  name: `Stored ${index}`,
  trophies: 100 + index,
}));

function scopedTables() {
  return {
    players: [{
      id: 'p1',
      tag: '2C0Y',
      name: 'Stored Alpha',
      trophies: 5000,
      profile_extra: { brawlers: STORED_BRAWLERS },
      last_synced_at: '2026-11-20T00:00:00.000Z',
    }],
    clubs: [{ id: 'club-a', guild_id: 'guild-1', tag: '8QCL', archived_at: null }],
    club_memberships: [{ player_id: 'p1', club_id: 'club-a', valid_to: null }],
  };
}

beforeEach(() => {
  clearBrawlerCatalogCache();
});

describe('loadPlayerBrawlers', () => {
  it('uses the live official player brawlers first', async () => {
    const api = fakeApi(async () => ({
      tag: '#2C0Y',
      name: 'Live Alpha',
      trophies: 6000,
      brawlers: [
        { id: 1, name: 'Shelly', trophies: 900, power: 11 },
        { id: 2, name: 'Colt', trophies: 700, power: 9 },
      ],
    }));

    const result = await loadPlayerBrawlers(
      { tag: '#2C0Y', guildId: 'guild-1' },
      { db: fakeDb(scopedTables()), api, useCache: false },
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.source).toBe('live');
    expect(result.value.brawlers.map((entry) => entry.name)).toEqual(['Shelly', 'Colt']);
    expect(result.value.brawlers[0]?.power).toBe(11);
  });

  it('falls back to every stored official brawler when the live API fails', async () => {
    const api = fakeApi(async () => {
      throw new Error('API unavailable');
    });

    const result = await loadPlayerBrawlers(
      { tag: '#2C0Y', guildId: 'guild-1' },
      { db: fakeDb(scopedTables()), api, useCache: false },
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.source).toBe('stored');
    expect(result.value.player.name).toBe('Stored Alpha');
    expect(result.value.brawlers).toHaveLength(12);
    expect(result.value.brawlers[0]).toMatchObject({
      name: 'Stored 11',
      trophies: 111,
      gadgets: [],
      starPowers: [],
      gears: [],
    });
  });

  it('does not use stored brawlers outside the invoking guild', async () => {
    const api = fakeApi(async () => {
      throw new Error('API unavailable');
    });

    const result = await loadPlayerBrawlers(
      { tag: '#2C0Y', guildId: 'guild-2' },
      { db: fakeDb(scopedTables()), api, useCache: false },
    );

    expect(result.kind).toBe('api-unavailable');
  });
});

describe('brawler sorting and filtering', () => {
  const items = [
    brawler('Colt', { trophies: 500, highestTrophies: 800, power: 10, rank: 2 }),
    brawler('Shelly', { trophies: 900, highestTrophies: 1000, power: 11, rank: 0 }),
    brawler('Nita', { trophies: null, power: null }),
  ];

  it('sorts by the requested official stat with missing values last', () => {
    expect(sortPlayerBrawlers(items, 'trophies').map((entry) => entry.name)).toEqual(['Shelly', 'Colt', 'Nita']);
    expect(sortPlayerBrawlers(items, 'power').map((entry) => entry.name)).toEqual(['Shelly', 'Colt', 'Nita']);
    expect(sortPlayerBrawlers(items, 'name').map((entry) => entry.name)).toEqual(['Colt', 'Nita', 'Shelly']);
  });

  it('derives unowned brawlers from the official catalog only', () => {
    const catalog = [
      { id: 1, name: 'Shelly' },
      { id: 2, name: 'Colt' },
      { id: 3, name: 'Nita' },
    ];

    expect(filterPlayerBrawlers(items, 'maxed', catalog).map((entry) => entry.name)).toEqual(['Shelly']);
    expect(filterPlayerBrawlers(items, 'ranked', catalog).map((entry) => entry.name)).toEqual(['Colt']);
    expect(filterPlayerBrawlers(items, 'unowned', catalog)).toEqual([]);
    expect(filterPlayerBrawlers([items[1] as PlayerBrawlerDetail], 'unowned', catalog).map((entry) => entry.name)).toEqual(['Colt', 'Nita']);
  });
});
