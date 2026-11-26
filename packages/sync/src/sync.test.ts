import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrustedClient } from '@brawlhub/database';
import type { BattleLogItem, BrawlStarsClient, Club, ClubMember } from '@brawlhub/brawl-stars';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  collectBattleLogs,
  recoverInterruptedSyncs,
  registerClubs,
  runSync,
  startSyncLockRenewal,
} from './index';

type Call = {
  table: string;
  op: 'select' | 'insert' | 'upsert' | 'update' | 'delete';
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

    select(_columns?: string, options?: unknown): this {
      if (this.operation === 'select') this.operationOptions = options;
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

    delete(options?: unknown): this {
      this.operation = 'delete';
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
          payload: params,
          options: undefined,
          filters: {},
          orders: [],
          limit: undefined,
          mode: 'array',
        };
        fake.state.calls.push(call);
        const handler =
          fake.state.handlers[`rpc:${name}`] ?? fake.state.handlers['*'];
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

function setHandlers(handlers: Record<string, Handler>): void {
  fake.state.handlers = handlers;
  fake.state.calls.length = 0;
}

/** Supplies the new database-level lock and atomic-transition RPC handlers. */
function withInfrastructureHandlers(handlers: Record<string, Handler>): Record<string, Handler> {
  return {
    'rpc:try_acquire_sync_lock': (call) => ({
      data: (call.payload as { p_token: string }).p_token,
    }),
    'rpc:release_sync_lock': () => ({ data: null }),
    'rpc:renew_sync_lock': (call) => ({
      data: (call.payload as { p_token: string }).p_token,
    }),
    'rpc:assert_sync_lock_ownership': () => ({ data: true }),
    'rpc:apply_membership_transition': () => ({ data: 'event-rpc-1' }),
    'rpc:apply_club_role_change': () => ({ data: 'role-change-1' }),
    'rpc:list_unsent_membership_events': () => ({ data: [] }),
    'rpc:claim_notification': () => ({ data: null }),
    ...handlers,
  };
}

function callsFor(table: string, op: Call['op']): Call[] {
  return fake.state.calls.filter((call) => call.table === table && call.op === op);
}

interface UnsentEventFixture {
  id: string;
  player_id: string;
  event_type: string;
  from_club_id: string | null;
  to_club_id: string | null;
  detected_at: string;
  player_tag: string;
  player_name: string;
  from_club_name: string | null;
  to_club_name: string | null;
}

function unsentEvent(
  id: string,
  options: { offsetMs?: number; fromClubId?: string | null; toClubId?: string | null } = {},
): UnsentEventFixture {
  return {
    id,
    player_id: 'player-1',
    event_type: 'join',
    from_club_id: options.fromClubId ?? null,
    to_club_id: options.toClubId ?? 'club-1',
    detected_at: new Date(T0.getTime() - (options.offsetMs ?? 0)).toISOString(),
    player_tag: 'G2P9',
    player_name: 'Player One',
    from_club_name: options.fromClubId === undefined || options.fromClubId === null ? null : 'Old Club',
    to_club_name: options.toClubId === null ? null : 'Alpha',
  };
}

/** Mimics the SQL keyset cursor so pagination regressions are observable. */
function respondUnsent(rows: readonly UnsentEventFixture[]): Handler {
  return (call) => {
    const { p_before_detected_at: beforeAt, p_before_id: beforeId, p_limit: limit } = call.payload as {
      p_before_detected_at: string | null;
      p_before_id: string | null;
      p_limit: number;
    };
    const sorted = [...rows].sort(
      (a, b) => b.detected_at.localeCompare(a.detected_at) || b.id.localeCompare(a.id),
    );
    const page = sorted
      .filter(
        (row) =>
          beforeAt === null ||
          row.detected_at < beforeAt ||
          (row.detected_at === beforeAt && beforeId !== null && row.id < beforeId),
      )
      .slice(0, limit);
    return { data: page };
  };
}

const defaultMember: ClubMember = {
  tag: '#G2P9',
  name: 'Player One',
  trophies: 5000,
  role: 'member',
};

function apiClient(overrides: Partial<BrawlStarsClient> = {}): BrawlStarsClient {
  const clubs: Record<string, Club> = {
    '2C0Y': { tag: '#2C0Y', name: 'Alpha', trophies: 12_000 },
    '8GPU': { tag: '#8GPU', name: 'Old Club', trophies: 0 },
  };
  return {
    getClub: async (tag: string) => clubs[tag] ?? ({ tag: `#${tag}`, name: `Club ${tag}`, trophies: 0 } as Club),
    getClubMembers: async (tag: string) => (tag === '8GPU' ? [] : [defaultMember]),
    getPlayer: async () => {
      throw new Error('getPlayer should not be called by default');
    },
    ...overrides,
  } as BrawlStarsClient;
}

const CLUB_ROW = { id: 'club-1', tag: '2C0Y', name: 'Alpha', guild_id: 'guild-test' };
const OLD_CLUB_ROW = { id: 'club-old', tag: '8GPU', name: 'Old Club', guild_id: 'guild-test' };
const T0 = new Date('2026-01-01T00:00:00.000Z');

interface SuccessState {
  firstSnapshotSelect: boolean;
  runSelectCount: number;
  membershipOpen: boolean;
  membershipClubId: string | null;
  clubHash: string | undefined;
  playerHash: string | undefined;
  snapshotRunId: string | undefined;
  snapshotRunStatus: string | undefined;
  events: Map<string, string>;
}

function setupSuccessfulSync(options: {
  failFirstSnapshot?: boolean;
  earlierRunFailed?: boolean;
  forceOldMembership?: boolean;
} = {}): SuccessState {
  const state: SuccessState = {
    firstSnapshotSelect: true,
    runSelectCount: 0,
    membershipOpen: options.forceOldMembership === true,
    membershipClubId: options.forceOldMembership === true ? 'club-old' : null,
    clubHash: undefined,
    playerHash: undefined,
    snapshotRunId: undefined,
    snapshotRunStatus: undefined,
    events: new Map<string, string>(),
  };

  setHandlers(
    withInfrastructureHandlers({
      'clubs:select': () => ({
        data: options.forceOldMembership === true ? [CLUB_ROW, OLD_CLUB_ROW] : [CLUB_ROW],
      }),
      'sync_runs:select': (call) => {
        if (state.snapshotRunId !== undefined && call.filters['id'] === state.snapshotRunId) {
          return { data: { id: state.snapshotRunId, status: state.snapshotRunStatus ?? 'failed' } };
        }
        state.runSelectCount += 1;
        if (options.earlierRunFailed === true && state.runSelectCount === 2) {
          return {
            data: {
              id: 'run-1',
              status: 'failed',
              started_at: T0.toISOString(),
              scope: 'guild:guild-test',
              period_start: T0.toISOString(),
            },
          };
        }
        return { data: null };
      },
      'sync_runs:upsert': () => ({ data: [{ id: 'run-1' }] }),
      'sync_runs:update': () => ({ data: [{ id: 'run-1' }] }),
      'players:select': () => ({ data: { id: 'player-1', tag: 'G2P9', name: 'Player One' } }),
      'players:upsert': () => ({ data: [{ id: 'player-1' }] }),
      'club_memberships:select': (call) => {
        const openRow = state.membershipOpen
          ? {
              id: state.membershipClubId === 'club-old' ? 'membership-old' : 'membership-1',
              club_id: state.membershipClubId ?? 'club-1',
              player_id: 'player-1',
              role: 'member',
            }
          : null;
        if (call.mode === 'maybeSingle') {
          return { data: openRow };
        }
        const inFilter = call.filters['club_id'];
        if (Array.isArray(inFilter)) {
          return { data: openRow && inFilter.includes(openRow.club_id) ? [openRow] : [] };
        }
        return { data: openRow ? [openRow] : [] };
      },
      'club_memberships:insert': () => {
        state.membershipOpen = true;
        state.membershipClubId = 'club-1';
        return { data: [{ id: 'membership-1' }] };
      },
      'club_memberships:update': () => ({ data: [] }),
      'rpc:apply_membership_transition': (call) => {
        const to = (call.payload as { p_to_club_id: string | null }).p_to_club_id;
        if (to !== null) {
          state.membershipOpen = true;
          state.membershipClubId = String(to);
        } else {
          state.membershipOpen = false;
          state.membershipClubId = null;
        }
        return { data: 'event-rpc-1' };
      },
      'membership_events:select': () => ({ data: [] }),
      'membership_events:upsert': (call) => {
        const key = JSON.stringify([
          call.payload.player_id,
          call.payload.event_type,
          call.payload.from_club_id ?? null,
          call.payload.to_club_id ?? null,
          call.payload.source_sync_run_id,
        ]);
        if (!state.events.has(key)) {
          state.events.set(key, `event-${state.events.size + 1}`);
        }
        return { data: [{ id: state.events.get(key) }] };
      },
      'club_snapshots:select': () => {
        if (options.failFirstSnapshot === true && state.firstSnapshotSelect) {
          state.firstSnapshotSelect = false;
          throw new Error('simulated database outage');
        }
        return {
          data:
            state.clubHash === undefined
              ? null
              : [{ payload_hash: state.clubHash, sync_run_id: state.snapshotRunId }],
        };
      },
      'club_snapshots:upsert': (call) => {
        state.clubHash = String(call.payload.payload_hash);
        return { data: [] };
      },
      'player_snapshots:select': () => ({
        data:
          state.playerHash === undefined
            ? null
            : [{ payload_hash: state.playerHash, sync_run_id: state.snapshotRunId }],
      }),
      'player_snapshots:upsert': (call) => {
        state.playerHash = String(call.payload.payload_hash);
        return { data: [] };
      },
    }),
  );

  return state;
}

const OLD_BATTLE: BattleLogItem = {
  battleTime: '20260101T000000.000Z',
  event: { mode: 'gemGrab', map: 'Battlefield' },
  battle: { type: 'ranked', result: 'victory', trophyChange: 8 },
};
const NEW_BATTLE: BattleLogItem = {
  battleTime: '20260101T001000.000Z',
  event: { mode: 'gemGrab', map: 'Battlefield' },
  battle: { type: 'ranked', result: 'victory', trophyChange: 9 },
};
const LATE_BATTLE: BattleLogItem = {
  battleTime: '20260101T000500.000Z',
  event: { mode: 'gemGrab', map: 'Battlefield' },
  battle: { type: 'ranked', result: 'defeat', trophyChange: -6 },
};

function setupBattleSync(input: {
  lastBattleAt: string | null;
  battles: BattleLogItem[];
  storedBattleTimes?: string[];
}): void {
  setupSuccessfulSync();
  fake.state.handlers['players:select'] = (call) => {
    if (call.mode === 'array') {
      return { data: [{ id: 'player-1', last_battle_at: input.lastBattleAt }] };
    }
    return {
      data: {
        id: 'player-1',
        tag: 'G2P9',
        name: 'Player One',
        last_battle_at: input.lastBattleAt,
      },
    };
  };
  fake.state.handlers['players:update'] = () => ({ data: [] });
  const stored = new Set(input.storedBattleTimes ?? []);
  fake.state.handlers['player_battles:upsert'] = (call) => {
    const rows = (Array.isArray(call.payload) ? call.payload : [call.payload]) as Array<{
      battle_time: string;
    }>;
    const inserted = rows
      .filter((row) => !stored.has(row.battle_time))
      .map((row, index) => ({ id: `inserted-${index}`, battle_time: row.battle_time }));
    for (const row of inserted) stored.add(row.battle_time);
    return { data: inserted };
  };
  fake.api.current = apiClient({ getBattleLog: async () => input.battles });
}

beforeEach(() => {
  fake.state.handlers = {};
  fake.state.calls.length = 0;
  fake.api.current = apiClient();
});

describe('registerClubs', () => {
  it('registers a single club tag without requiring a full guild batch', async () => {
    const guildId = '1488531664962326571';
    setHandlers({
      'clubs:select': () => ({ data: null }),
      'clubs:insert': (call) => ({ data: [{ id: `club-${String(call.payload.tag)}` }] }),
    });
    fake.api.current = apiClient();

    const result = await registerClubs(['2UU08YPPJ'], guildId);

    expect(result).toEqual({ registered: 1, rejected: [] });
    const inserts = callsFor('clubs', 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.payload).toMatchObject({ guild_id: guildId, tag: '2UU08YPPJ' });
  });

  it('rejects duplicate tags in the input and duplicates already registered', async () => {
    const guildId = '1488531664962326571';
    const newTags = ['G2P9', '2GPU', '2GPQ', '2GPR', '2GQU', '2GRU', '2GVL', '2GYC', '2J0U', '2J0V'];
    setHandlers({
      'clubs:select': (call) => {
        const tagFilter = call.filters['tag'];
        const guildFilter = call.filters['guild_id'];
        if (tagFilter === '2C0Y' && guildFilter === guildId) {
          return { data: [{ id: 'club-existing', tag: '2C0Y', name: 'Existing', guild_id: guildId }] };
        }
        return { data: null };
      },
      'clubs:insert': (call) => ({ data: [{ id: `club-${String(call.payload.tag)}` }] }),
    });
    fake.api.current = apiClient({
      getClub: async (tag: string) => ({ tag: `#${tag}`, name: `Club ${tag}`, trophies: 1000 }),
    });

    const result = await registerClubs(['#2c0y', '2C0Y', ...newTags], guildId);

    expect(result.registered).toBe(newTags.length);
    expect(
      result.rejected.some(
        (item) => item.tag === '2C0Y' && item.reason.toLowerCase().includes('duplicate'),
      ),
    ).toBe(true);
    expect(
      result.rejected.some(
        (item) => item.tag === '2C0Y' && item.reason.toLowerCase().includes('already registered'),
      ),
    ).toBe(true);

    const inserts = callsFor('clubs', 'insert');
    expect(inserts).toHaveLength(newTags.length);
    expect(inserts.map((call) => call.payload.tag)).toEqual(newTags);
    expect(inserts.every((call) => call.payload.guild_id === guildId)).toBe(true);
  });
});

describe('runSync', () => {
  it('skips a completed period normally but re-runs it with force', async () => {
    setupSuccessfulSync();
    fake.state.handlers['sync_runs:select'] = () => ({
      data: { id: 'run-1', status: 'completed', started_at: T0.toISOString() },
    });

    const skipped = await runSync({ now: T0, guildId: 'guild-test' });
    expect(skipped.status).toBe('skipped');
    expect(skipped.error).toBe('Sync already completed for this period');

    const forced = await runSync({ now: T0, guildId: 'guild-test', force: true });
    expect(forced.status).toBe('completed');
    expect(forced.syncRunId).toBe('run-1');
    expect(
      callsFor('sync_runs', 'upsert').some((call) => call.payload.status === 'running'),
    ).toBe(true);
  });

  it('fails the run when the API returns an empty roster that contradicts club stats', async () => {
    setHandlers(
      withInfrastructureHandlers({
        'clubs:select': () => ({ data: [CLUB_ROW] }),
        'sync_runs:select': () => ({ data: null }),
        'sync_runs:upsert': () => ({ data: [{ id: 'run-1' }] }),
        'sync_runs:update': () => ({ data: [{ id: 'run-1' }] }),
      }),
    );
    fake.api.current = apiClient({
      getClub: async () => ({
        tag: '#2C0Y',
        name: 'Alpha',
        trophies: 12_000,
        memberCount: 30,
      }),
      getClubMembers: async () => [],
    });

    const result = await runSync({ now: T0 });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/empty member roster/i);
    expect(result.syncRunId).toBe('run-1');
    expect(callsFor('rpc:apply_membership_transition', 'select')).toHaveLength(0);
    expect(callsFor('sync_runs', 'update')[0]?.payload.status).toBe('failed');
    expect(callsFor('rpc:release_sync_lock', 'select')).toHaveLength(1);
  });

  it('does not write a new snapshot when the API payload is unchanged', async () => {
    setupSuccessfulSync();

    const first = await runSync({ now: T0, guildId: 'guild-test' });
    expect(first.status).toBe('completed');

    const second = await runSync({ now: new Date(T0.getTime() + 16 * 60_000), guildId: 'guild-test' });
    expect(second.status).toBe('completed');
    expect(second.snapshotsWritten).toBe(0);

    expect(callsFor('club_snapshots', 'upsert')).toHaveLength(1);
    expect(callsFor('player_snapshots', 'upsert')).toHaveLength(1);
  });

  it('writes a fresh snapshot when the identical hash belongs to a failed run', async () => {
    const state = setupSuccessfulSync();
    const first = await runSync({ now: T0, guildId: 'guild-test' });
    expect(first.snapshotsWritten).toBe(2);

    state.snapshotRunId = 'run-failed';
    state.snapshotRunStatus = 'failed';
    const second = await runSync({
      now: new Date(T0.getTime() + 16 * 60_000),
      guildId: 'guild-test',
    });

    expect(second.snapshotsWritten).toBe(2);
    expect(callsFor('club_snapshots', 'upsert')).toHaveLength(2);
    expect(callsFor('player_snapshots', 'upsert')).toHaveLength(2);
  });

  it('reuses the same run id on a retry without duplicating membership events', async () => {
    setupSuccessfulSync({
      failFirstSnapshot: true,
      earlierRunFailed: true,
      forceOldMembership: true,
    });

    const first = await runSync({ now: T0, guildId: 'guild-test' });
    expect(first.status).toBe('failed');
    expect(first.syncRunId).toBe('run-1');

    const second = await runSync({ now: T0, guildId: 'guild-test' });
    expect(second.status).toBe('completed');
    expect(second.syncRunId).toBe('run-1');

    const transitions = callsFor('rpc:apply_membership_transition', 'select');
    expect(transitions.length).toBeGreaterThanOrEqual(1);
    expect(
      new Set(transitions.map((call) => (call.payload as { p_run_id: string }).p_run_id)),
    ).toEqual(new Set(['run-1']));
    expect(transitions[0]?.payload).toMatchObject({
      p_guild_id: 'guild-test',
      p_lock_scope: 'guild:guild-test',
      p_lock_token: expect.any(String),
    });
    // Membership transition committed before snapshot failure; retry must not duplicate events.
    expect(callsFor('rpc:release_sync_lock', 'select')).toHaveLength(2);
  });

  it('does not resend a Discord notification when a retried event is already claimed', async () => {
    setupSuccessfulSync({ earlierRunFailed: true, forceOldMembership: true });
    const event = unsentEvent('event-1', { fromClubId: 'club-old', toClubId: 'club-1' });
    event.event_type = 'transfer';
    fake.state.handlers['rpc:list_unsent_membership_events'] = respondUnsent([event]);

    let claimAttempts = 0;
    let claimedOwner: string | undefined;
    fake.state.handlers['notifications:select'] = () => ({
      data:
        claimedOwner === undefined
          ? []
          : [{ event_id: 'event-1', delivery_status: 'sent', delivery_owner: claimedOwner }],
    });
    fake.state.handlers['rpc:claim_notification'] = (call) => {
      claimAttempts += 1;
      if (claimAttempts > 1) return { data: null };
      claimedOwner = (call.payload as { p_owner: string }).p_owner;
      return { data: 'notification-1' };
    };
    let sends = 0;
    const delivered: Array<{
      clubName: string;
      toClubName: string | undefined;
      occurredAt: string | undefined;
      remainingMembers: number | undefined;
    }> = [];
    fake.state.handlers['notifications:update'] = () => ({ data: [] });

    const notifier = {
      channelId: 'channel-1',
      send: async (input: {
        clubName: string;
        toClubName: string | undefined;
        occurredAt?: string;
        remainingMembers?: number;
      }) => {
        sends += 1;
        delivered.push({
          clubName: input.clubName,
          toClubName: input.toClubName,
          occurredAt: input.occurredAt,
          remainingMembers: input.remainingMembers,
        });
        return `message-${sends}`;
      },
    };

    const first = await runSync({ now: T0, guildId: 'guild-test', notifier });
    expect(first.status).toBe('completed');
    expect(first.notificationsSent).toBe(1);
    const claims = callsFor('rpc:claim_notification', 'select');
    expect(claims).toHaveLength(1);
    expect(claims[0]?.payload).toMatchObject({
      p_event_id: 'event-1',
      p_channel_id: 'channel-1',
      p_kind: 'transfer',
      p_owner: claimedOwner,
      p_lease_seconds: 120,
    });
    expect(callsFor('notifications', 'update')[0]?.payload).toMatchObject({
      delivery_status: 'sent',
      discord_message_id: 'message-1',
    });
    expect(callsFor('notifications', 'update')[0]?.filters).toMatchObject({
      id: 'notification-1',
      delivery_owner: claimedOwner,
      delivery_status: 'pending',
    });

    const second = await runSync({ now: T0, guildId: 'guild-test', notifier });
    expect(second.status).toBe('completed');
    expect(second.notificationsSent).toBe(0);
    expect(sends).toBe(1);
    expect(claimAttempts).toBe(1);
    expect(delivered[0]?.clubName).toBe('Alpha');
    expect(delivered[0]?.toClubName).toBe('Alpha');
    expect(delivered[0]?.occurredAt).toBe(T0.toISOString());
    expect(delivered[0]?.remainingMembers).toBe(1);
  });

  it('announces an event committed by a failed run when a later run gets a new run id', async () => {
    setupSuccessfulSync({ failFirstSnapshot: true, forceOldMembership: true });
    const failed = await runSync({ now: T0, guildId: 'guild-test' });
    expect(failed.status).toBe('failed');

    const orphanedEvent = unsentEvent('orphan-event', {
      fromClubId: 'club-old',
      toClubId: 'club-1',
    });
    orphanedEvent.event_type = 'transfer';
    fake.state.handlers['rpc:list_unsent_membership_events'] = respondUnsent([orphanedEvent]);
    fake.state.handlers['notifications:select'] = () => ({ data: [] });
    fake.state.handlers['rpc:claim_notification'] = () => ({ data: 'notification-orphan' });
    fake.state.handlers['notifications:update'] = () => ({ data: [] });

    const delivered: Array<{ clubName: string; fromClubName: string | undefined; toClubName: string | undefined }> = [];
    const notifier = {
      channelId: 'channel-1',
      send: async (input: { clubName: string; fromClubName: string | undefined; toClubName: string | undefined }) => {
        delivered.push({
          clubName: input.clubName,
          fromClubName: input.fromClubName,
          toClubName: input.toClubName,
        });
        return `message-${delivered.length}`;
      },
    };

    const second = await runSync({
      now: new Date(T0.getTime() + 16 * 60_000),
      guildId: 'guild-test',
      notifier,
    });

    expect(second.status).toBe('completed');
    expect(second.notificationsSent).toBe(1);
    expect(delivered).toEqual([
      { clubName: 'Alpha', fromClubName: 'Old Club', toClubName: 'Alpha' },
    ]);
  });

  it('retries an interrupted claim instead of treating it as delivered', async () => {
    setupSuccessfulSync();
    fake.state.handlers['rpc:list_unsent_membership_events'] = respondUnsent([
      unsentEvent('event-interrupted'),
    ]);
    // An expired pending claim from a crashed run is not delivered.
    fake.state.handlers['notifications:select'] = (call) => ({
      data:
        call.filters['delivery_owner'] === undefined
          ? [{ event_id: 'event-interrupted', delivery_status: 'pending', lease_until: null }]
          : [],
    });
    fake.state.handlers['rpc:claim_notification'] = (call) => ({
      data: `claim-${String((call.payload as { p_owner: string }).p_owner).slice(0, 8)}`,
    });
    fake.state.handlers['notifications:update'] = () => ({ data: [] });

    let sends = 0;
    const notifier = {
      channelId: 'channel-1',
      send: async () => {
        sends += 1;
        return `message-${sends}`;
      },
    };

    const result = await runSync({ now: T0, guildId: 'guild-test', notifier });

    expect(result.status).toBe('completed');
    expect(result.notificationsSent).toBe(1);
    expect(sends).toBe(1);
    expect(callsFor('rpc:claim_notification', 'select')).toHaveLength(1);
    expect(callsFor('notifications', 'update')[0]?.payload).toMatchObject({
      delivery_status: 'sent',
      discord_message_id: 'message-1',
    });
  });

  it('pages unsent events with a keyset cursor until the announcement limit is met', async () => {
    setupSuccessfulSync();
    const ownerId = 'owner-test';
    const rows = [
      ...Array.from({ length: 12 }, (_, index) => {
        const row = unsentEvent(`live-${index}`, { offsetMs: index });
        row.player_id = 'player-live';
        return row;
      }),
      unsentEvent('pending-old', { offsetMs: 60 * 60 * 1000 }),
    ];
    fake.state.handlers['rpc:list_unsent_membership_events'] = respondUnsent(rows);
    fake.state.handlers['notifications:select'] = (call) => ({
      data:
        call.filters['delivery_owner'] === ownerId
          ? rows
              .filter((row) => row.id.startsWith('live-'))
              .map((row) => ({
                event_id: row.id,
                delivery_status: 'pending',
                delivery_owner: ownerId,
                lease_until: new Date(T0.getTime() + 120_000).toISOString(),
              }))
          : [],
    });
    fake.state.handlers['rpc:claim_notification'] = () => ({ data: 'claim-pending-old' });
    fake.state.handlers['notifications:update'] = () => ({ data: [] });

    const delivered: string[] = [];
    const notifier = {
      channelId: 'channel-1',
      send: async (input: { eventId: string }) => {
        delivered.push(input.eventId);
        return 'message-late';
      },
    };

    const result = await runSync({
      now: T0,
      guildId: 'guild-test',
      notifier,
      notificationOwnerId: ownerId,
    });

    expect(result.status).toBe('completed');
    expect(result.notificationsSent).toBe(1);
    expect(delivered).toEqual(['pending-old']);
    const pages = callsFor('rpc:list_unsent_membership_events', 'select');
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[0]?.payload).toMatchObject({ p_limit: 25, p_before_detected_at: null });
    const second = pages[1]?.payload as { p_before_detected_at: string; p_before_id: string };
    expect(second.p_before_detected_at).toBeDefined();
    expect(second.p_before_id).toBeDefined();
    expect(callsFor('membership_events', 'select')).toHaveLength(0);
  });

  it('does not treat another run live lease as delivered but refuses to steal it', async () => {
    setupSuccessfulSync();
    fake.state.handlers['rpc:list_unsent_membership_events'] = respondUnsent([
      unsentEvent('leased-event'),
    ]);
    // The real query filters on this run's owner, so another run's live lease is
    // not returned as "claimed"; the claim RPC is what refuses the takeover.
    fake.state.handlers['notifications:select'] = () => ({ data: [] });
    fake.state.handlers['rpc:claim_notification'] = () => ({ data: null });

    let sends = 0;
    const notifier = {
      channelId: 'channel-1',
      send: async () => {
        sends += 1;
        return 'message';
      },
    };
    const result = await runSync({ now: T0, guildId: 'guild-test', notifier });

    expect(result.status).toBe('completed');
    expect(sends).toBe(0);
    expect(callsFor('rpc:claim_notification', 'select')).toHaveLength(1);
  });

  it('renews the sync lock while a long run is in progress', async () => {
    setupSuccessfulSync();
    fake.state.handlers['rpc:renew_sync_lock'] = (call) => ({
      data: (call.payload as { p_token: string }).p_token,
    });
    fake.api.current = apiClient({
      getClub: async (tag) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { tag: `#${tag}`, name: 'Alpha', trophies: 12_000 };
      },
    });

    const result = await runSync({
      now: T0,
      guildId: 'guild-test',
      lockRenewalIntervalMs: 5,
    });

    expect(result.status).toBe('completed');
    expect(callsFor('rpc:renew_sync_lock', 'select').length).toBeGreaterThan(0);
  });

  it('exposes lock loss through an abort signal and callback', async () => {
    const db = { rpc: async () => ({ data: null }) } as unknown as SupabaseClient;
    const reasons: string[] = [];
    const renewal = startSyncLockRenewal(
      db,
      'guild:guild-test',
      'token',
      1,
      (reason) => { reasons.push(reason); },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(renewal.lost).toBe(true);
    expect(renewal.signal.aborted).toBe(true);
    expect(reasons).toHaveLength(1);
    await renewal.stop();
  });

  it('stops before any roster write when the lock is lost during API fetch', async () => {
    setupSuccessfulSync();
    fake.state.handlers['rpc:renew_sync_lock'] = () => ({ data: null });
    const reasons: string[] = [];
    fake.api.current = apiClient({
      getClub: async (tag) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { tag: `#${tag}`, name: 'Alpha', trophies: 12_000 };
      },
    });

    const result = await runSync({
      now: T0,
      guildId: 'guild-test',
      lockRenewalIntervalMs: 1,
      onLockLost: (reason) => { reasons.push(reason); },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/lock/i);
    expect(reasons.length).toBeGreaterThan(0);
    expect(callsFor('players', 'upsert')).toHaveLength(0);
    expect(callsFor('rpc:apply_membership_transition', 'select')).toHaveLength(0);
    expect(callsFor('club_snapshots', 'upsert')).toHaveLength(0);
    expect(callsFor('rpc:release_sync_lock', 'select')).toHaveLength(1);
  });

  it('stops before writes when the database no longer confirms lock ownership', async () => {
    setupSuccessfulSync();
    fake.state.handlers['rpc:assert_sync_lock_ownership'] = () => ({ data: false });

    const result = await runSync({ now: T0, guildId: 'guild-test' });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/lock/i);
    expect(callsFor('players', 'upsert')).toHaveLength(0);
    expect(callsFor('rpc:apply_membership_transition', 'select')).toHaveLength(0);
  });

  it('syncs each guild separately when no guild id is supplied', async () => {
    const clubA = { id: 'club-a', tag: '2C0Y', name: 'Alpha A', guild_id: 'guild-a' };
    const clubB = { id: 'club-b', tag: '8GPU', name: 'Alpha B', guild_id: 'guild-b' };
    setHandlers(
      withInfrastructureHandlers({
        'clubs:select': (call) => {
          const guild = call.filters['guild_id'];
          if (guild === 'guild-a') return { data: [clubA] };
          if (guild === 'guild-b') return { data: [clubB] };
          return { data: [clubA, clubB] };
        },
        'sync_runs:select': () => ({ data: null }),
        'sync_runs:upsert': () => ({ data: [{ id: 'run-1' }] }),
        'sync_runs:update': () => ({ data: [] }),
        'players:select': () => ({ data: { id: 'player-1', tag: 'G2P9', name: 'Player One' } }),
        'players:upsert': () => ({ data: [{ id: 'player-1' }] }),
        'club_memberships:select': () => ({ data: [] }),
        'club_snapshots:select': () => ({ data: null }),
        'club_snapshots:upsert': () => ({ data: [] }),
        'player_snapshots:select': () => ({ data: null }),
        'player_snapshots:upsert': () => ({ data: [] }),
      }),
    );
    fake.api.current = apiClient();

    const result = await runSync({ now: T0 });

    expect(result.status).toBe('completed');
    expect([...result.affectedClubIds].sort()).toEqual(['club-a', 'club-b']);
    const scopes = callsFor('rpc:try_acquire_sync_lock', 'select').map(
      (call) => (call.payload as { p_scope: string }).p_scope,
    );
    expect(scopes).toEqual(['guild:guild-a', 'guild:guild-b']);
    expect(scopes).not.toContain('all-clubs');
  });

  it('skips when another process already holds the database lock', async () => {
    setupSuccessfulSync();
    fake.state.handlers['rpc:try_acquire_sync_lock'] = () => ({ data: null });

    const result = await runSync({ now: T0, guildId: 'guild-test' });

    expect(result.status).toBe('skipped');
    expect(result.error).toMatch(/database lock/i);
    expect(callsFor('sync_runs', 'upsert')).toHaveLength(0);
  });

  it('fails the run when an API call times out instead of treating it as an empty roster', async () => {
    setHandlers(
      withInfrastructureHandlers({
        'clubs:select': () => ({ data: [CLUB_ROW] }),
        'sync_runs:select': () => ({ data: null }),
        'sync_runs:upsert': () => ({ data: [{ id: 'run-1' }] }),
        'sync_runs:update': () => ({ data: [{ id: 'run-1' }] }),
      }),
    );
    const previousTimeout = process.env.SYNC_API_TIMEOUT_MS;
    process.env.SYNC_API_TIMEOUT_MS = '20';
    fake.api.current = apiClient({
      getClub: () => new Promise<Club>(() => {}),
    });

    try {
      const result = await runSync({ now: T0 });
      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/timed out/i);
      expect(callsFor('rpc:apply_membership_transition', 'select')).toHaveLength(0);
      expect(callsFor('rpc:release_sync_lock', 'select')).toHaveLength(1);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.SYNC_API_TIMEOUT_MS;
      } else {
        process.env.SYNC_API_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it('fails the run on malformed member data', async () => {
    setHandlers(
      withInfrastructureHandlers({
        'clubs:select': () => ({ data: [CLUB_ROW] }),
        'sync_runs:select': () => ({ data: null }),
        'sync_runs:upsert': () => ({ data: [{ id: 'run-1' }] }),
        'sync_runs:update': () => ({ data: [{ id: 'run-1' }] }),
      }),
    );
    fake.api.current = apiClient({
      getClubMembers: async () => [
        { tag: 'BAD-TAG!', name: 'Broken', trophies: 1, role: 'member' },
      ],
    });

    const result = await runSync({ now: T0 });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/invalid tag|malformed/i);
    expect(callsFor('rpc:apply_membership_transition', 'select')).toHaveLength(0);
    expect(callsFor('rpc:release_sync_lock', 'select')).toHaveLength(1);
  });

  it('writes a new player snapshot when the API payload changes', async () => {
    const state = setupSuccessfulSync();
    const first = await runSync({ now: T0, guildId: 'guild-test' });
    expect(first.status).toBe('completed');

    fake.api.current = apiClient({
      getClubMembers: async () => [{ ...defaultMember, trophies: 6_000 }],
    });
    const second = await runSync({ now: new Date(T0.getTime() + 16 * 60_000), guildId: 'guild-test' });

    expect(second.status).toBe('completed');
    expect(second.snapshotsWritten).toBeGreaterThan(0);
    expect(callsFor('player_snapshots', 'upsert')).toHaveLength(2);
    expect(state.playerHash).toBeDefined();
  });

  it('offers every fetched battle but counts only rows the database inserted', async () => {
    setupBattleSync({
      lastBattleAt: '2026-01-01T00:00:00.000Z',
      battles: [OLD_BATTLE, NEW_BATTLE],
      storedBattleTimes: ['2026-01-01T00:00:00.000Z'],
    });

    const result = await runSync({ now: T0, guildId: 'guild-test' });

    expect(result.status).toBe('completed');
    expect(result.battlesCollected).toBe(1);
    const upserts = callsFor('player_battles', 'upsert');
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.payload).toHaveLength(2);
    expect(upserts[0]?.options).toEqual({
      onConflict: 'player_id,battle_key',
      ignoreDuplicates: true,
    });
    expect(callsFor('players', 'update')[0]?.payload).toEqual({
      last_battle_at: '2026-01-01T00:10:00.000Z',
    });
  });

  it('re-upserts current battles without counting them as new', async () => {
    setupBattleSync({
      lastBattleAt: '2026-01-01T00:10:00.000Z',
      battles: [OLD_BATTLE, NEW_BATTLE],
      storedBattleTimes: ['2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z'],
    });

    const result = await runSync({ now: T0, guildId: 'guild-test' });

    expect(result.status).toBe('completed');
    expect(result.battlesCollected).toBe(0);
    expect(callsFor('player_battles', 'upsert')[0]?.payload).toHaveLength(2);
    expect(callsFor('players', 'update')).toHaveLength(0);
  });

  it('writes all fetched battles when last_battle_at is unknown', async () => {
    setupBattleSync({ lastBattleAt: null, battles: [OLD_BATTLE, NEW_BATTLE] });

    const result = await runSync({ now: T0, guildId: 'guild-test' });

    expect(result.status).toBe('completed');
    expect(result.battlesCollected).toBe(2);
    expect(callsFor('player_battles', 'upsert')[0]?.payload).toHaveLength(2);
  });

  it('does not drop a late battle older than the stored last_battle_at', async () => {
    setupBattleSync({
      lastBattleAt: '2026-01-01T00:10:00.000Z',
      battles: [OLD_BATTLE, LATE_BATTLE, NEW_BATTLE],
      storedBattleTimes: ['2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z'],
    });

    const result = await runSync({ now: T0, guildId: 'guild-test' });

    expect(result.status).toBe('completed');
    expect(result.battlesCollected).toBe(1);
    const payload = callsFor('player_battles', 'upsert')[0]?.payload as Array<{
      battle_time: string;
    }>;
    expect(payload.map((row) => row.battle_time)).toContain('2026-01-01T00:05:00.000Z');
    expect(callsFor('players', 'update')).toHaveLength(0);
  });
});

