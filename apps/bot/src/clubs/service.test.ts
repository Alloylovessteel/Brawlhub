import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrawlStarsApiError,
  type BrawlStarsClient,
  type Club,
  type ClubMember,
} from '@brawlhub/brawl-stars';
import { clearClubLiveCache, loadClubSummaries, loadClubView } from './service';

type Db = NonNullable<NonNullable<Parameters<typeof loadClubView>[1]>['db']>;
type QueryCall = {
  readonly table: string;
  readonly filters: Record<string, unknown>;
  readonly orders: readonly string[];
  readonly limit: number | undefined;
};
type Handler = (call: QueryCall) => { data?: unknown; error?: unknown };

function createFakeDb(handlers: Record<string, Handler>): {
  db: Db;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];

  class FakeQuery {
    private readonly filters: Record<string, unknown> = {};
    private readonly orders: string[] = [];
    private limitValue: number | undefined;
    private mode: 'array' | 'maybeSingle' = 'array';

    constructor(private readonly table: string) {}

    select(): this {
      return this;
    }

    eq(column: string, value: unknown): this {
      this.filters[column] = value;
      return this;
    }

    in(column: string, value: unknown): this {
      this.filters[`${column}__in`] = value;
      return this;
    }

    gte(column: string, value: unknown): this {
      this.filters[`${column}__gte`] = value;
      return this;
    }

    lte(column: string, value: unknown): this {
      this.filters[`${column}__lte`] = value;
      return this;
    }

    is(column: string, value: unknown): this {
      this.filters[column] = value;
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
        filters: this.filters,
        orders: this.orders,
        limit: this.limitValue,
      };
      calls.push(call);
      const handler = handlers[`${this.table}:select`];
      if (handler === undefined) throw new Error(`Unexpected query: ${this.table}`);
      const result = handler(call);
      const raw = result.data ?? null;
      const data =
        this.mode === 'maybeSingle' && Array.isArray(raw) ? (raw[0] ?? null) : raw;
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
        return new FakeQuery(table);
      },
    } as unknown as Db,
    calls,
  };
}

const CLUB = {
  id: 'club-1',
  tag: '2C0Y',
  name: 'Alpha',
  description: 'Stored description',
  trophies: 1000,
  required_trophies: 500,
  member_count: 2,
  last_synced_at: null,
};

const RUN = {
  id: 'run-1',
  status: 'completed',
  started_at: '2026-11-17T10:00:00.000Z',
  finished_at: '2026-11-17T10:05:00.000Z',
  affected_club_ids: [CLUB.id],
  club_tags: [CLUB.tag],
};

const SNAPSHOT = {
  id: 'snapshot-1',
  sync_run_id: RUN.id,
  captured_at: RUN.finished_at,
  trophies: 1100,
  member_count: 2,
  raw: {
    description: 'Synced description',
    members: [
      { tag: '#G2P9', name: 'Leader', trophies: 900, role: 'president' },
      { tag: '#Q8VR', name: 'Senior', trophies: 700, role: 'senior' },
    ],
  },
};

function api(overrides: Partial<BrawlStarsClient> = {}): BrawlStarsClient {
  const club: Club = {
    tag: '#2C0Y',
    name: 'Alpha',
    description: 'Live description',
    trophies: 1200,
    requiredTrophies: 600,
  };
  const members: ClubMember[] = [
    { tag: '#G2P9', name: 'Live Leader', trophies: 950, role: 'president' },
    { tag: '#Q8VR', name: 'Live Senior', trophies: 750, role: 'senior' },
  ];
  return {
    getClub: vi.fn(async () => club),
    getClubMembers: vi.fn(async () => members),
    getPlayer: vi.fn(async () => {
      throw new Error('getPlayer should not be called');
    }),
    ...overrides,
  } as BrawlStarsClient;
}

function standardHandlers() {
  return {
    'clubs:select': ({ filters }: QueryCall) => {
      if (filters['id'] !== undefined && filters['id'] !== CLUB.id) return { data: null };
      if (filters['tag'] !== undefined && filters['tag'] !== CLUB.tag) return { data: null };
      return { data: [CLUB] };
    },
    'sync_runs:select': () => ({ data: [RUN] }),
    'club_snapshots:select': () => ({ data: [SNAPSHOT] }),
    'club_memberships:select': () => {
      throw new Error('Membership fallback should not be used when a snapshot roster exists');
    },
    'players:select': () => ({ data: [] }),
    'player_battles:select': () => ({ data: [] }),
  };
}

beforeEach(() => {
  clearClubLiveCache();
});

