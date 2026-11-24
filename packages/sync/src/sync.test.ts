import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BattleLogItem, BrawlStarsClient, Club, ClubMember } from '@brawlhub/brawl-stars';
import { recoverInterruptedSyncs, registerClubs, runSync } from './index';

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
    'rpc:apply_membership_transition': () => ({ data: 'event-rpc-1' }),
    ...handlers,
  };
}

function callsFor(table: string, op: Call['op']): Call[] {
  return fake.state.calls.filter((call) => call.table === table && call.op === op);
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
    // Membership transition committed before snapshot failure; retry must not duplicate events.
    expect(callsFor('rpc:release_sync_lock', 'select')).toHaveLength(2);
  });

  it('does not resend a Discord notification when a retried event is already claimed', async () => {
    setupSuccessfulSync({ earlierRunFailed: true, forceOldMembership: true });
    fake.state.handlers['membership_events:select'] = () => ({
      data: [
        {
          id: 'event-1',
          player_id: 'player-1',
          event_type: 'transfer',
          from_club_id: 'club-old',
          to_club_id: 'club-1',
          detected_at: T0.toISOString(),
          player: { tag: 'G2P9', name: 'Player One' },
          from_club: { name: 'Old Club' },
          to_club: { name: 'Alpha' },
        },
      ],
    });
    fake.state.handlers['notifications:select'] = () => ({ data: [] });

    let claimAttempts = 0;
    let sends = 0;
    const delivered: Array<{
      clubName: string;
      toClubName: string | undefined;
      occurredAt: string | undefined;
      remainingMembers: number | undefined;
    }> = [];
    fake.state.handlers['notifications:insert'] = () => {
      claimAttempts += 1;
      if (claimAttempts > 1) {
        return { error: { code: '23505', message: 'duplicate key value' } };
      }
      return { data: [{ id: 'notification-1' }] };
    };
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
    expect(callsFor('notifications', 'insert')[0]?.payload).toMatchObject({
      event_id: 'event-1',
      delivery_status: 'pending',
    });
    expect(callsFor('notifications', 'update')[0]?.payload).toMatchObject({
      delivery_status: 'sent',
      discord_message_id: 'message-1',
    });

    const second = await runSync({ now: T0, guildId: 'guild-test', notifier });
    expect(second.status).toBe('completed');
    expect(second.notificationsSent).toBe(0);
    expect(sends).toBe(1);
    expect(claimAttempts).toBe(2);
    expect(delivered[0]?.clubName).toBe('Alpha');
    expect(delivered[0]?.toClubName).toBe('Alpha');
    expect(delivered[0]?.occurredAt).toBe(T0.toISOString());
    expect(delivered[0]?.remainingMembers).toBe(1);
  });

  it('announces an event committed by a failed run when a later run gets a new run id', async () => {
    setupSuccessfulSync({ failFirstSnapshot: true, forceOldMembership: true });
    const failed = await runSync({ now: T0, guildId: 'guild-test' });
    expect(failed.status).toBe('failed');

    const orphanedEvent = {
      id: 'orphan-event',
      player_id: 'player-1',
      event_type: 'transfer',
      from_club_id: 'club-old',
      to_club_id: 'club-1',
      detected_at: T0.toISOString(),
      player: { tag: 'G2P9', name: 'Player One' },
      from_club: { name: 'Old Club' },
      to_club: { name: 'Alpha' },
    };
    fake.state.handlers['membership_events:select'] = () => ({ data: [orphanedEvent] });
    fake.state.handlers['notifications:select'] = () => ({ data: [] });
    fake.state.handlers['notifications:insert'] = () => ({ data: [{ id: 'notification-orphan' }] });
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
    fake.state.handlers['membership_events:select'] = () => ({
      data: [
        {
          id: 'event-interrupted',
          player_id: 'player-1',
          event_type: 'join',
          from_club_id: null,
          to_club_id: 'club-1',
          detected_at: T0.toISOString(),
          player: { tag: 'G2P9', name: 'Player One' },
          to_club: { name: 'Alpha' },
        },
      ],
    });
    fake.state.handlers['notifications:select'] = (call) => ({
      data: Array.isArray(call.filters['event_id'])
        ? []
        : [{ id: 'claim-pending', delivery_status: 'pending' }],
    });
    fake.state.handlers['notifications:insert'] = () => ({
      error: { code: '23505', message: 'duplicate key value' },
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
    expect(callsFor('notifications', 'insert')[0]?.payload).toMatchObject({
      delivery_status: 'pending',
    });
    expect(callsFor('notifications', 'update')[0]?.payload).toMatchObject({
      delivery_status: 'sent',
      discord_message_id: 'message-1',
    });
  });

  it('filters claimed events before applying the announcement limit', async () => {
    setupSuccessfulSync();
    const event = (id: string, offsetMs: number) => ({
      id,
      player_id: 'player-1',
      event_type: 'join',
      from_club_id: null,
      to_club_id: 'club-1',
      detected_at: new Date(T0.getTime() - offsetMs).toISOString(),
      player: { tag: 'G2P9', name: 'Player One' },
      to_club: { name: 'Alpha' },
    });
    const claimed = Array.from({ length: 20 }, (_, index) => event(`claimed-${index}`, index));
    const pending = event('pending-old', 60 * 60 * 1000);
    fake.state.handlers['membership_events:select'] = () => ({ data: [...claimed, pending] });
    fake.state.handlers['notifications:select'] = (call) => ({
      data: Array.isArray(call.filters['event_id'])
        ? claimed.map((item) => ({ event_id: item.id, delivery_status: 'sent' }))
        : [],
    });
    fake.state.handlers['notifications:insert'] = () => ({ data: [{ id: 'claim-pending-old' }] });
    fake.state.handlers['notifications:update'] = () => ({ data: [] });

    const delivered: string[] = [];
    const notifier = {
      channelId: 'channel-1',
      send: async (input: { eventId: string }) => {
        delivered.push(input.eventId);
        return 'message-late';
      },
    };

    const result = await runSync({ now: T0, guildId: 'guild-test', notifier });

    expect(result.status).toBe('completed');
    expect(result.notificationsSent).toBe(1);
    expect(delivered).toEqual(['pending-old']);
    expect(callsFor('membership_events', 'select')).toHaveLength(2);
    expect(callsFor('membership_events', 'select').every((call) => call.limit === undefined)).toBe(
      true,
    );
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

describe('recoverInterruptedSyncs', () => {
  it('fails abandoned runs and clears their lock scopes', async () => {
    setHandlers({
      'sync_runs:select': () => ({
        data: [
          { id: 'run-1', scope: 'guild:guild-1' },
          { id: 'run-2', scope: 'guild:guild-1' },
        ],
      }),
      'sync_locks:select': () => ({
        data: [
          {
            scope: 'guild:guild-1',
            locked_by: 'old-token',
            locked_until: '2026-11-20T03:00:00.000Z',
          },
        ],
      }),
      'sync_runs:update': () => ({ data: [] }),
      'sync_locks:update': () => ({ data: [] }),
    });

    const outcome = await recoverInterruptedSyncs(
      undefined as never,
      '2026-11-20T03:40:00.000Z',
    );

    expect(outcome).toEqual({
      recoveredRuns: 2,
      clearedScopes: ['guild:guild-1'],
    });
    const runUpdates = callsFor('sync_runs', 'update');
    expect(runUpdates).toHaveLength(1);
    expect(runUpdates[0]?.payload).toMatchObject({
      status: 'failed',
      finished_at: '2026-11-20T03:40:00.000Z',
    });
    const lockUpdates = callsFor('sync_locks', 'update');
    expect(lockUpdates).toHaveLength(1);
    expect(lockUpdates[0]?.payload).toEqual({
      locked_by: null,
      locked_at: null,
      locked_until: null,
    });
  });

  it('leaves runs alone when another process still holds their lock', async () => {
    setHandlers({
      'sync_runs:select': () => ({
        data: [
          { id: 'run-active', scope: 'guild:guild-active' },
          { id: 'run-stale', scope: 'guild:guild-stale' },
        ],
      }),
      'sync_locks:select': () => ({
        data: [
          {
            scope: 'guild:guild-active',
            locked_by: 'live-token',
            locked_until: '2026-11-20T04:00:00.000Z',
          },
          {
            scope: 'guild:guild-stale',
            locked_by: null,
            locked_until: null,
          },
        ],
      }),
      'sync_runs:update': () => ({ data: [] }),
      'sync_locks:update': () => ({ data: [] }),
    });

    const outcome = await recoverInterruptedSyncs(
      undefined as never,
      '2026-11-20T03:40:00.000Z',
    );

    expect(outcome).toEqual({ recoveredRuns: 1, clearedScopes: ['guild:guild-stale'] });
    const runUpdate = callsFor('sync_runs', 'update')[0];
    expect(runUpdate?.filters['id']).toEqual(['run-stale']);
    expect(callsFor('sync_locks', 'update')[0]?.filters['scope']).toEqual(['guild:guild-stale']);
  });

  it('does nothing when no runs are interrupted', async () => {
    setHandlers({ 'sync_runs:select': () => ({ data: [] }) });

    const outcome = await recoverInterruptedSyncs(undefined as never);

    expect(outcome).toEqual({ recoveredRuns: 0, clearedScopes: [] });
    expect(callsFor('sync_locks', 'update')).toHaveLength(0);
  });
});
