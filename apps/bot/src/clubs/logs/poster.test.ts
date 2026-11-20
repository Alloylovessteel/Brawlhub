import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const GUILD_ID = '123456789012345678';
const LOG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CHANNEL_ID = '111111111111111222';
const TOKEN = 'discord-token-should-never-be-logged';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  getBotConfig: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  service: {
    readClubLogGuildIds: vi.fn(),
    loadUndeliveredClubLogEvents: vi.fn(),
    markClubLogEventsDelivered: vi.fn(),
  },
  buildClubLogEventEmbed: vi.fn(),
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
vi.mock('../../config', () => ({ getBotConfig: mocks.getBotConfig }));
vi.mock('@brawlhub/logging', () => ({ createLogger: () => mocks.logger }));
vi.mock('./service', () => mocks.service);
vi.mock('./embed', () => ({ buildClubLogEventEmbed: mocks.buildClubLogEventEmbed }));

import { runClubLogsPost, startClubLogsSchedule } from './poster';
import type { ClubLogGroup } from './types';

function group(): ClubLogGroup {
  return {
    log: {
      id: LOG_ID,
      guildId: GUILD_ID,
      clubId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      clubTag: 'ALPHA',
      clubName: 'Alpha',
      channelId: CHANNEL_ID,
    },
    events: [
      {
        kind: 'role',
        id: 'r1',
        clubId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        playerTag: 'PLAYER',
        playerName: 'Player',
        description: '#PLAYER role changed Member → Senior',
        detectedAt: '2026-11-20T12:00:00.000Z',
      },
    ],
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
  mocks.service.readClubLogGuildIds.mockReset();
  mocks.service.readClubLogGuildIds.mockResolvedValue([GUILD_ID]);
  mocks.service.loadUndeliveredClubLogEvents.mockReset();
  mocks.service.loadUndeliveredClubLogEvents.mockResolvedValue([group()]);
  mocks.service.markClubLogEventsDelivered.mockReset();
  mocks.service.markClubLogEventsDelivered.mockResolvedValue(undefined);
  mocks.buildClubLogEventEmbed.mockReset();
  mocks.buildClubLogEventEmbed.mockReturnValue({ toJSON: () => ({ title: '#ALPHA club log' }) });
});

afterEach(() => {
  delete process.env.CLUB_LOGS_INTERVAL_MINUTES;
  vi.restoreAllMocks();
});

describe('runClubLogsPost', () => {
  it('does nothing without a Discord token', async () => {
    mocks.getBotConfig.mockReturnValue({ token: undefined });

    await runClubLogsPost();

    expect(mocks.service.readClubLogGuildIds).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('posts one embed per log and records deliveries on success', async () => {
    await runClubLogsPost();

    expect(mocks.post).toHaveBeenCalledWith(`channels/${CHANNEL_ID}/messages`, {
      body: {
        embeds: [{ title: '#ALPHA club log' }],
        allowed_mentions: { parse: [] },
      },
    });
    expect(mocks.service.markClubLogEventsDelivered).toHaveBeenCalledWith(GUILD_ID, [
      { logId: LOG_ID, kind: 'role', eventId: 'r1' },
    ]);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('leaves events undelivered and redacts the token when posting fails', async () => {
    mocks.post.mockRejectedValue(new Error(`REST failed with ${TOKEN}`));

    await runClubLogsPost();

    expect(mocks.service.markClubLogEventsDelivered).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
    const warning = mocks.logger.warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(JSON.stringify(warning)).not.toContain(TOKEN);
    expect(warning['guildId']).toBe(GUILD_ID);
  });
});

describe('startClubLogsSchedule', () => {
  it('polls at the configured interval after an initial delay and can be stopped', () => {
    process.env.CLUB_LOGS_INTERVAL_MINUTES = '2';
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const stop = startClubLogsSchedule();

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 20_000);
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 120_000);
    stop();
    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
  });

  it('clamps invalid intervals to 1..1440 minutes', () => {
    process.env.CLUB_LOGS_INTERVAL_MINUTES = '99999';
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');

    const stop = startClubLogsSchedule();

    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 1440 * 60_000);
    stop();
  });
});
