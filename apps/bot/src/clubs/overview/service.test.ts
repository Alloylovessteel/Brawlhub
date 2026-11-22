import type { REST } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
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

describe('postOverviewForGuild', () => {
  it('edits the existing message with every registered club in one page', async () => {
    mocks.loadClubSummaries.mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => summary(index)),
    );
    mocks.getBotConfig.mockReturnValue({
      emojis: {},
      playerProfileUrlTemplate: undefined,
      clubProfileUrlTemplate: undefined,
      token: 'token',
    });

    const patch = vi.fn(
      async (
        _url: string,
        _options: { body: { embeds: Array<{ fields?: unknown[] }> } },
      ) => ({ id: 'message-1' }),
    );
    const post = vi.fn(async () => ({ id: 'message-2' }));
    const rest = { patch, post } as unknown as REST;

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
    expect(messageId).toBe('message-1');
    expect(post).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledTimes(1);

    const call = patch.mock.calls[0];
    if (call === undefined) throw new Error('PATCH was not called');
    expect(call[0]).toContain('/channels/channel-1/messages/message-1');
    const body = call[1].body;
    expect(body.embeds).toHaveLength(2);
    expect(
      body.embeds.reduce((total, embed) => total + (embed.fields?.length ?? 0), 0),
    ).toBe(30);
  });
});
