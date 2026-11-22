import type { BattleLogItem, BrawlStarsClient } from '@brawlhub/brawl-stars';
import { battleKey } from '@brawlhub/sync';
import type { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

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

function createDb(responder: (call: RecordedCall) => unknown) {
  const calls: RecordedCall[] = [];
  const from = vi.fn((table: string) => {
    const builder = {} as Record<string, unknown>;
    let op = 'select';
    for (const method of ['select', 'eq', 'gt', 'in', 'update', 'insert', 'upsert', 'delete', 'limit', 'maybeSingle']) {
      builder[method] = (...args: unknown[]) => {
        if (['update', 'insert', 'upsert', 'delete', 'maybeSingle'].includes(method)) op = method;
        calls.push({ table, op, args });
        return builder;
      };
    }
    builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(responder({ table, op, args: [] })).then(resolve, reject);
    return builder;
  });
  return { db: { from }, calls };
}

const NOW = new Date('2026-11-22T12:00:00.000Z');
const PLAYER = { id: 'player-1', tag: 'PLAYER1', last_battle_at: '2026-11-22T11:00:00.000Z' };

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

    const { db, calls } = createDb(({ table, op }) => {
      if (table === 'guild_live_subscriptions' && op === 'select') {
        return { data: [ACTIVE_A, ACTIVE_B, IDLE], error: null };
      }
      if (table === 'players' && op === 'select') return { data: [PLAYER], error: null };
      if (table === 'players' && op === 'maybeSingle') return { data: PLAYER, error: null };
      if (table === 'player_battles' && op === 'select') return { data: [], error: null };
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
      newBattles: 2,
      delivered: 4,
    });
    expect(sentA).toHaveLength(2);
    expect(sentB).toHaveLength(2);
    expect(calls.filter((call) => call.table === 'player_battles' && call.op === 'upsert')).toHaveLength(1);
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
