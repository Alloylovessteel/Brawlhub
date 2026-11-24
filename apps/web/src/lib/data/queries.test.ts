import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Filter {
  readonly kind: 'eq' | 'is' | 'in' | 'overlaps' | 'or' | 'gte';
  readonly field: string | null;
  readonly value: unknown;
}

interface Call {
  readonly table: string;
  readonly select: string;
  readonly filters: Filter[];
  readonly order: { field: string; ascending: boolean } | null;
  readonly limit: number | null;
  readonly range: readonly [number, number] | null;
  readonly maybeSingle: boolean;
}

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  tables: {} as Record<string, Row[]>,
  calls: [] as Call[],
}));

vi.mock('@brawlhub/database', () => ({
  createTrustedClient: () => ({
    rpc: (name: string, args: Row) => state.rpc(name, args),
  }),
}));

vi.mock('@/lib/supabase', () => ({
  createServerSupabaseClient: async () => (globalThis as any).__brawlhubWebClient,
}));

const CLUB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLUB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PLAYER_A = '11111111-1111-4111-8111-111111111111';
const PLAYER_B = '22222222-2222-4222-8222-222222222222';

function playerRow(id: string, trophies: number | null = 1_000): Row {
  return {
    id,
    tag: `#${id.slice(0, 4)}`,
    name: `Player ${id.slice(0, 4)}`,
    trophies,
    highest_trophies: trophies,
    exp_level: 10,
    power_points: 100,
    victories: 5,
    solo_victories: 1,
    team_victories: 4,
    last_synced_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function createClient() {
  function from(table: string) {
    const call: {
      table: string;
      select: string;
      filters: Filter[];
      order: { field: string; ascending: boolean } | null;
      limit: number | null;
      range: readonly [number, number] | null;
      maybeSingle: boolean;
    } = {
      table,
      select: '',
      filters: [],
      order: null,
      limit: null,
      range: null,
      maybeSingle: false,
    };

    async function execute(): Promise<{ data: Row[] | Row | null; count: number; error: null }> {
      state.calls.push({ ...call, filters: [...call.filters] });
      let rows = [...(state.tables[table] ?? [])];
      for (const filter of call.filters) {
        if (filter.kind === 'eq') {
          rows = rows.filter((row) => row[filter.field!] === filter.value);
        } else if (filter.kind === 'is') {
          rows = rows.filter((row) => (row[filter.field!] ?? null) === filter.value);
        } else if (filter.kind === 'in') {
          const values = Array.isArray(filter.value) ? filter.value : [];
          rows = rows.filter((row) => values.includes(row[filter.field!]));
        } else if (filter.kind === 'overlaps') {
          const values = Array.isArray(filter.value) ? filter.value : [];
          rows = rows.filter((row) => {
            const stored = row[filter.field!];
            return Array.isArray(stored) && stored.some((value) => values.includes(value));
          });
        }
      }
      if (call.order !== null) {
        const { field, ascending } = call.order;
        rows = [...rows].sort((left, right) => {
          const a = String(left[field] ?? '');
          const b = String(right[field] ?? '');
          return ascending ? a.localeCompare(b) : b.localeCompare(a);
        });
      }
      const total = rows.length;
      if (call.range !== null) {
        rows = rows.slice(call.range[0], call.range[1] + 1);
      } else if (call.limit !== null) {
        rows = rows.slice(0, call.limit);
      }
      return {
        data: call.maybeSingle ? rows[0] ?? null : rows,
        count: total,
        error: null,
      };
    }

    const builder: any = {
      select: (columns: string) => {
        call.select = columns;
        return builder;
      },
      eq: (field: string, value: unknown) => {
        call.filters.push({ kind: 'eq', field, value });
        return builder;
      },
      is: (field: string, value: unknown) => {
        call.filters.push({ kind: 'is', field, value });
        return builder;
      },
      in: (field: string, value: unknown) => {
        call.filters.push({ kind: 'in', field, value });
        return builder;
      },
      overlaps: (field: string, value: unknown) => {
        call.filters.push({ kind: 'overlaps', field, value });
        return builder;
      },
      or: (value: string) => {
        call.filters.push({ kind: 'or', field: null, value });
        return builder;
      },
      gte: (field: string, value: unknown) => {
        call.filters.push({ kind: 'gte', field, value });
        return builder;
      },
      order: (field: string, options: { ascending?: boolean } = {}) => {
        call.order = { field, ascending: options.ascending ?? true };
        return builder;
      },
      limit: (value: number) => {
        call.limit = value;
        return builder;
      },
      range: (start: number, end: number) => {
        call.range = [start, end];
        return builder;
      },
      maybeSingle: async () => {
        call.maybeSingle = true;
        return execute();
      },
      then: (
        resolve: (value: Awaited<ReturnType<typeof execute>>) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => execute().then(resolve, reject),
    };
    return builder;
  }

  return { from, rpc: state.rpc };
}

function scopeCalls(): Array<{ name: string; args: Row }> {
  return state.rpc.mock.calls
    .filter((call) => call[0] === 'web_scoped_player_ids')
    .map((call) => ({ name: call[0] as string, args: call[1] as Row }));
}

function statsCalls(): Array<{ name: string; args: Row }> {
  return state.rpc.mock.calls
    .filter((call) => call[0] === 'web_overview_stats')
    .map((call) => ({ name: call[0] as string, args: call[1] as Row }));
}

describe('web scoped data reads', () => {
  beforeEach(() => {
    state.tables = {};
    state.calls = [];
    state.rpc.mockReset();
    state.rpc.mockImplementation(async (name: string) => {
      if (name === 'web_scoped_player_ids') return { data: [{ player_id: PLAYER_A }], error: null };
      if (name === 'web_overview_stats') {
        return {
          data: {
            clubs: 1,
            players: 1,
            memberships: 1,
            trophy_count: 0,
            trophy_sum: 0,
            trophy_average: null,
          },
          error: null,
        };
      }
      return { data: [], error: null };
    });
    (globalThis as any).__brawlhubWebClient = createClient();
  });

  it('uses the current-only RPC for club-scoped players without intersecting a separate roster read', async () => {
    const { getPlayers } = await import('./queries');
    state.tables['players'] = [playerRow(PLAYER_A), playerRow(PLAYER_B)];

    const result = await getPlayers({ allowedClubIds: [CLUB_A], clubId: CLUB_A });

    expect(result.rows.map((row) => row.id)).toEqual([PLAYER_A]);
    expect(scopeCalls()[0]?.args).toMatchObject({
      p_club_ids: [CLUB_A],
      p_current_only: true,
      p_after: null,
    });
    expect(state.calls.some((call) => call.table === 'club_memberships')).toBe(false);
    expect(state.calls.find((call) => call.table === 'players')?.filters).toContainEqual({
      kind: 'in',
      field: 'id',
      value: [PLAYER_A],
    });
  });

  it('checks getPlayerById scope through the same current-only RPC', async () => {
    const { getPlayerById } = await import('./queries');
    state.tables['players'] = [playerRow(PLAYER_A)];

    const result = await getPlayerById(PLAYER_A, { allowedClubIds: [CLUB_A] });

    expect(result.rows.map((row) => row.id)).toEqual([PLAYER_A]);
    expect(scopeCalls()[0]?.args).toMatchObject({
      p_club_ids: [CLUB_A],
      p_current_only: true,
    });
  });

  it('follows keyset pages until the final short page and uses every id', async () => {
    const { getPlayers } = await import('./queries');
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      player_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    }));
    const lastId = firstPage[999]!.player_id;
    const secondPage = [{ player_id: '00000000-0000-4000-8000-000000001001' }];
    state.rpc.mockImplementation(async (name: string, args: Row) => {
      if (name !== 'web_scoped_player_ids') return { data: [], error: null };
      if (args['p_after'] === null) return { data: firstPage, error: null };
      if (args['p_after'] === lastId) return { data: secondPage, error: null };
      return { data: [], error: null };
    });

    await getPlayers({ allowedClubIds: [CLUB_A] });

    const calls = scopeCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args['p_after']).toBe(lastId);
    expect(calls[1]?.args['p_current_only']).toBe(true);
    const playersFilter = state.calls
      .find((call) => call.table === 'players')
      ?.filters.find((filter) => filter.kind === 'in' && filter.field === 'id');
    expect((playersFilter?.value as string[])).toHaveLength(1001);
  });

  it('uses historical scope (including closed memberships) for snapshot and battle views', async () => {
    const queries = await import('./queries');
    state.tables['players'] = [playerRow(PLAYER_A)];

    await queries.getPlayerSnapshots(PLAYER_A, { allowedClubIds: [CLUB_A] });
    await queries.getPlayerBattles(PLAYER_A, { allowedClubIds: [CLUB_A] });
    await queries.getAllPlayerSnapshots(undefined, { clubIds: [CLUB_A] });
    await queries.getSnapshotCollectionStart({ clubIds: [CLUB_A] });

    const calls = scopeCalls();
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.args['p_current_only'] === false)).toBe(true);
  });
});

