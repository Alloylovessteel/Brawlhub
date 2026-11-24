import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrawlStarsClient, Club, ClubMember } from '@brawlhub/brawl-stars';
import { runSync } from './index';

type Call = {
  table: string;
  op: 'select' | 'insert' | 'upsert' | 'update' | 'delete';
  columns: string | undefined;
  payload: any;
  options: any;
  filters: Record<string, unknown>;
  orders: Array<{ column: string; options: unknown }>;
  limit: number | undefined;
  mode: 'array' | 'single' | 'maybeSingle';
};

type Handler = (call: Call) => { data?: unknown; error?: unknown } | Promise<{ data?: unknown; error?: unknown }>;

const fake = vi.hoisted(() => ({
  state: {
    handlers: {} as Record<string, Handler | undefined>,
    calls: [] as Call[],
  },
  api: { current: undefined as BrawlStarsClient | undefined },
}));

vi.mock('@brawlhub/database', () => {
  class FakeQuery {
    private mode: Call['mode'] = 'array';
    private columns: string | undefined = undefined;
    private filters: Record<string, unknown> = {};
    private orders: Array<{ column: string; options: unknown }> = [];
    private limitValue: number | undefined = undefined;
    private operationPayload: unknown = undefined;
    private operationOptions: unknown = undefined;

    constructor(
      private readonly state: typeof fake.state,
      private readonly table: string,
      private operation: Call['op'],
    ) {}

    select(columns?: string, options?: unknown): this {
      this.columns = columns;
      this.operationOptions = options;
      return this;
    }

    insert(payload: unknown, options?: unknown): this {
      this.operation = 'insert';
      this.operationPayload = payload;
      this.operationOptions = options;
      return this;
    }

    upsert(payload: unknown, options?: unknown): this {
      this.operation = 'upsert';
      this.operationPayload = payload;
      this.operationOptions = options;
      return this;
    }

    update(payload: unknown, options?: unknown): this {
      this.operation = 'update';
      this.operationPayload = payload;
      this.operationOptions = options;
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

    in(column: string, values: unknown): this {
      this.filters[column] = values;
      return this;
    }

    gte(column: string, value: unknown): this {
      this.filters[column] = { gte: value };
      return this;
    }

    order(column: string, options?: unknown): this {
      this.orders.push({ column, options });
      return this;
    }

    limit(value: number): this {
      this.limitValue = value;
      return this;
    }

    maybeSingle(): Promise<any> {
      this.mode = 'maybeSingle';
      return this.execute();
    }

    single(): Promise<any> {
      this.mode = 'single';
      return this.execute();
    }

    private async execute(): Promise<any> {
      const call: Call = {
        table: this.table,
        op: this.operation,
        columns: this.columns,
        payload: this.operationPayload,
        options: this.operationOptions,
        filters: this.filters,
        orders: this.orders,
        limit: this.limitValue,
        mode: this.mode,
      };
      this.state.calls.push(call);
      const handler = this.state.handlers[`${this.table}:${this.operation}`] ?? this.state.handlers['*'];
      if (handler === undefined) {
        throw new Error(`No fake DB handler for ${this.table}:${this.operation}`);
      }
      const response = await handler(call);
      const error = response.error ?? null;
      if (this.mode === 'array') {
        return { data: Array.isArray(response.data) ? response.data : [], error };
      }
      const row = Array.isArray(response.data) ? response.data[0] : response.data;
      return { data: row ?? null, error };
    }

    then<TResult1 = any, TResult2 = never>(
      onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return this.execute().then(onfulfilled, onrejected);
    }
  }

  return {
    createTrustedClient: () => ({
      from(table: string) {
        return new FakeQuery(fake.state, table, 'select');
      },
      rpc(name: string, params: unknown): Promise<any> {
        const call: Call = {
          table: `rpc:${name}`,
          op: 'select',
          columns: undefined,
          payload: params,
          options: undefined,
          filters: {},
          orders: [],
          limit: undefined,
          mode: 'array',
        };
        fake.state.calls.push(call);
        const handler = fake.state.handlers[`rpc:${name}`] ?? fake.state.handlers['*'];
        if (handler === undefined) {
          throw new Error(`No fake DB handler for rpc:${name}`);
        }
        return Promise.resolve(handler(call));
      },
    }),
  };
});

vi.mock('@brawlhub/brawl-stars', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brawlhub/brawl-stars')>();
  const getFakeClient = () => {
    if (fake.api.current === undefined) {
      throw new Error('Fake Brawl Stars client was not configured');
    }
    return fake.api.current;
  };
  return {
    ...actual,
    createBrawlStarsClient: getFakeClient,
    getSharedBrawlStarsClient: getFakeClient,
  };
});

