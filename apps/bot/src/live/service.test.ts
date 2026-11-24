import type { BattleLogItem, BrawlStarsClient } from '@brawlhub/brawl-stars';
import { battleKey } from '@brawlhub/sync';
import type { Client } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/gateway.js', () => ({
  getSharedBrawlStarsClient: vi.fn(),
  readOfficialCachePolicy: () => ({ timeoutMs: 5_000, successTtlMs: 0, negativeTtlMs: 0 }),
}));

vi.mock('@brawlhub/sync', async () => {
  const actual = await vi.importActual<typeof import('@brawlhub/sync')>('@brawlhub/sync');
  return {
    ...actual,
    withTimeout: (promise: Promise<unknown>) => promise,
  };
});

vi.mock('../players/service.js', () => ({
  loadPlayerHistory: vi.fn(),
}));

import { loadPlayerHistory } from '../players/service.js';
import { runLiveBattlePoll, startLiveTracking, stopLiveTracking } from './service';

interface RecordedCall {
  readonly table: string;
  readonly op: string;
  readonly args: readonly unknown[];
}

interface ResponderCall extends RecordedCall {
  /** First argument of each write in this query chain (insert/update/upsert payloads). */
  readonly payloads: readonly unknown[];
  /** Column filters applied in this query chain. */
  readonly filters: ReadonlyArray<{
    readonly column: string;
    readonly values: readonly unknown[];
  }>;
}

function createDb(responder: (call: ResponderCall) => unknown) {
  const calls: RecordedCall[] = [];
  const from = vi.fn((table: string) => {
    const builder = {} as Record<string, unknown>;
    let op = 'select';
    const payloads: unknown[] = [];
    const filters: Array<{ column: string; values: readonly unknown[] }> = [];
    for (const method of ['select', 'eq', 'gt', 'in', 'update', 'insert', 'upsert', 'delete', 'limit', 'maybeSingle']) {
      builder[method] = (...args: unknown[]) => {
        if (['update', 'insert', 'upsert', 'delete', 'maybeSingle'].includes(method)) {
          op = method;
          if (args.length > 0) payloads.push(args[0]);
        } else if (['eq', 'in', 'gt'].includes(method)) {
          filters.push({ column: String(args[0]), values: args.slice(1) });
        }
        calls.push({ table, op, args });
        return builder;
      };
    }
    builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(
        responder({ table, op, args: [], payloads: [...payloads], filters: [...filters] }),
      ).then(resolve, reject);
    return builder;
  });
  return { db: { from }, calls };
}

const NOW = new Date('2026-11-22T12:00:00.000Z');
const PLAYER = { id: 'player-1', tag: 'PLAYER1', last_battle_at: '2026-11-22T11:00:00.000Z' };
const PLAYER_2 = { id: 'player-2', tag: 'PLAYER2', last_battle_at: '2026-11-22T11:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
});

const ACTIVE_A = {
  id: 'sub-a',
  guild_id: 'guild-a',
  channel_id: 'channel-a',
  discord_user_id: 'user-a',
  profile_id: 'profile-a',
  player_id: PLAYER.id,
  started_at: '2026-11-22T11:30:00.000Z',
  last_battle_seen_at: '2026-11-22T11:55:00.000Z',
  expires_at: '2026-11-22T14:30:00.000Z',
};
const ACTIVE_B = {
  ...ACTIVE_A,
  id: 'sub-b',
  guild_id: 'guild-b',
  channel_id: 'channel-b',
  discord_user_id: 'user-b',
  profile_id: 'profile-b',
};
const IDLE = {
  ...ACTIVE_A,
  id: 'sub-idle',
  guild_id: 'guild-idle',
  channel_id: 'channel-idle',
  discord_user_id: 'user-idle',
  last_battle_seen_at: '2026-11-22T09:00:00.000Z',
};
const NEVER_SEEN = {
  ...ACTIVE_A,
  id: 'sub-never',
  guild_id: 'guild-never',
  channel_id: 'channel-never',
  discord_user_id: 'user-never',
  started_at: '2026-11-22T09:00:00.000Z',
  last_battle_seen_at: null,
};
const CUTOFF_ADVANCED = {
  ...PLAYER,
  last_battle_at: '2026-11-22T12:05:00.000Z',
};

function subscription(id: string, guild: string, channel: string, user: string) {
  return { ...ACTIVE_A, id, guild_id: guild, channel_id: channel, discord_user_id: user };
}