describe('club data service', () => {
  it('normalizes a tag before looking up a registered club and uses live API data', async () => {
    const { db, calls } = createFakeDb(standardHandlers());
    const client = api();

    const result = await loadClubView(
      { tag: '#2c0y', guildId: 'guild-1' },
      { db, api: client, useCache: false },
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.view.rosterSource).toBe('live');
    expect(result.view.currentTrophies).toBe(1200);
    expect(result.view.description).toBe('Live description');
    expect(result.view.requiredTrophies).toBe(600);
    expect(result.view.latestSyncAt).toBe(RUN.finished_at);
    expect(result.view.roster[0]?.name).toBe('Live Leader');
    expect(calls.find((call) => call.table === 'clubs')?.filters['tag']).toBe('2C0Y');
  });

  it('reuses a short-lived live API result for repeated club lookups', async () => {
    const { db } = createFakeDb(standardHandlers());
    const client = api();

    await loadClubView({ tag: CLUB.tag }, { db, api: client });
    await loadClubView({ tag: CLUB.tag }, { db, api: client });

    expect(client.getClub).toHaveBeenCalledOnce();
  });

  it('rejects invalid tags before any database or API request', async () => {
    const { db, calls } = createFakeDb(standardHandlers());
    const client = api();

    const result = await loadClubView({ tag: '#BAD-TAG!' }, { db, api: client, useCache: false });

    expect(result).toEqual({ kind: 'invalid-tag' });
    expect(calls).toHaveLength(0);
    expect(client.getClub).not.toHaveBeenCalled();
  });

  it('does not call the API or write when a club is unregistered', async () => {
    const { db, calls } = createFakeDb({
      'clubs:select': () => ({ data: [] }),
    });
    const client = api();

    const result = await loadClubView({ tag: 'G2P9' }, { db, api: client, useCache: false });

    expect(result).toEqual({ kind: 'unregistered', tag: 'G2P9' });
    expect(client.getClub).not.toHaveBeenCalled();
    expect(calls.every((call) => call.table === 'clubs')).toBe(true);
  });

  it('resolves the guild default club from guild_settings', async () => {
    const { db } = createFakeDb({
      ...standardHandlers(),
      'guild_settings:select': () => ({
        data: { guild_id: 'guild-1', primary_club_id: CLUB.id },
      }),
    });

    const result = await loadClubView({ guildId: 'guild-1' }, { db, api: api(), useCache: false });

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.view.club.id).toBe(CLUB.id);
  });

  it('reports no default when several clubs are registered and none is configured', async () => {
    const { db } = createFakeDb({
      'guild_settings:select': () => ({ data: null }),
      'clubs:select': () => ({ data: [CLUB, { ...CLUB, id: 'club-2', tag: 'Q8VR' }] }),
    });

    const result = await loadClubView({ guildId: 'guild-1' }, { db, api: api(), useCache: false });

    expect(result).toEqual({ kind: 'no-default' });
  });

  it('falls back to synced data and flags a rate-limited API response', async () => {
    const { db } = createFakeDb(standardHandlers());
    const client = api({
      getClub: vi.fn(async () => {
        throw new BrawlStarsApiError('rate limited', 429);
      }),
    });

    const result = await loadClubView({ tag: CLUB.tag }, { db, api: client, useCache: false });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.view.liveStatus).toBe('sync-only');
    expect(result.view.apiIssue).toBe('rate-limit');
    expect(result.view.currentTrophies).toBe(SNAPSHOT.trophies);
    expect(result.view.description).toBe('Synced description');
    expect(result.view.roster.map((member) => member.tag)).toEqual(['G2P9', 'Q8VR']);
  });

  it('uses the memberships roster when no completed snapshot contains one', async () => {
    const { db, calls } = createFakeDb({
      ...standardHandlers(),
      'club_snapshots:select': () => ({ data: [] }),
      'club_memberships:select': () => ({
        data: [
          {
            player_id: 'player-1',
            role: 'senior',
            valid_to: null,
            player: { tag: '#G2P9', name: 'Known', trophies: 500 },
          },
          {
            player_id: 'player-2',
            role: null,
            valid_to: null,
            player: { tag: null, name: null, trophies: null },
          },
        ],
      }),
    });
    const client = api({
      getClub: vi.fn(async () => {
        throw new BrawlStarsApiError('offline', 0);
      }),
    });

    const result = await loadClubView({ tag: CLUB.tag }, { db, api: client, useCache: false });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.view.rosterSource).toBe('memberships');
    expect(result.view.roster).toHaveLength(1);
    expect(result.view.roster[0]?.tag).toBe('G2P9');
    expect(result.view.currentTrophies).toBe(CLUB.trophies);
    expect(calls.some((call) => call.table === 'club_memberships')).toBe(true);
  });

  it('builds club list summaries from snapshots and completed runs', async () => {
    const second = {
      ...CLUB,
      id: 'club-2',
      tag: 'Q8VR',
      name: 'Bravo',
      last_synced_at: null,
    };
    const { db } = createFakeDb({
      'clubs:select': () => ({ data: [CLUB, second] }),
      'sync_runs:select': () => ({
        data: [RUN, { ...RUN, id: 'run-2', affected_club_ids: [second.id], club_tags: [second.tag] }],
      }),
      'club_snapshots:select': ({ filters }: QueryCall) => ({
        data: filters['club_id'] === CLUB.id ? [SNAPSHOT] : [],
      }),
      'club_memberships:select': () => ({
        data: [
          {
            player_id: 'player-1',
            role: 'member',
            valid_to: null,
            player: { tag: '#2C0Y', name: 'Member', trophies: 400 },
          },
        ],
      }),
      'players:select': () => ({ data: [] }),
      'player_battles:select': () => ({ data: [] }),
    });

    const summaries = await loadClubSummaries(db);

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      totalTrophies: SNAPSHOT.trophies,
      averageTrophies: 800,
      memberCount: 2,
      latestSyncAt: RUN.finished_at,
    });
    expect(summaries[1]).toMatchObject({
      totalTrophies: second.trophies,
      averageTrophies: 400,
      memberCount: 1,
      latestSyncAt: RUN.finished_at,
    });
  });
});