describe('overview aggregates', () => {
  beforeEach(() => {
    state.tables = {};
    state.calls = [];
    state.rpc.mockReset();
    state.rpc.mockImplementation(async (name: string, args: Row) => {
      if (name === 'web_scoped_player_ids') return { data: [], error: null };
      if (name === 'web_overview_stats') {
        const ids = args['p_club_ids'] as string[] | null;
        if (ids !== null && ids.length === 0) {
          return {
            data: {
              clubs: 0,
              players: 0,
              memberships: 0,
              trophy_count: 0,
              trophy_sum: 0,
              trophy_average: null,
            },
            error: null,
          };
        }
        return {
          data: {
            clubs: ids === null ? 7 : ids.length,
            players: ids === null ? 40 : 12,
            memberships: ids === null ? 90 : 18,
            trophy_count: 2,
            trophy_sum: 12_345,
            trophy_average: 6_173,
          },
          error: null,
        };
      }
      return { data: [], error: null };
    });
    (globalThis as any).__brawlhubWebClient = createClient();
  });

  it('uses exact scoped aggregates from the RPC', async () => {
    const { getOverview } = await import('./queries');

    const overview = await getOverview({ clubIds: [CLUB_A, CLUB_B] });

    expect(statsCalls()).toEqual([
      { name: 'web_overview_stats', args: { p_club_ids: [CLUB_A, CLUB_B] } },
    ]);
    expect(overview).toMatchObject({
      clubs: 2,
      players: 12,
      memberships: 18,
      trophies: { total: 12_345, average: 6_173 },
      error: null,
    });
  });

  it('scopes recent sync runs to the overview club set', async () => {
    state.tables['sync_runs'] = [
      { id: 'own-run', affected_club_ids: [CLUB_A], status: 'completed', started_at: '2' },
      { id: 'other-run', affected_club_ids: ['99999999-9999-4999-8999-999999999999'], status: 'completed', started_at: '1' },
    ];
    const { getOverview } = await import('./queries');

    const overview = await getOverview({ clubIds: [CLUB_A] });

    expect(overview.recentRuns.map((run) => run.id)).toEqual(['own-run']);
    expect(state.calls).toContainEqual(
      expect.objectContaining({
        table: 'sync_runs',
        filters: [expect.objectContaining({ kind: 'overlaps', field: 'affected_club_ids', value: [CLUB_A] })],
      }),
    );
  });

  it('passes null for an unrestricted overview', async () => {
    const { getOverview } = await import('./queries');

    const overview = await getOverview();

    expect(statsCalls()[0]?.args).toEqual({ p_club_ids: null });
    expect(overview).toMatchObject({
      clubs: 7,
      players: 40,
      memberships: 90,
      trophies: { total: 12_345, average: 6_173 },
    });
  });

  it('treats an empty club scope as zero', async () => {
    const { getOverview } = await import('./queries');

    const overview = await getOverview({ clubIds: [] });

    expect(statsCalls()[0]?.args).toEqual({ p_club_ids: [] });
    expect(overview).toMatchObject({
      clubs: 0,
      players: 0,
      memberships: 0,
      trophies: { total: null, average: null },
      error: null,
    });
  });

  it('surfaces overview RPC errors instead of hiding them', async () => {
    const { getOverview } = await import('./queries');
    state.rpc.mockImplementation(async (name: string) => {
      if (name === 'web_overview_stats') {
        return { data: null, error: { message: 'aggregate unavailable' } };
      }
      if (name === 'web_scoped_player_ids') return { data: [], error: null };
      return { data: [], error: null };
    });

    const overview = await getOverview({ clubIds: [CLUB_A] });

    expect(overview.error).toBe('aggregate unavailable');
    expect(overview.trophies).toEqual({ total: null, average: null });
    expect(overview.clubs).toBe(0);
  });
});
