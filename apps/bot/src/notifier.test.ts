import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncNotificationInput } from '@brawlhub/sync';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  maybeSingle: vi.fn(),
  getBotConfig: vi.fn(),
}));

vi.mock('@brawlhub/database', () => ({
  createTrustedClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }) }),
  }),
}));
vi.mock('./config.js', () => ({ getBotConfig: mocks.getBotConfig }));
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
    },
    Routes: { channelMessages: (channelId: string) => `channels/${channelId}/messages` },
  };
});

import { buildClubMembershipNoticeContent, createDiscordNotifier } from './notifier';

function input(overrides: Partial<SyncNotificationInput> = {}): SyncNotificationInput {
  return {
    eventId: 'event-1',
    eventType: 'leave',
    playerTag: '2QGGRYQQRR',
    playerName: 'gynophobe',
    clubName: 'Kuromi Nek',
    fromClubName: 'Kuromi Nek',
    toClubName: undefined,
    occurredAt: '2026-11-23T23:18:00.000Z',
    remainingMembers: 29,
    ...overrides,
  };
}

describe('buildClubMembershipNoticeContent', () => {
  it('states the player name and club name as plain text', () => {
    expect(buildClubMembershipNoticeContent(input())).toBe('gynophobe left Kuromi Nek');
  });

  it('formats joins and transfers the same way', () => {
    const join = buildClubMembershipNoticeContent(
      input({ eventType: 'join', fromClubName: undefined }),
    );
    expect(join).toBe('gynophobe joined Kuromi Nek');

    const transfer = buildClubMembershipNoticeContent(
      input({
        eventType: 'transfer',
        fromClubName: 'Kuromi Nek',
        toClubName: 'Kuromi Krew',
      }),
    );
    expect(transfer).toBe('gynophobe transferred from Kuromi Nek to Kuromi Krew');
  });

  it('strips mention syntax from names', () => {
    const content = buildClubMembershipNoticeContent(
      input({ eventType: 'join', playerName: '<@everyone> gynophobe', clubName: '<#123> Kuromi Nek' }),
    );

    expect(content).toBe('gynophobe joined Kuromi Nek');
    expect(content).not.toContain('<@');
    expect(content).not.toContain('<#');
  });

  it('falls back to the player tag and a generic club name when data is missing', () => {
    const content = buildClubMembershipNoticeContent(
      input({ eventType: 'join', playerName: '', playerTag: 'YQPQ0Q2CL', clubName: '' }),
    );

    expect(content).toBe('#YQPQ0Q2CL joined the club');
  });
});

describe('createDiscordNotifier', () => {
  beforeEach(() => {
    mocks.post.mockReset();
    mocks.maybeSingle.mockReset();
    mocks.getBotConfig.mockReset();
    mocks.getBotConfig.mockReturnValue({ token: 'discord-token' });
    delete process.env.DISCORD_NOTIFICATION_CHANNEL_ID;
  });

  it('posts mention-safe content and returns the Discord message ID', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { announcement_channel_id: 'channel-1' }, error: null });
    mocks.post.mockResolvedValue({ id: 'message-1' });

    const notifier = await createDiscordNotifier({ guildId: 'guild-1' });
    const messageId = await notifier.send(input());

    expect(notifier.channelId).toBe('channel-1');
    expect(messageId).toBe('message-1');
    const [route, request] = mocks.post.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(route).toBe('channels/channel-1/messages');
    expect(request.body).toMatchObject({
      content: 'gynophobe left Kuromi Nek',
      allowed_mentions: { parse: [] },
    });
  });

  it('returns undefined on a send failure so sync can retry the claim', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { announcement_channel_id: 'channel-1' }, error: null });
    mocks.post.mockRejectedValue(new Error('rate limited'));

    const notifier = await createDiscordNotifier({ guildId: 'guild-1' });

    await expect(notifier.send(input())).resolves.toBeUndefined();
  });

  it('disables notifications when no channel is configured', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });

    const notifier = await createDiscordNotifier({ guildId: 'guild-1' });

    expect(notifier.channelId).toBeUndefined();
    await expect(notifier.send(input())).resolves.toBeUndefined();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