function channelClient(channelId: string, guildId: string, send: ReturnType<typeof vi.fn>) {
  return {
    channels: {
      fetch: vi.fn(async () => ({
        id: channelId,
        guildId,
        isTextBased: () => true,
        send,
      })),
    },
  } as unknown as Client;
}

function pollInserts(calls: readonly RecordedCall[]) {
  return calls
    .filter((call) => call.table === 'live_battle_polls' && call.op === 'insert')
    .map(
      (call) =>
        call.args[0] as {
          guild_id: string;
          status: string;
          last_error?: string;
          collected_candidates?: number;
          stored_battles?: number;
          delivered_messages?: number;
          new_battles?: number;
        },
    );
}

/** The shared collector counts only rows actually returned by the insert. */
function storedBattles(call: ResponderCall) {
  if (call.table !== 'player_battles' || call.op !== 'upsert') return undefined;
  const rows = call.payloads[0];
  const count = Array.isArray(rows) ? rows.length : 0;
  return {
    data: Array.from({ length: count }, (_, index) => ({ id: `stored-battle-${index}` })),
    error: null,
  };
}

interface LedgerRow {
  readonly guild_id: string;
  readonly subscription_id: string;
  readonly player_id: string;
  readonly battle_key: string;
  readonly discord_message_id: string;
  readonly delivered_at: string;
}

/** Per-subscription delivery ledger mock; upserts ignore duplicates like the real table. */
function createLedger() {
  const rows = new Map<string, LedgerRow>();
  const upserts: LedgerRow[] = [];
  let failingSubscription: string | null = null;

  return {
    rows,
    upserts,
    failWritesFor(subscriptionId: string | null): void {
      failingSubscription = subscriptionId;
    },
    respond(call: ResponderCall) {
      if (call.table !== 'live_battle_deliveries') return undefined;
      if (call.op === 'select') {
        const subscriptionId = call.filters.find((filter) => filter.column === 'subscription_id')
          ?.values[0];
        return {
          data: [...rows.values()]
            .filter((row) => row.subscription_id === subscriptionId)
            .map((row) => ({ battle_key: row.battle_key })),
          error: null,
        };
      }
      if (call.op === 'upsert') {
        const payload = call.payloads[0] as LedgerRow | undefined;
        if (payload === undefined) return { data: null, error: null };
        upserts.push(payload);
        if (failingSubscription === payload.subscription_id) {
          return { data: null, error: { message: 'ledger write down' } };
        }
        const key = `${payload.subscription_id}|${payload.battle_key}`;
        if (!rows.has(key)) rows.set(key, payload);
        return { data: null, error: null };
      }
      return undefined;
    },
  };
}

function refreshedIdle(calls: readonly RecordedCall[]) {
  return calls.some(
    (call) =>
      call.table === 'guild_live_subscriptions' &&
      call.op === 'update' &&
      typeof (call.args[0] as { last_battle_seen_at?: unknown } | undefined)?.last_battle_seen_at ===
        'string',
  );
}

function battle(time: string, result: string): BattleLogItem {
  return {
    battleTime: time,
    event: { id: 1, mode: 'gemGrab', map: 'Some Map' },
    battle: { mode: 'gemGrab', type: 'ranked', result, trophyChange: result === 'victory' ? 8 : -5 },
  };
}

