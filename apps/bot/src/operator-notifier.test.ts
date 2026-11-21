import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuildSettingsView } from './admin/types';
import type { SyncResult } from '@brawlhub/sync';

const GUILD_ID = '123456789012345678';
const ANNOUNCEMENT_ID = '111111111111111111';
const VERIFICATION_ID = '222222222222222222';
const TOKEN = 'discord-token-should-never-be-logged';
const REDACTED_LABEL = '[REDACTED]';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  getBotConfig: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
    },
    Routes: { channelMessages: (channelId: string) => `channels/${channelId}/messages` },
  };
});
vi.mock('./config.js', () => ({ getBotConfig: mocks.getBotConfig }));
vi.mock('@brawlhub/logging', () => ({ createLogger: () => mocks.logger }));

import {
  buildSyncOperatorEmbed,
  buildVerificationOperatorEmbed,
  notifySyncResult,
  notifyVerificationCompleted,
} from './operator-notifier';

function settings(overrides: Partial<GuildSettingsView> = {}): GuildSettingsView {
  return {
    guildId: GUILD_ID,
    announcementChannelId: ANNOUNCEMENT_ID,
    verifiedRoleId: null,
    overviewChannelId: null,
    overviewMessageId: null,
    overviewFields: [],
    reportDailyChannelId: null,
    reportWeeklyChannelId: null,
    reportMonthlyChannelId: null,
    rankedRoleIds: {},
    verificationChannelId: VERIFICATION_ID,
    verificationMessageId: null,
    updatedAt: null,
    ...overrides,
  };
}

function result(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    syncRunId: 'run-1',
    status: 'completed',
    clubsProcessed: 3,
    playersUpserted: 601,
    snapshotsWritten: 604,
    membershipEvents: 2,
    notificationsSent: 0,
    error: undefined,
    affectedClubIds: [],
    guildId: GUILD_ID,
    membersExpected: 603,
    membersSucceeded: 601,
    memberFailures: [{ tag: 'BAD1', name: 'Broken', reason: 'API unavailable' }],
    ...overrides,
  };
}

beforeEach(() => {
  mocks.post.mockReset();
  mocks.post.mockResolvedValue({ id: 'message-1' });
  mocks.getBotConfig.mockReset();
  mocks.getBotConfig.mockReturnValue({ token: TOKEN });
  mocks.logger.info.mockReset();
  mocks.logger.warn.mockReset();
  mocks.logger.error.mockReset();
});

describe('operator embeds', () => {
  it('reports partial member synchronization with the exact member count', () => {
    const json = buildSyncOperatorEmbed(result()).toJSON();

    expect(json.title).toBe('Member synchronization failed');
    expect(json.description).toContain('Successfully synced Members: 601/603');
    expect(json.fields?.map((field) => field.name)).toContain('Failed members');
  });

  it('reports a clean sync without failure fields', () => {
    const json = buildSyncOperatorEmbed(
      result({ memberFailures: [], membersSucceeded: 603 }),
    ).toJSON();

    expect(json.title).toBe('Sync completed');
    expect(json.description).toContain('Successfully synced Members: 603/603');
    expect(json.fields?.map((field) => field.name)).not.toContain('Failed members');
  });

  it('redacts and truncates sync errors', () => {
    const json = buildSyncOperatorEmbed(
      result({ status: 'failed', error: `<@everyone> ${TOKEN} broke\nnext line` }),
    ).toJSON();

    expect(json.title).toBe('Synchronization failed');
    expect(json.description).not.toContain('<@');
    expect(json.description).not.toContain(TOKEN);
    expect(json.description).toContain(REDACTED_LABEL);
    expect(json.description).not.toContain('\n');
  });

  it('sanitizes mentions in verification notices', () => {
    const json = buildVerificationOperatorEmbed({
      guildId: GUILD_ID,
      playerName: '<@everyone> Kuromi',
      playerTag: '2ABC',
      discordUserId: '333333333333333333',
      method: 'icon-verified',
    }).toJSON();

    expect(json.title).toBe('Verification completed');
    expect(json.description).not.toContain('<@');
    expect(json.description).toContain('Kuromi');
    expect(json.fields?.map((field) => field.value)).toContain('Icon-verified');
  });
});

describe('operator posting', () => {
  it('posts sync notices to the guild announcement channel with mentions disabled', async () => {
    const loadSettings = vi.fn(async () => settings());
    const messageId = await notifySyncResult(result(), { loadSettings });

    expect(messageId).toBe('message-1');
    expect(loadSettings).toHaveBeenCalledWith(GUILD_ID);
    const [route, request] = mocks.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(route).toBe(`channels/${ANNOUNCEMENT_ID}/messages`);
    const body = request['body'] as Record<string, unknown>;
    expect(body['allowed_mentions']).toEqual({ parse: [] });
    expect(body['components']).toBeUndefined();
  });

  it('falls back to the verification channel and posts verification notices there', async () => {
    const loadSettings = vi.fn(async () => settings({ announcementChannelId: null }));

    await notifyVerificationCompleted(
      {
        guildId: GUILD_ID,
        playerName: 'Alpha',
        playerTag: '2ABC',
        discordUserId: '333333333333333333',
        method: 'staff-linked',
      },
      { loadSettings },
    );

    expect(mocks.post.mock.calls[0]?.[0]).toBe(`channels/${VERIFICATION_ID}/messages`);
  });

  it('ignores skipped, guild-less and invalid-guild results', async () => {
    const loadSettings = vi.fn(async () => settings());

    const { guildId: _guildId, ...guildless } = result();
    await notifySyncResult(result({ status: 'skipped' }), { loadSettings });
    await notifySyncResult(guildless, { loadSettings });
    await notifySyncResult(result({ guildId: 'not-a-snowflake' }), { loadSettings });

    expect(mocks.post).not.toHaveBeenCalled();
    expect(loadSettings).not.toHaveBeenCalled();
  });

  it('does not post when the guild has no configured channel', async () => {
    const loadSettings = vi.fn(async () =>
      settings({ announcementChannelId: null, verificationChannelId: null }),
    );

    await notifySyncResult(result(), { loadSettings });

    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('redacts the token when posting fails', async () => {
    mocks.post.mockRejectedValue(new Error(`failed with ${TOKEN}`));

    await notifySyncResult(result(), { loadSettings: async () => settings() });

    expect(mocks.logger.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.logger.warn.mock.calls[0]?.[1])).not.toContain(TOKEN);
  });
});
