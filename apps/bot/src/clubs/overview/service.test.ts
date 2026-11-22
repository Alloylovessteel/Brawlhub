import type { REST } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClubSummary } from '../types';

const mocks = vi.hoisted(() => ({
  loadClubSummaries: vi.fn(),
  getBotConfig: vi.fn(),
}));

vi.mock('../../config', () => ({ getBotConfig: mocks.getBotConfig }));
vi.mock('../service', () => ({ loadClubSummaries: mocks.loadClubSummaries }));
vi.mock('../../admin/service', () => ({
  loadGuildSettings: vi.fn(),
  setGuildOverviewMessageId: vi.fn(),
}));

import { postOverviewForGuild } from './service';

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

describe('postOverviewForGuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