describe('runLiveBattlePoll', () => {
  it('batches one official call per player and posts only inside each embedded guild', async () => {
    const sentA: unknown[] = [];
    const sentB: unknown[] = [];
    const channelA = {
      id: 'channel-a',
      guildId: 'guild-a',
      isTextBased: () => true,
      send: vi.fn(async (payload: unknown) => {
        sentA.push(payload);
        return { id: `msg-a-${sentA.length}` };
      }),
    };
    const channelB = {
      id: 'channel-b',
      guildId: 'guild-b',
      isTextBased: () => true,
      send: vi.fn(async (payload: unknown) => {
        sentB.push(payload);
        return { id: `msg-b-${sentB.length}` };
      }),
    };
    const channels = new Map([
      ['channel-a', channelA],
      ['channel-b', channelB],
      ['channel-idle', { ...channelA, id: 'channel-idle', guildId: 'guild-idle' }],
    ]);
    const client = {
      channels: { fetch: vi.fn(async (id: string) => channels.get(id) ?? null) },
    } as unknown as Client;

    const api = {
      getBattleLog: vi.fn(async () => [
        battle('2026-11-22T11:45:00.000Z', 'victory'),
        battle('2026-11-22T11:50:00.000Z', 'defeat'),
      ]),
    } as unknown as BrawlStarsClient;

    const { db, calls } = createDb((call) => {
      const { table, op } = call;
      if (table === 'guild_live_subscriptions' && op === 'select') {
        return { data: [ACTIVE_A, ACTIVE_B, IDLE], error: null };
      }
      if (table === 'players' && op === 'select') return { data: [PLAYER], error: null };
      if (table === 'players' && op === 'maybeSingle') return { data: PLAYER, error: null };
      const storedResult = storedBattles(call);
      if (storedResult !== undefined) return storedResult;
      if (table === 'live_battle_deliveries' && op === 'select') return { data: [], error: null };
      return { data: null, error: null };
    });

    const outcome = await runLiveBattlePoll(client, { db: db as never, api, now: NOW });

    expect(api.getBattleLog).toHaveBeenCalledTimes(1);
    expect(api.getBattleLog).toHaveBeenCalledWith('PLAYER1');
    expect(outcome).toMatchObject({
      activeSubscriptions: 2,
      expiredSubscriptions: 1,
      playersPolled: 1,
      collectedCandidates: 2,
      storedBattles: 2,
      newBattles: 2,
      deliveredMessages: 4,
      delivered: 4,
    });
    expect(pollInserts(calls)).toMatchObject([
      {
        guild_id: 'guild-a',
        collected_candidates: 2,
        stored_battles: 2,
        delivered_messages: 2,
        new_battles: 2,
        status: 'completed',
      },
      {
        guild_id: 'guild-b',
        collected_candidates: 2,
        stored_battles: 2,
        delivered_messages: 2,
        new_battles: 2,
        status: 'completed',
      },
    ]);
    expect(sentA).toHaveLength(2);
    expect(sentB).toHaveLength(2);
    expect(
      calls.filter(
        (call) =>
          call.table === 'player_battles' &&
          call.op === 'upsert' &&
          Array.isArray(call.args[0]),
      ),
    ).toHaveLength(1);
    expect(calls.filter((call) => call.table === 'live_battle_polls' && call.op === 'insert')).toHaveLength(2);
    expect(calls.filter((call) => call.table === 'live_battle_deliveries' && call.op === 'upsert')).toHaveLength(4);
    const deactivated = calls.find(
      (call) =>
        call.table === 'guild_live_subscriptions' &&
        call.op === 'update' &&
        call.args[0] !== undefined &&
        (call.args[0] as { active?: boolean }).active === false,
    );
    expect(deactivated).toBeDefined();
  });

  it('skips posts when a delivery is already recorded', async () => {
    const send = vi.fn(async () => ({ id: 'message-1' }));
    const client = {
      channels: {
        fetch: vi.fn(async () => ({
          id: 'channel-a',
          guildId: 'guild-a',
          isTextBased: () => true,
          send,
        })),
      },
    } as unknown as Client;
    const api = {
      getBattleLog: vi.fn(async () => [battle('2026-11-22T11:45:00.000Z', 'victory')]),
    } as unknown as BrawlStarsClient;
    const { db } = createDb(({ table, op }) => {
      if (table === 'guild_live_subscriptions' && op === 'select') return { data: [ACTIVE_A], error: null };
      if (table === 'players' && op === 'select') return { data: [PLAYER], error: null };
      if (table === 'players' && op === 'maybeSingle') return { data: PLAYER, error: null };
      if (table === 'live_battle_deliveries' && op === 'select') {
        return {
          data: [{ battle_key: battleKey(battle('2026-11-22T11:45:00.000Z', 'victory')) }],
          error: null,
        };
      }
      return { data: null, error: null };
    });

    const outcome = await runLiveBattlePoll(client, { db: db as never, api, now: NOW });

    expect(send).not.toHaveBeenCalled();
    expect(outcome.delivered).toBe(0);
  });

  it('expires a subscription with no first battle once the idle window passes', async () => {
    const api = { getBattleLog: vi.fn(async () => []) } as unknown as BrawlStarsClient;
    const { db, calls } = createDb(({ table, op }) => {
      if (table === 'guild_live_subscriptions' && op === 'select') {
        return { data: [NEVER_SEEN], error: null };
      }
      return { data: null, error: null };
    });

    const outcome = await runLiveBattlePoll({} as Client, { db: db as never, api, now: NOW });

    expect(outcome).toMatchObject({ expiredSubscriptions: 1, playersPolled: 0 });
    expect(api.getBattleLog).not.toHaveBeenCalled();
    expect(
      calls.some(
        (call) =>
          call.table === 'guild_live_subscriptions' &&
          call.op === 'update' &&
          (call.args[0] as { active?: boolean }).active === false,
      ),
    ).toBe(true);
  });

  it('delivers from the official log even if a sync already advanced the shared cutoff', async () => {
    const row = subscription('sub-cutoff', 'guild-cutoff', 'channel-cutoff', 'user-cutoff');
    const send = vi.fn(async () => ({ id: 'cutoff-message-1' }));
    const api = {
      getBattleLog: vi.fn(async () => [battle('2026-11-22T11:45:00.000Z', 'victory')]),
    } as unknown as BrawlStarsClient;
    const { db } = createDb(({ table, op }) => {
      if (table === 'guild_live_subscriptions' && op === 'select') return { data: [row], error: null };
      if (table === 'players' && op === 'select') return { data: [CUTOFF_ADVANCED], error: null };
      if (table === 'players' && op === 'maybeSingle') return { data: CUTOFF_ADVANCED, error: null };
      if (table === 'player_battles' && op === 'select') return { data: [], error: null };
      if (table === 'live_battle_deliveries' && op === 'select') return { data: [], error: null };
      return { data: null, error: null };
    });

    const outcome = await runLiveBattlePoll(
      channelClient('channel-cutoff', 'guild-cutoff', send),
      { db: db as never, api, now: NOW },
    );

    expect(outcome.delivered).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the delivery ledger cannot be read', async () => {
    const row = subscription('sub-ledger-read', 'guild-ledger-read', 'channel-ledger-read', 'user-ledger-read');
    const send = vi.fn(async () => ({ id: 'unexpected' }));
    const api = {
      getBattleLog: vi.fn(async () => [battle('2026-11-22T11:46:00.000Z', 'victory')]),
    } as unknown as BrawlStarsClient;
    const { db, calls } = createDb(({ table, op }) => {
      if (table === 'guild_live_subscriptions' && op === 'select') return { data: [row], error: null };
      if (table === 'players' && op === 'select') return { data: [PLAYER], error: null };
      if (table === 'players' && op === 'maybeSingle') return { data: PLAYER, error: null };
      if (table === 'live_battle_deliveries' && op === 'select') {
        return { data: null, error: { message: 'ledger down' } };
      }
      return { data: null, error: null };
    });

    const outcome = await runLiveBattlePoll(
      channelClient('channel-ledger-read', 'guild-ledger-read', send),
      { db: db as never, api, now: NOW },
    );

    expect(outcome.delivered).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(pollInserts(calls)[0]).toMatchObject({
      status: 'failed',
      last_error: expect.stringContaining('ledger down'),
    });
    expect(refreshedIdle(calls)).toBe(false);
  });

  it('surfaces ledger write failures without reposting the same battle', async () => {
    const row = subscription('sub-ledger-write', 'guild-ledger-write', 'channel-ledger-write', 'user-ledger-write');
    const send = vi.fn(async () => ({ id: 'ledger-write-message-1' }));
    const api = {
      getBattleLog: vi.fn(async () => [battle('2026-11-22T11:47:00.000Z', 'victory')]),
    } as unknown as BrawlStarsClient;
    let ledgerWriteFails = true;
    const { db, calls } = createDb(({ table, op }) => {
      if (table === 'guild_live_subscriptions' && op === 'select') return { data: [row], error: null };
      if (table === 'players' && op === 'select') return { data: [PLAYER], error: null };
      if (table === 'players' && op === 'maybeSingle') return { data: PLAYER, error: null };
      if (table === 'player_battles' && op === 'select') return { data: [], error: null };
      if (table === 'live_battle_deliveries' && op === 'select') return { data: [], error: null };
      if (table === 'live_battle_deliveries' && op === 'upsert' && ledgerWriteFails) {
        return { data: null, error: { message: 'ledger write down' } };
      }
      return { data: null, error: null };
    });
    const client = channelClient('channel-ledger-write', 'guild-ledger-write', send);

    const first = await runLiveBattlePoll(client, { db: db as never, api, now: NOW });
    expect(first.delivered).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(pollInserts(calls)[0]).toMatchObject({
      status: 'failed',
      last_error: expect.stringContaining('ledger write down'),
    });
    expect(refreshedIdle(calls)).toBe(false);

    ledgerWriteFails = false;
    const second = await runLiveBattlePoll(client, { db: db as never, api, now: NOW });

    expect(second.delivered).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(pollInserts(calls)[1]?.status).toBe('completed');
  });

  it('reconciles a failed ledger write only under its own guild and subscription', async () => {
    // Healthy subscription is processed first: the buggy loop used to consume
    // the failing subscription's pending entry and attribute it to this row.
    const healthy = {
      ...ACTIVE_B,
      id: 'sub-reconcile-b',
      guild_id: 'guild-reconcile-b',
      channel_id: 'channel-reconcile-b',
      discord_user_id: 'user-reconcile-b',
    };
    const failing = {
      ...ACTIVE_A,
      id: 'sub-reconcile-a',
      guild_id: 'guild-reconcile-a',
      channel_id: 'channel-reconcile-a',
      discord_user_id: 'user-reconcile-a',
    };
    const item = battle('2026-11-22T11:48:13.000Z', 'victory');
    const key = battleKey(item);
    const sentFailing = vi.fn(async (_payload: unknown) => ({ id: 'reconcile-msg-a' }));
    const sentHealthy = vi.fn(async (_payload: unknown) => ({ id: 'reconcile-msg-b' }));
    const channels = new Map([
      [
        healthy.channel_id,
        {
          id: healthy.channel_id,
          guildId: healthy.guild_id,
          isTextBased: () => true,
          send: sentHealthy,
        },
      ],
      [
        failing.channel_id,
        {
          id: failing.channel_id,
          guildId: failing.guild_id,
          isTextBased: () => true,
          send: sentFailing,
        },
      ],
    ]);
    const client = {
      channels: { fetch: vi.fn(async (id: string) => channels.get(id) ?? null) },
    } as unknown as Client;
    const api = { getBattleLog: vi.fn(async () => [item]) } as unknown as BrawlStarsClient;
    const ledger = createLedger();
    ledger.failWritesFor(failing.id);
    const { db } = createDb((call) => {
      const ledgerResult = ledger.respond(call);
      if (ledgerResult !== undefined) return ledgerResult;
      const storedResult = storedBattles(call);
      if (storedResult !== undefined) return storedResult;
      const { table, op } = call;
      if (table === 'guild_live_subscriptions' && op === 'select') {
        return { data: [healthy, failing], error: null };
      }
      if (table === 'players' && op === 'select') return { data: [PLAYER], error: null };
      if (table === 'players' && op === 'maybeSingle') return { data: PLAYER, error: null };
      return { data: null, error: null };
    });

    const first = await runLiveBattlePoll(client, { db: db as never, api, now: NOW });
    expect(first.delivered).toBe(1);
    expect(sentFailing).toHaveBeenCalledTimes(1);
    expect(sentHealthy).toHaveBeenCalledTimes(1);
    expect(sentFailing.mock.calls[0]?.[0]).toMatchObject({ allowedMentions: { parse: [] } });
    expect(sentHealthy.mock.calls[0]?.[0]).toMatchObject({ allowedMentions: { parse: [] } });

    ledger.failWritesFor(null);
    const second = await runLiveBattlePoll(client, { db: db as never, api, now: NOW });

    expect(second.delivered).toBe(0);
    expect(sentFailing).toHaveBeenCalledTimes(1);
    expect(sentHealthy).toHaveBeenCalledTimes(1);
    expect(ledger.rows.get(`${failing.id}|${key}`)).toMatchObject({
      guild_id: failing.guild_id,
      subscription_id: failing.id,
      player_id: PLAYER.id,
      battle_key: key,
      discord_message_id: 'reconcile-msg-a',
    });
    expect(ledger.rows.get(`${healthy.id}|${key}`)).toMatchObject({
      guild_id: healthy.guild_id,
      subscription_id: healthy.id,
      player_id: PLAYER.id,
      battle_key: key,
      discord_message_id: 'reconcile-msg-b',
    });
    expect(
      ledger.upserts.some(
        (upsert) =>
          upsert.subscription_id === healthy.id && upsert.discord_message_id === 'reconcile-msg-a',
      ),
    ).toBe(false);
    expect(
      ledger.upserts.some(
        (upsert) =>
          upsert.subscription_id === failing.id && upsert.discord_message_id === 'reconcile-msg-a',
      ),
    ).toBe(true);
  });

  it('delivers a pre-start battle only to subscriptions that began before it', async () => {
    const item = battle('2026-11-22T11:43:27.000Z', 'defeat');
    const key = battleKey(item);
    const freshRow = {
      ...ACTIVE_A,
      id: 'sub-start-fresh',
      guild_id: 'guild-start-fresh',
      channel_id: 'channel-start-fresh',
      discord_user_id: 'user-start-fresh',
      started_at: '2026-11-22T11:45:00.000Z',
    };
    const earlierRow = {
      ...ACTIVE_A,
      id: 'sub-start-earlier',
      guild_id: 'guild-start-earlier',
      channel_id: 'channel-start-earlier',
      discord_user_id: 'user-start-earlier',
      started_at: '2026-11-22T11:30:00.000Z',
    };
    const sentFresh = vi.fn(async () => ({ id: 'start-fresh-msg' }));
    const sentEarlier = vi.fn(async () => ({ id: 'start-earlier-msg' }));
    const channels = new Map([
      [
        freshRow.channel_id,
        {
          id: freshRow.channel_id,
          guildId: freshRow.guild_id,
          isTextBased: () => true,
          send: sentFresh,
        },
      ],
      [
        earlierRow.channel_id,
        {
          id: earlierRow.channel_id,
          guildId: earlierRow.guild_id,
          isTextBased: () => true,
          send: sentEarlier,
        },
      ],
    ]);
    const client = {
      channels: { fetch: vi.fn(async (id: string) => channels.get(id) ?? null) },
    } as unknown as Client;
    const api = { getBattleLog: vi.fn(async () => [item]) } as unknown as BrawlStarsClient;
    const ledger = createLedger();
    const { db, calls } = createDb((call) => {
      const ledgerResult = ledger.respond(call);
      if (ledgerResult !== undefined) return ledgerResult;
      const storedResult = storedBattles(call);
      if (storedResult !== undefined) return storedResult;
      const { table, op } = call;
      if (table === 'guild_live_subscriptions' && op === 'select') {
        return { data: [freshRow, earlierRow], error: null };
      }
      if (table === 'players' && op === 'select') return { data: [PLAYER], error: null };
      if (table === 'players' && op === 'maybeSingle') return { data: PLAYER, error: null };
      return { data: null, error: null };
    });

    const outcome = await runLiveBattlePoll(client, { db: db as never, api, now: NOW });

    expect(outcome).toMatchObject({
      collectedCandidates: 1,
      storedBattles: 1,
      newBattles: 1,
      deliveredMessages: 1,
      delivered: 1,
    });
    expect(sentFresh).not.toHaveBeenCalled();
    expect(sentEarlier).toHaveBeenCalledTimes(1);
    expect(ledger.rows.has(`${freshRow.id}|${key}`)).toBe(false);
    expect(ledger.rows.has(`${earlierRow.id}|${key}`)).toBe(true);
    expect(pollInserts(calls)).toMatchObject([
      {
        guild_id: freshRow.guild_id,
        collected_candidates: 1,
        stored_battles: 1,
        delivered_messages: 0,
        new_battles: 1,
      },
      {
        guild_id: earlierRow.guild_id,
        collected_candidates: 1,
        stored_battles: 1,
        delivered_messages: 1,
        new_battles: 1,
      },
    ]);
  });

  it('excludes older official history after a subscription is renewed', async () => {
    const inSession = battle('2026-11-22T11:46:37.000Z', 'victory');
    const lateOldBattle = battle('2026-11-22T11:41:11.000Z', 'defeat');
    const row = {
      ...ACTIVE_A,
      id: 'sub-renew',
      guild_id: 'guild-renew',
      channel_id: 'channel-renew',
      discord_user_id: 'user-renew',
      started_at: '2026-11-22T11:30:00.000Z',
      last_battle_seen_at: null,
    };
    const send = vi.fn(async () => ({ id: 'renew-msg-1' }));
    const getBattleLog = vi.fn(async () => [inSession]);
    const api = { getBattleLog } as unknown as BrawlStarsClient;
    const ledger = createLedger();
    const { db } = createDb((call) => {
      const ledgerResult = ledger.respond(call);
      if (ledgerResult !== undefined) return ledgerResult;
      const storedResult = storedBattles(call);
      if (storedResult !== undefined) return storedResult;
      const { table, op } = call;
      if (table === 'guild_live_subscriptions' && op === 'select') return { data: [row], error: null };
      if (table === 'players' && op === 'select') return { data: [PLAYER], error: null };
      if (table === 'players' && op === 'maybeSingle') return { data: PLAYER, error: null };
      return { data: null, error: null };
    });
    const client = channelClient(row.channel_id, row.guild_id, send);

    const first = await runLiveBattlePoll(client, { db: db as never, api, now: NOW });
    expect(first.delivered).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);

    // Renewal resets the session clock, so a late-arriving older battle is
    // emitted by the collector but must not be delivered to this subscription.
    row.started_at = '2026-11-22T11:50:00.000Z';
    getBattleLog.mockResolvedValue([inSession, lateOldBattle]);
    const second = await runLiveBattlePoll(client, { db: db as never, api, now: NOW });

    expect(second.collectedCandidates).toBe(2);
    expect(second.delivered).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ledger.rows.size).toBe(1);
    expect(ledger.rows.has(`${row.id}|${battleKey(lateOldBattle)}`)).toBe(false);
  });

  it('reports candidate, stored and delivered counts independently', async () => {
    const items = [
      battle('2026-11-22T11:49:01.000Z', 'victory'),
      battle('2026-11-22T11:49:02.000Z', 'defeat'),
    ];
    const row = subscription('sub-metrics', 'guild-metrics', 'channel-metrics', 'user-metrics');
    const send = vi.fn(async () => ({ id: 'metrics-msg' }));
    const api = { getBattleLog: vi.fn(async () => items) } as unknown as BrawlStarsClient;
    const { db, calls } = createDb((call) => {
      if (call.table === 'player_battles' && call.op === 'upsert') {
        const rows = call.payloads[0];
        return {
          data: Array.from({ length: Array.isArray(rows) ? 1 : 0 }, (_, index) => ({
            id: `metrics-stored-${index}`,
          })),
          error: null,
        };
      }
      const { table, op } = call;
      if (table === 'guild_live_subscriptions' && op === 'select') return { data: [row], error: null };
      if (table === 'players' && op === 'select') return { data: [PLAYER], error: null };
      if (table === 'players' && op === 'maybeSingle') return { data: PLAYER, error: null };
      return { data: null, error: null };
    });

    const outcome = await runLiveBattlePoll(
      channelClient(row.channel_id, row.guild_id, send),
      { db: db as never, api, now: NOW },
    );

    expect(send).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({
      collectedCandidates: 2,
      storedBattles: 1,
      newBattles: 1,
      deliveredMessages: 2,
      delivered: 2,
    });
    expect(pollInserts(calls)[0]).toMatchObject({
      collected_candidates: 2,
      stored_battles: 1,
      new_battles: 1,
      delivered_messages: 2,
      status: 'completed',
    });
  });

  it('keeps newBattles as the running stored total across multiple players', async () => {
    const rows = [
      { ...subscription('sub-multi-1', 'guild-multi-1', 'channel-multi-1', 'user-multi-1') },
      {
        ...subscription('sub-multi-2', 'guild-multi-2', 'channel-multi-2', 'user-multi-2'),
        player_id: PLAYER_2.id,
      },
    ];
    const getBattleLog = vi.fn(async (tag: string) => [
      battle(
        tag === PLAYER.tag
          ? '2026-11-22T11:47:00.000Z'
          : '2026-11-22T11:48:00.000Z',
        'victory',
      ),
    ]);
    const api = { getBattleLog } as unknown as BrawlStarsClient;
    const { db, calls } = createDb((call) => {
      const storedResult = storedBattles(call);
      if (storedResult !== undefined) return storedResult;
      const { table, op } = call;
      if (table === 'guild_live_subscriptions' && op === 'select') return { data: rows, error: null };
      if (table === 'players' && op === 'select') {
        const requestedValues = call.filters.find((filter) => filter.column === 'id')?.values ?? [];
        const requestedIds = requestedValues.flatMap((value) =>
          Array.isArray(value) ? value : [value],
        );
        return {
          data: [PLAYER, PLAYER_2].filter((player) => requestedIds.includes(player.id)),
          error: null,
        };
      }
      return { data: null, error: null };
    });
    const client = {
      channels: { fetch: vi.fn(async () => null) },
    } as unknown as Client;

    const outcome = await runLiveBattlePoll(client, { db: db as never, api, now: NOW });

    expect(getBattleLog).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({
      activeSubscriptions: 2,
      playersPolled: 2,
      collectedCandidates: 2,
      storedBattles: 2,
      newBattles: 2,
      deliveredMessages: 0,
    });
    expect(pollInserts(calls).map((poll) => poll.new_battles)).toEqual([1, 1]);
  });
});

