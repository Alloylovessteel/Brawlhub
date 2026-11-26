import type { REST } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClubSummary } from '../types';

type DbFilter = readonly [column: string, value: unknown];
type DbResult = { data: unknown; error: unknown | null };

const mocks = vi.hoisted(() => ({
  loadClubSummaries: vi.fn(),
  getBotConfig: vi.fn(),
  loadGuildSettings: vi.fn(),
  setGuildOverviewMessageId: vi.fn(),
  post: vi.fn(),
  remove: vi.fn(),
  dbState: {
    select: undefined as undefined | ((filters: readonly DbFilter[]) => DbResult),
    update: undefined as
      | undefined
      | ((payload: Record<string, unknown>, filters: readonly DbFilter[]) => DbResult),
    calls: [] as Array<{
      table: string;
      op: 'select' | 'update';
      payload: Record<string, unknown>;
      filters: readonly DbFilter[];
    }>,
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@brawlhub/database', () => ({
  createTrustedClient: () => ({
    from: (table: string) => {
      let op: 'select' | 'update' | null = null;
      let payload: Record<string, unknown> = {};
      const filters: DbFilter[] = [];
      const run = (): DbResult => {
        const operation = op ?? 'select';
        mocks.dbState.calls.push({
          table,
          op: operation,
          payload: { ...payload },
          filters: [...filters],
        });
        return operation === 'select'
          ? (mocks.dbState.select?.(filters) ?? { data: [], error: null })
          : (mocks.dbState.update?.(payload, filters) ?? {
              data: [{ guild_id: 'guild-1' }],
              error: null,
            });
      };
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        is: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        gt: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        update: (next: Record<string, unknown>) => {
          op = 'update';
          payload = next;
          return builder;
        },
        then: (resolve: (value: DbResult) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
  }),
}));
vi.mock('@brawlhub/logging', () => ({ createLogger: () => mocks.logger }));
vi.mock('../../config', () => ({ getBotConfig: mocks.getBotConfig }));
vi.mock('../service', () => ({ loadClubSummaries: mocks.loadClubSummaries }));
vi.mock('../../admin/service', () => ({
  loadGuildSettings: mocks.loadGuildSettings,
  setGuildOverviewMessageId: mocks.setGuildOverviewMessageId,
}));
vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>();
  return {
    ...actual,
    REST: class {
      setToken(): this {
        return this;
      }
      post(...args: unknown[]): Promise<unknown> {
        return mocks.post(...args);
      }
      delete(...args: unknown[]): Promise<unknown> {
        return mocks.remove(...args);
      }
    },
    Routes: {
      channelMessages: (channelId: string) => `/channels/${channelId}/messages`,
      channelMessage: (channelId: string, messageId: string) =>
        `/channels/${channelId}/messages/${messageId}`,
    },
  };
});

import {
  postOverviewForGuild,
  readOverviewTargets,
  refreshOverviewNow,
} from './service';

function summary(index: number): ClubSummary {
  return {
    club: {
      id: `club-${index}`,
      tag: `TAG${index}`,
      name: `Club ${index}`,
      description: '',
      trophies: 1_000 + index,
      requiredTrophies: 30_000,
      memberCount: 30,
      lastSyncedAt: null,
    },
    totalTrophies: 1_000 + index,
    averageTrophies: 100_000,
    memberCount: 30,
    latestSyncAt: null,
    leader: null,
    trophyRange: null,
    rankedRange: null,
    megaPigEstimate: null,
    activeMembers24h: null,
  };
}

interface RestMocks {
  readonly rest: REST;
  readonly post: ReturnType<typeof vi.fn>;
  readonly patch: ReturnType<typeof vi.fn>;
  readonly remove: ReturnType<typeof vi.fn>;
}

function createRest(options: { post?: () => Promise<unknown>; remove?: () => Promise<unknown> } = {}): RestMocks {
  const post = vi.fn(options.post ?? (async () => ({ id: 'message-2' })));
  const patch = vi.fn(async () => ({ id: 'message-1' }));
  const remove = vi.fn(options.remove ?? (async () => undefined));
  return { rest: { post, patch, delete: remove } as unknown as REST, post, patch, remove };
}

function updatePayloads(): Array<Record<string, unknown>> {
  return mocks.dbState.calls
    .filter((call) => call.op === 'update')
    .map((call) => call.payload);
}

describe('postOverviewForGuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbState.calls.length = 0;
    mocks.dbState.select = undefined;
    mocks.dbState.update = undefined;
    mocks.loadClubSummaries.mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => summary(index)),
    );
    mocks.getBotConfig.mockReturnValue({
      emojis: {},
      playerProfileUrlTemplate: undefined,
      clubProfileUrlTemplate: undefined,
      token: 'token',
    });
  });

  it('posts a fresh message with every registered club, then deletes the old one', async () => {
    const { rest, post, patch, remove } = createRest();

    const messageId = await postOverviewForGuild({
      rest,
      guildId: 'guild-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      guildLabel: 'Krew',
      fields: [],
      token: 'token',
    });

    expect(mocks.loadClubSummaries).toHaveBeenCalledWith('guild-1');
    expect(messageId).toBe('message-2');
    expect(post).toHaveBeenCalledTimes(1);
    expect(patch).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[0]).toContain('/channels/channel-1/messages/message-1');

    const call = post.mock.calls[0];
    if (call === undefined) throw new Error('POST was not called');
    expect(call[0]).toContain('/channels/channel-1/messages');
    const body = call[1].body as {
      embeds: Array<{ fields?: unknown[] }>;
      allowed_mentions: { parse: string[] };
    };
    expect(body.embeds).toHaveLength(2);
    expect(
      body.embeds.reduce((total, embed) => total + (embed.fields?.length ?? 0), 0),
    ).toBe(30);
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it('does not delete anything when there is no previous overview message', async () => {
    const { rest, post, remove } = createRest();

    const messageId = await postOverviewForGuild({
      rest,
      guildId: 'guild-1',
      channelId: 'channel-1',
      messageId: null,
      guildLabel: 'Krew',
      fields: [],
      token: 'token',
    });

    expect(messageId).toBe('message-2');
    expect(post).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps the new message when deleting the old one fails', async () => {
    const remove = vi.fn(async () => {
      throw Object.assign(new Error('Missing Access'), { status: 403 });
    });
    const { rest, post } = createRest({ remove });

    const messageId = await postOverviewForGuild({
      rest,
      guildId: 'guild-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      guildLabel: 'Krew',
      fields: [],
      token: 'token',
    });

    expect(messageId).toBe('message-2');
    expect(post).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('leaves the old message in place when posting the new one fails', async () => {
    const post = vi.fn(async () => {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    });
    const { rest, remove } = createRest({ post });

    const messageId = await postOverviewForGuild({
      rest,
      guildId: 'guild-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      guildLabel: 'Krew',
      fields: [],
      token: 'token',
    });

    expect(messageId).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it('leaves the old message in place when Discord returns no new message ID', async () => {
    const { rest, remove } = createRest({ post: async () => ({}) });

    const messageId = await postOverviewForGuild({
      rest,
      guildId: 'guild-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      guildLabel: 'Krew',
      fields: [],
      token: 'token',
    });

    expect(messageId).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('readOverviewTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbState.calls.length = 0;
    mocks.dbState.select = undefined;
    mocks.dbState.update = undefined;
  });

  it('pages past 1000 guilds and keeps each target aligned with its guild', async () => {
    const rows = Array.from({ length: 1_501 }, (_, index) => {
      const guildId = `guild-${String(index).padStart(4, '0')}`;
      return {
        guild_id: guildId,
        overview_channel_id: `channel-${index}`,
        overview_message_id: null,
        overview_fields: [],
      };
    });
    mocks.dbState.select = (filters) => {
      const after = filters.find(([column]) => column === 'guild_id')?.[1];
      const page = typeof after === 'string'
        ? rows.filter((row) => row.guild_id > after)
        : rows;
      return { data: page.slice(0, 1_000), error: null };
    };

    const targets = await readOverviewTargets();

    expect(targets).toHaveLength(1_501);
    expect(targets[0]).toMatchObject({
      guildId: 'guild-0000',
      channelId: 'channel-0',
      messageId: null,
    });
    expect(targets[1_000]).toMatchObject({
      guildId: 'guild-1000',
      channelId: 'channel-1000',
    });
    expect(targets[1_500]).toMatchObject({
      guildId: 'guild-1500',
      channelId: 'channel-1500',
    });
    const selectCalls = mocks.dbState.calls.filter((call) => call.op === 'select');
    expect(selectCalls).toHaveLength(2);
    expect(selectCalls[1]?.filters).toContainEqual(['guild_id', 'guild-0999']);
  });

  it('keeps uncertain claims out of the sendable message ID', async () => {
    mocks.dbState.select = () => ({
      data: [{
        guild_id: 'guild-1',
        overview_channel_id: 'channel-1',
        overview_message_id: 'claim:claim-1:posting:1000:message-1',
        overview_fields: [],
      }],
      error: null,
    });

    const targets = await readOverviewTargets();

    expect(targets[0]).toMatchObject({
      messageId: null,
      claimMessageId: 'claim:claim-1:posting:1000:message-1',
    });
  });

  it('keeps a legacy claim uncertain instead of treating it as a message ID', async () => {
    mocks.dbState.select = () => ({
      data: [{
        guild_id: 'guild-1',
        overview_channel_id: 'channel-1',
        overview_message_id: 'claim:legacy-1',
        overview_fields: [],
      }],
      error: null,
    });

    const targets = await readOverviewTargets();

    expect(targets[0]).toMatchObject({
      messageId: null,
      claimMessageId: 'claim:legacy-1',
    });
  });
});

describe('refreshOverviewNow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbState.calls.length = 0;
    mocks.dbState.select = undefined;
    mocks.dbState.update = undefined;
    mocks.post.mockReset();
    mocks.post.mockResolvedValue({ id: 'message-2' });
    mocks.remove.mockReset();
    mocks.remove.mockResolvedValue(undefined);
    mocks.loadClubSummaries.mockResolvedValue([summary(1)]);
    mocks.getBotConfig.mockReturnValue({
      emojis: {},
      playerProfileUrlTemplate: undefined,
      clubProfileUrlTemplate: undefined,
      token: 'token',
    });
    mocks.loadGuildSettings.mockResolvedValue({
      overviewChannelId: 'channel-1',
      overviewMessageId: 'message-1',
      overviewFields: [],
    });
  });

  it('stages reserved and posting claims before the POST, then records the message', async () => {
    const result = await refreshOverviewNow('guild-1', 'Krew');

    expect(result).toEqual({ posted: true, messageId: 'message-2' });
    const payloads = updatePayloads();
    expect(payloads).toHaveLength(3);
    expect(String(payloads[0]?.['overview_message_id'])).toMatch(
      /^claim:[^:]+:reserved:\d+:message-1$/,
    );
    expect(String(payloads[1]?.['overview_message_id'])).toMatch(
      /^claim:[^:]+:posting:\d+:message-1$/,
    );
    expect(payloads[2]).toEqual({ overview_message_id: 'message-2' });
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledOnce();
    const [route, request] = mocks.post.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(route).toBe('/channels/channel-1/messages');
    expect(request.body['allowed_mentions']).toEqual({ parse: [] });
  });

  it('restores the old ID after an explicit Discord rejection', async () => {
    mocks.post.mockRejectedValue({ status: 403, message: 'Missing Access' });

    const result = await refreshOverviewNow('guild-1', 'Krew');

    expect(result).toEqual({ posted: false, messageId: null });
    expect(updatePayloads().at(-1)).toEqual({ overview_message_id: 'message-1' });
  });

  it('keeps the claim when Discord times out', async () => {
    mocks.post.mockRejectedValue(new Error('request timed out'));

    const result = await refreshOverviewNow('guild-1', 'Krew');

    expect(result).toEqual({ posted: false, messageId: null });
    expect(updatePayloads().at(-1)?.['overview_message_id']).toMatch(/:posting:/);
    expect(updatePayloads().some((payload) => payload['overview_message_id'] === 'message-1')).toBe(
      false,
    );
  });

  it('does not repost a fresh uncertain claim', async () => {
    mocks.loadGuildSettings.mockResolvedValue({
      overviewChannelId: 'channel-1',
      overviewMessageId: 'claim:claim-1:posting:9999999999999:message-1',
      overviewFields: [],
    });

    const result = await refreshOverviewNow('guild-1', 'Krew');

    expect(result).toEqual({ posted: false, messageId: null });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.dbState.calls).toHaveLength(0);
  });

  it('does not repost a legacy claim', async () => {
    mocks.loadGuildSettings.mockResolvedValue({
      overviewChannelId: 'channel-1',
      overviewMessageId: 'claim:legacy-1',
      overviewFields: [],
    });

    const result = await refreshOverviewNow('guild-1', 'Krew');

    expect(result).toEqual({ posted: false, messageId: null });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.dbState.calls).toHaveLength(0);
  });
});