const T0 = new Date('2026-01-01T00:00:00.000Z');
const CLUB_ROW = { id: 'club-1', tag: '2C0Y', name: 'Alpha', guild_id: 'guild-test' };
const OUT_OF_SCOPE_CLUB_ROW = { id: 'club-other', tag: '8GPU', name: 'Other Guild', guild_id: 'guild-other' };
const MEMBER: ClubMember = { tag: '#G2P9', name: 'Player One', trophies: 5_000, role: 'member' };

function callsFor(table: string, op: Call['op']): Call[] {
  return fake.state.calls.filter((call) => call.table === table && call.op === op);
}

function apiClient(
  options: { role?: string | undefined; memberCount?: number | undefined } = {},
): BrawlStarsClient {
  return {
    getClub: async (tag: string) =>
      ({
        tag: `#${tag}`,
        name: 'Alpha',
        trophies: 12_000,
        memberCount: options.memberCount ?? 29,
      }) as Club,
    getClubMembers: async () => [{ ...MEMBER, role: options.role ?? MEMBER.role }],
    getPlayer: async () => {
      throw new Error('getPlayer should not be called by default');
    },
    getBattleLog: async () => [],
    getBrawlers: async () => [],
    getEventRotation: async () => [],
  } as BrawlStarsClient;
}

interface SetupOptions {
  /** Role reported by the official API for the synced member. */
  role?: string;
  /** Role on the pre-existing open membership in the same club. */
  openRole?: string | null;
  /** Club holding the pre-existing open membership. */
  openClubId?: string | null;
  /** Current member count from the API payload. */
  memberCount?: number;
  /** member_count stored in the most recent club snapshot. */
  previousMemberCount?: number;
  /** Clubs returned by the guild-scoped club lookup. */
  clubs?: Array<typeof CLUB_ROW>;
}