describe('collectBattleLogs fencing', () => {
  it('stops queued players and skips writes once the sync lease is lost', async () => {
    setHandlers({
      'player_battles:upsert': () => ({ data: [{ id: 'battle-1' }] }),
      'players:select': () => ({ data: { last_battle_at: null } }),
      'players:update': () => ({ data: [] }),
    });
    const controller = new AbortController();
    const getBattleLog = vi.fn(async () => {
      controller.abort();
      return [OLD_BATTLE];
    });
    const assertBeforeWrite = vi.fn(async () => {
      if (controller.signal.aborted) throw new Error('Sync lock lost before battle log write');
    });
    const states = Array.from({ length: 8 }, (_, index) => ({
      playerId: `player-${index}`,
      tag: `TAG${index}`,
    }));

    await expect(
      collectBattleLogs(
        createTrustedClient() as unknown as SupabaseClient,
        apiClient({ getBattleLog }),
        states,
        'run-1',
        1000,
        { fence: controller.signal, assertBeforeWrite },
      ),
    ).rejects.toThrow(/lock lost/i);

    expect(getBattleLog).toHaveBeenCalledTimes(1);
    expect(assertBeforeWrite).toHaveBeenCalledTimes(1);
    expect(callsFor('player_battles', 'upsert')).toHaveLength(0);
  });
});