describe('live subscription opt-in', () => {
  const storePlayer = {
    kind: 'ok',
    value: {
      player: {
        id: 'player-1',
        tag: 'PLAYER1',
        name: 'Tester',
        trophies: 100,
        highestTrophies: 200,
        lastSyncedAt: '2026-11-22T11:00:00.000Z',
        lastBattleAt: null,
      },
      points: [],
      period: '7d',
    },
  };

  it('creates a guild-scoped subscription with a three-hour expiry', async () => {
    vi.mocked(loadPlayerHistory).mockResolvedValue(storePlayer as never);
    const { db, calls } = createDb(({ table, op }) => {
      if (table === 'profiles' && op === 'select') return { data: [{ id: 'profile-1' }], error: null };
      if (table === 'guild_live_subscriptions' && op === 'select') return { data: [], error: null };
      return { data: null, error: null };
    });

    const result = await startLiveTracking({
      db: db as never,
      guildId: 'guild-a',
      channelId: 'channel-a',
      discordUserId: 'user-a',
      tag: 'PLAYER1',
      now: NOW,
    });

    expect(result).toMatchObject({ kind: 'ok', playerTag: 'PLAYER1' });
    const insert = calls.find(
      (call) => call.table === 'guild_live_subscriptions' && call.op === 'insert',
    );
    expect(insert?.args[0]).toMatchObject({
      guild_id: 'guild-a',
      channel_id: 'channel-a',
      discord_user_id: 'user-a',
      player_id: 'player-1',
      profile_id: 'profile-1',
      active: true,
      expires_at: '2026-11-22T15:00:00.000Z',
    });
  });

  it('renews the full session clock when the same subscription opts in again', async () => {
    vi.mocked(loadPlayerHistory).mockResolvedValue(storePlayer as never);
    const existing = {
      id: 'sub-existing',
      started_at: '2026-11-22T08:00:00.000Z',
      last_battle_seen_at: '2026-11-22T08:30:00.000Z',
      expires_at: '2026-11-22T11:00:00.000Z',
    };
    const { db, calls } = createDb(({ table, op }) => {
      if (table === 'profiles' && op === 'select') return { data: [{ id: 'profile-1' }], error: null };
      if (table === 'guild_live_subscriptions' && op === 'select') return { data: [existing], error: null };
      return { data: null, error: null };
    });

    const result = await startLiveTracking({
      db: db as never,
      guildId: 'guild-a',
      channelId: 'channel-a',
      discordUserId: 'user-a',
      tag: 'PLAYER1',
      now: NOW,
    });

    expect(result).toMatchObject({ kind: 'ok' });
    const update = calls.find(
      (call) => call.table === 'guild_live_subscriptions' && call.op === 'update',
    );
    expect(update?.args[0]).toMatchObject({
      active: true,
      expires_at: '2026-11-22T15:00:00.000Z',
      started_at: NOW.toISOString(),
      last_battle_seen_at: null,
      profile_id: 'profile-1',
    });
    expect(calls.some((call) => call.table === 'guild_live_subscriptions' && call.op === 'insert')).toBe(false);
  });

  it('rejects missing guild and channel ids before touching the database', async () => {
    const { db, calls } = createDb(() => ({ data: null, error: null }));
    const base = {
      db: db as never,
      channelId: 'channel-a',
      discordUserId: 'user-a',
      tag: 'PLAYER1',
    };

    await expect(startLiveTracking({ ...base, guildId: '  ' })).resolves.toEqual({
      kind: 'guild-required',
    });
    await expect(
      startLiveTracking({ ...base, guildId: 'guild-a', channelId: '  ' }),
    ).resolves.toEqual({ kind: 'channel-required' });
    expect(calls).toHaveLength(0);
    expect(loadPlayerHistory).not.toHaveBeenCalled();
  });

  it('deletes only the current guild/channel/user subscriptions on stop', async () => {
    const { db, calls } = createDb(({ table, op }) => {
      if (table === 'guild_live_subscriptions' && op === 'delete') {
        return { data: [{ player_id: 'player-1' }], error: null };
      }
      return { data: null, error: null };
    });

    const result = await stopLiveTracking({
      db: db as never,
      guildId: 'guild-a',
      channelId: 'channel-a',
      discordUserId: 'user-a',
    });

    expect(result).toEqual({ kind: 'ok', stopped: 1 });
    expect(calls.some((call) => call.table === 'guild_live_subscriptions' && call.op === 'delete')).toBe(true);
  });
});