function setup(options: SetupOptions = {}): void {
  const openRole = options.openRole === undefined ? 'member' : options.openRole;
  const openRow =
    options.openClubId === undefined || options.openClubId === null
      ? null
      : {
          id: 'membership-1',
          club_id: options.openClubId,
          player_id: 'player-1',
          role: openRole,
        };

  fake.state.handlers = {
    'rpc:try_acquire_sync_lock': (call) => ({
      data: (call.payload as { p_token: string }).p_token,
    }),
    'rpc:release_sync_lock': () => ({ data: null }),
    'rpc:renew_sync_lock': (call) => ({
      data: (call.payload as { p_token: string }).p_token,
    }),
    'rpc:assert_sync_lock_ownership': () => ({ data: true }),
    'rpc:list_unsent_membership_events': () => ({ data: [] }),
    'rpc:claim_notification': () => ({ data: null }),
    'rpc:apply_membership_transition': () => ({ data: 'event-rpc-1' }),
    'rpc:apply_club_role_change': () => ({ data: 'role-change-1' }),
    'clubs:select': () => ({ data: options.clubs ?? [CLUB_ROW] }),
    'sync_runs:select': () => ({ data: null }),
    'sync_runs:upsert': () => ({ data: [{ id: 'run-1' }] }),
    'sync_runs:update': () => ({ data: [{ id: 'run-1' }] }),
    'players:select': () => ({ data: { id: 'player-1', tag: 'G2P9', name: 'Player One' } }),
    'players:upsert': () => ({ data: [{ id: 'player-1' }] }),
    'club_memberships:select': (call) => {
      if (call.mode === 'maybeSingle') {
        return { data: openRow };
      }
      const inFilter = call.filters['club_id'];
      if (Array.isArray(inFilter) && openRow !== null && inFilter.includes(openRow.club_id)) {
        return { data: [openRow] };
      }
      return { data: [] };
    },
    'club_memberships:insert': () => ({ data: [] }),
    'club_memberships:update': () => ({ data: [] }),
    'membership_events:select': () => ({ data: [] }),
    'club_snapshots:select': (call) => {
      if (call.columns === 'member_count') {
        return {
          data:
            options.previousMemberCount === undefined
              ? null
              : [{ member_count: options.previousMemberCount }],
        };
      }
      return { data: null };
    },
    'club_snapshots:upsert': () => ({ data: [] }),
    'player_snapshots:select': () => ({ data: null }),
    'player_snapshots:upsert': () => ({ data: [] }),
    'club_capacity_events:upsert': () => ({ data: [] }),
  };
  fake.state.calls.length = 0;
  fake.api.current = apiClient({ role: options.role, memberCount: options.memberCount });
}

beforeEach(() => {
  fake.state.handlers = {};
  fake.state.calls.length = 0;
  fake.api.current = apiClient();
});

describe('runSync role changes', () => {
  it('records a same-club role change without a membership transition', async () => {
    setup({
      openClubId: CLUB_ROW.id,
      openRole: 'member',
      role: 'vicePresident',
      memberCount: 29,
      previousMemberCount: 29,
    });

    const result = await runSync({ now: T0, guildId: 'guild-test' });

    expect(result.status).toBe('completed');
    const roleChanges = callsFor('rpc:apply_club_role_change', 'select');
    expect(roleChanges).toHaveLength(1);
    expect(roleChanges[0]?.payload).toEqual({
      p_club_id: CLUB_ROW.id,
      p_player_id: 'player-1',
      p_membership_id: 'membership-1',
      p_from_role: 'member',
      p_to_role: 'vicePresident',
      p_detected_at: T0.toISOString(),
      p_run_id: 'run-1',
      p_valid_from: T0.toISOString(),
      p_guild_id: 'guild-test',
      p_lock_scope: 'guild:guild-test',
      p_lock_token: expect.any(String),
    });
    expect(callsFor('rpc:apply_membership_transition', 'select')).toHaveLength(0);
  });

  it('does nothing when the open membership role already matches', async () => {
    setup({
      openClubId: CLUB_ROW.id,
      openRole: 'member',
      role: 'member',
      memberCount: 29,
      previousMemberCount: 29,
    });

    const result = await runSync({ now: T0, guildId: 'guild-test' });

    expect(result.status).toBe('completed');
    expect(callsFor('rpc:apply_club_role_change', 'select')).toHaveLength(0);
    expect(callsFor('rpc:apply_membership_transition', 'select')).toHaveLength(0);
  });

  it('normalizes a null stored role when recording a change', async () => {
    setup({
      openClubId: CLUB_ROW.id,
      openRole: null,
      role: 'member',
      memberCount: 29,
      previousMemberCount: 29,
    });

    const result = await runSync({ now: T0, guildId: 'guild-test' });

    expect(result.status).toBe('completed');
    const roleChanges = callsFor('rpc:apply_club_role_change', 'select');
    expect(roleChanges).toHaveLength(1);
    expect(roleChanges[0]?.payload).toMatchObject({
      p_from_role: null,
      p_to_role: 'member',
    });
  });
});