describe('recoverInterruptedSyncs', () => {
  it('delegates the whole read-check-write sequence to one atomic RPC', async () => {
    setHandlers({
      'rpc:recover_interrupted_syncs': (call) => {
        expect(call.payload).toEqual({ p_now: '2026-11-20T03:40:00.000Z' });
        return {
          data: { recoveredRuns: 2, clearedScopes: ['guild:guild-1', 'guild:guild-2'] },
        };
      },
    });

    const outcome = await recoverInterruptedSyncs(
      undefined as never,
      '2026-11-20T03:40:00.000Z',
    );

    expect(outcome).toEqual({
      recoveredRuns: 2,
      clearedScopes: ['guild:guild-1', 'guild:guild-2'],
    });
    expect(callsFor('rpc:recover_interrupted_syncs', 'select')).toHaveLength(1);
    expect(callsFor('sync_runs', 'select')).toHaveLength(0);
    expect(callsFor('sync_runs', 'update')).toHaveLength(0);
    expect(callsFor('sync_locks', 'select')).toHaveLength(0);
    expect(callsFor('sync_locks', 'update')).toHaveLength(0);
  });

  it('returns only the scopes the RPC actually cleared', async () => {
    setHandlers({
      'rpc:recover_interrupted_syncs': () => ({
        data: { recoveredRuns: 1, clearedScopes: ['guild:guild-stale'] },
      }),
    });

    const outcome = await recoverInterruptedSyncs(
      undefined as never,
      '2026-11-20T03:40:00.000Z',
    );

    expect(outcome).toEqual({ recoveredRuns: 1, clearedScopes: ['guild:guild-stale'] });
  });

  it('does nothing when the RPC reports no interrupted runs', async () => {
    setHandlers({ 'rpc:recover_interrupted_syncs': () => ({ data: { recoveredRuns: 0, clearedScopes: [] } }) });

    const outcome = await recoverInterruptedSyncs(undefined as never);

    expect(outcome).toEqual({ recoveredRuns: 0, clearedScopes: [] });
    expect(callsFor('rpc:recover_interrupted_syncs', 'select')).toHaveLength(1);
  });

  it('surfaces RPC failures instead of silently reporting success', async () => {
    setHandlers({ 'rpc:recover_interrupted_syncs': () => ({ error: { message: 'database offline' } }) });

    await expect(recoverInterruptedSyncs(undefined as never)).rejects.toThrow(/database offline/i);
  });
});
