import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrawlStarsClient, Club, ClubMember } from '@brawlhub/brawl-stars';
import { registerClubs, runSync } from './index';

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
    }),
  };
});

vi.mock('@brawlhub/brawl-stars', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brawlhub/brawl-stars')>();
  return {
    ...actual,
    createBrawlStarsClient: () => {
      if (fake.api.current === undefined) {
        throw new Error('Fake Brawl Stars client was not configured');
      }
      return fake.api.current;
    },
  };
});

function setHandlers(handlers: Record<string, Handler>): void {
  fake.state.handlers = handlers;
  fake.state.calls.length = 0;
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
  const club: Club = { tag: '#2C0Y', name: 'Alpha', trophies: 12_000 };
  return {
    getClub: async () => club,
    getClubMembers: async () => [defaultMember],
    getPlayer: async () => {
      throw new Error('getPlayer should not be called by default');
    },
    ...overrides,
  } as BrawlStarsClient;
}

const CLUB_ROW = { id: 'club-1', tag: '2C0Y', name: 'Alpha' };
const T0 = new Date('2026-01-01T00:00:00.000Z');

interface SuccessState {
  firstSnapshotSelect: boolean;
  runSelectCount: number;
  membershipOpen: boolean;
  clubHash: string | undefined;
  playerHash: string | undefined;
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
    membershipOpen: false,
    clubHash: undefined,
    playerHash: undefined,
    events: new Map<string, string>(),
  };

  setHandlers({
    'clubs:select': () => ({ data: [CLUB_ROW] }),
    'sync_runs:select': () => {
      state.runSelectCount += 1;
      if (options.earlierRunFailed === true && state.runSelectCount === 2) {
        return {
          data: {
            id: 'run-1',
            status: 'failed',
            started_at: T0.toISOString(),
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
      if (options.forceOldMembership === true) {
        return {
          data: {
            id: 'membership-old',
            club_id: 'club-old',
            player_id: 'player-1',
            role: 'member',
          },
        };
      }
      if (call.filters['player_id'] !== undefined) {
        return state.membershipOpen
          ? {
              data: {
                id: 'membership-1',
                club_id: 'club-1',
                player_id: 'player-1',
                role: 'member',
              },
            }
          : { data: null };
      }
      return {
        data: state.membershipOpen
          ? [
              {
                id: 'membership-1',
                club_id: 'club-1',
                player_id: 'player-1',
                role: 'member',
              },
            ]
          : [],
      };
    },
    'club_memberships:insert': () => {
      state.membershipOpen = true;
      return { data: [{ id: 'membership-1' }] };
    },
    'club_memberships:update': () => ({ data: [] }),
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
      return { data: state.clubHash === undefined ? null : [{ payload_hash: state.clubHash }] };
    },
    'club_snapshots:upsert': (call) => {
      state.clubHash = String(call.payload.payload_hash);
      return { data: [] };
    },
    'player_snapshots:select': () => ({
      data: state.playerHash === undefined ? null : [{ payload_hash: state.playerHash }],
    }),
    'player_snapshots:upsert': (call) => {
      state.playerHash = String(call.payload.payload_hash);
      return { data: [] };
    },
  });

  return state;
}

beforeEach(() => {
  fake.state.handlers = {};
  fake.state.calls.length = 0;
  fake.api.current = apiClient();
});

describe('registerClubs', () => {
  it('rejects duplicate tags in the input and duplicates already registered', async () => {
    setHandlers({
      'clubs:select': () => ({ data: [{ id: 'club-existing', tag: '2C0Y', name: 'Existing' }] }),
      'clubs:insert': (call) => ({ data: [{ id: `club-${String(call.payload.tag)}` }] }),
    });
    fake.api.current = apiClient({
      getClub: async () => ({ tag: '#G2P9', name: 'Bravo', trophies: 1000 }),
    });

    const result = await registerClubs(['#2c0y', '2C0Y', 'G2P9']);

    expect(result.registered).toBe(1);
    expect(
      result.rejected.some(
        (item) => item.tag === '2C0Y' && item.reason.toLowerCase().includes('duplicate'),
      ),
    ).toBe(true);
    expect(
      result.rejected.some(
        (item) => item.tag === '2C0Y' && item.reason.includes('already registered'),
      ),
    ).toBe(true);

    const inserts = callsFor('clubs', 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.payload.tag).toBe('G2P9');
  });
});

describe('runSync', () => {
  it('fails the run when the API returns an empty roster that contradicts club stats', async () => {
    setHandlers({
      'clubs:select': () => ({ data: [CLUB_ROW] }),
      'sync_runs:select': () => ({ data: null }),
      'sync_runs:upsert': () => ({ data: [{ id: 'run-1' }] }),
      'sync_runs:update': () => ({ data: [{ id: 'run-1' }] }),
    });
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
    expect(callsFor('membership_events', 'upsert')).toHaveLength(0);
    expect(callsFor('sync_runs', 'update')[0]?.payload.status).toBe('failed');
  });

  it('does not write a new snapshot when the API payload is unchanged', async () => {
    setupSuccessfulSync();

    const first = await runSync({ now: T0 });
    expect(first.status).toBe('completed');

    const second = await runSync({ now: new Date(T0.getTime() + 16 * 60_000) });
    expect(second.status).toBe('completed');
    expect(second.snapshotsWritten).toBe(0);

    expect(callsFor('club_snapshots', 'upsert')).toHaveLength(1);
    expect(callsFor('player_snapshots', 'upsert')).toHaveLength(1);
  });

  it('reuses the same run id on a retry without duplicating membership events', async () => {
    const state = setupSuccessfulSync({
      failFirstSnapshot: true,
      earlierRunFailed: true,
      forceOldMembership: true,
    });

    const first = await runSync({ now: T0 });
    expect(first.status).toBe('failed');
    expect(first.syncRunId).toBe('run-1');

    const second = await runSync({ now: T0 });
    expect(second.status).toBe('completed');
    expect(second.syncRunId).toBe('run-1');

    const eventWrites = callsFor('membership_events', 'upsert');
    expect(eventWrites.length).toBeGreaterThanOrEqual(2);
    expect(new Set(eventWrites.map((call) => call.payload.source_sync_run_id))).toEqual(
      new Set(['run-1']),
    );
    // The DB dedup key (mocked here) means both attempts resolve to one event.
    expect(state.events.size).toBe(1);
  });

  it('does not resend a Discord notification when a retried event is already claimed', async () => {
    setupSuccessfulSync({ earlierRunFailed: true, forceOldMembership: true });
    fake.state.handlers['membership_events:select'] = () => ({
      data: [
        {
          id: 'event-1',
          event_type: 'transfer',
          from_club_id: 'club-old',
          to_club_id: 'club-1',
        },
      ],
    });

    let claimAttempts = 0;
    let sends = 0;
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
      send: async () => {
        sends += 1;
        return `message-${sends}`;
      },
    };

    const first = await runSync({ now: T0, notifier });
    expect(first.status).toBe('completed');
    expect(first.notificationsSent).toBe(1);

    const second = await runSync({ now: T0, notifier });
    expect(second.status).toBe('completed');
    expect(second.notificationsSent).toBe(0);
    expect(sends).toBe(1);
    expect(claimAttempts).toBe(2);
  });
});