describe('runSync capacity events', () => {
  function capacityEvents(): Call[] {
    return callsFor('club_capacity_events', 'upsert');
  }

  it('records a close event when the club goes from 29 to 30 members', async () => {
    setup({ previousMemberCount: 29, memberCount: 30 });

    const result = await runSync({ now: T0, guildId: 'guild-test' });

    expect(result.status).toBe('completed');
    expect(capacityEvents()).toHaveLength(1);
    expect(capacityEvents()[0]?.payload).toEqual({
      club_id: CLUB_ROW.id,
      from_count: 29,
      to_count: 30,
      is_full: true,
      source_sync_run_id: 'run-1',
      detected_at: T0.toISOString(),
    });
    expect(capacityEvents()[0]?.options).toEqual({
      onConflict: 'club_id,is_full,source_sync_run_id',
      ignoreDuplicates: true,
    });
  });

  it('records an open event when the club goes from 30 to 29 members', async () => {
    setup({ previousMemberCount: 30, memberCount: 29 });

    const result = await runSync({ now: T0, guildId: 'guild-test' });

    expect(result.status).toBe('completed');
    expect(capacityEvents()).toHaveLength(1);
    expect(capacityEvents()[0]?.payload).toMatchObject({
      club_id: CLUB_ROW.id,
      from_count: 30,
      to_count: 29,
      is_full: false,
      source_sync_run_id: 'run-1',
      detected_at: T0.toISOString(),
    });
  });

  it('does not record an event for an ordinary count change below capacity', async () => {
    setup({ previousMemberCount: 28, memberCount: 29 });

    const result = await runSync({ now: T0, guildId: 'guild-test' });

    expect(result.status).toBe('completed');
    expect(capacityEvents()).toHaveLength(0);
  });

  it('skips a club with no usable previous member count', async () => {
    setup({ memberCount: 30 });

    const result = await runSync({ now: T0, guildId: 'guild-test' });

    expect(result.status).toBe('completed');
    expect(capacityEvents()).toHaveLength(0);
  });
});

describe('runSync guild scoping', () => {
  it('only reads and writes snapshots for registered clubs of this guild', async () => {
    setup({ clubs: [CLUB_ROW], previousMemberCount: 29, memberCount: 30 });

    const result = await runSync({ now: T0, guildId: 'guild-test' });

    expect(result.status).toBe('completed');
    expect(result.affectedClubIds).toEqual([CLUB_ROW.id]);
    const clubSelects = callsFor('clubs', 'select');
    expect(clubSelects[0]?.filters).toMatchObject({ guild_id: 'guild-test' });

    const snapshotReads = callsFor('club_snapshots', 'select');
    expect(snapshotReads.length).toBeGreaterThan(0);
    expect(snapshotReads.every((call) => call.filters['club_id'] === CLUB_ROW.id)).toBe(true);
    const touched = [
      ...callsFor('club_snapshots', 'upsert'),
      ...callsFor('club_capacity_events', 'upsert'),
    ].map((call) => call.payload.club_id);
    expect(touched).not.toContain(OUT_OF_SCOPE_CLUB_ROW.id);
  });

  it('ignores an open membership in another guild and writes a scoped join', async () => {
    setup({
      clubs: [CLUB_ROW],
      openClubId: OUT_OF_SCOPE_CLUB_ROW.id,
      previousMemberCount: 29,
      memberCount: 30,
    });

    const result = await runSync({ now: T0, guildId: 'guild-test' });

    expect(result.status).toBe('completed');
    expect(callsFor('rpc:apply_club_role_change', 'select')).toHaveLength(0);
    const transitions = callsFor('rpc:apply_membership_transition', 'select');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.payload).toMatchObject({
      p_event_type: 'join',
      p_from_club_id: null,
      p_to_club_id: CLUB_ROW.id,
      p_close_membership_id: null,
    });
    expect(callsFor('club_memberships', 'update')).toHaveLength(0);
    expect(
      callsFor('club_capacity_events', 'upsert').every(
        (call) => call.payload.club_id === CLUB_ROW.id,
      ),
    ).toBe(true);
  });
});
