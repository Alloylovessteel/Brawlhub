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
  pageView: {
    CLUB_LOG_PERIOD_LABELS: { today: 'Today', week: 'This Week', season: 'This Season' },
    isClubLogPeriod: vi.fn((value: string) => ['today', 'week', 'season'].includes(value)),
    loadClubLogView: vi.fn(),
  },
  image: { buildClubLogPageImage: vi.fn() },
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
vi.mock('./page-view', () => mocks.pageView);
vi.mock('./image', () => mocks.image);

import { runClubLogsPost, startClubLogsSchedule } from './poster';
import type { ClubLogGroup } from './types';
import type { ClubLogView } from '../types';

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

function view(): ClubLogView {
  return {
    club: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      tag: 'ALPHA',
      name: 'Alpha',
      description: null,
      trophies: null,
      requiredTrophies: null,
      memberCount: null,
      lastSyncedAt: null,
    },
    period: 'today',
    rows: [],
    unavailable: 0,
    latestSnapshotAt: '2026-11-20T12:00:00.000Z',
    latestSyncAt: '2026-11-20T12:01:00.000Z',
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
  mocks.pageView.loadClubLogView.mockReset();
  mocks.pageView.loadClubLogView.mockResolvedValue({ kind: 'ok', value: view() });
  mocks.image.buildClubLogPageImage.mockReset();
  mocks.image.buildClubLogPageImage.mockResolvedValue(Buffer.from('fake-png'));
});

afterEach(() => {
  delete process.env.CLUB_LOGS_INTERVAL_MINUTES;
  delete process.env.CLUB_LOGS_PERIOD;
  vi.restoreAllMocks();
});

describe('runClubLogsPost', () => {
  it('does nothing without a Discord token', async () => {
    mocks.getBotConfig.mockReturnValue({ token: undefined });

    await runClubLogsPost();

    expect(mocks.service.readClubLogGuildIds).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('posts one public PNG per log and records deliveries only after success', async () => {
    await runClubLogsPost();

    expect(mocks.pageView.loadClubLogView).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      tag: 'ALPHA',
      period: 'today',
    });
    expect(mocks.image.buildClubLogPageImage).toHaveBeenCalledWith(view(), group().events);
    expect(mocks.post).toHaveBeenCalledOnce();
    const [route, request] = mocks.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(route).toBe(`channels/${CHANNEL_ID}/messages`);
    const body = request['body'] as Record<string, unknown>;
    expect(body['content']).toBe('Alpha • Club Logs / Trophy Progression / Today');
    expect(body['allowed_mentions']).toEqual({ parse: [] });
    const attachments = body['attachments'] as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.['id']).toBe('0');
    const filename = attachments[0]?.['filename'] as string;
    expect(filename).toMatch(/^club-log-alpha-\d+\.png$/);
    const files = request['files'] as Array<Record<string, unknown>>;
    expect(files).toEqual([
      {
        key: 'files[0]',
        name: filename,
        data: Buffer.from('fake-png'),
        contentType: 'image/png',
      },
    ]);
    expect(mocks.service.markClubLogEventsDelivered).toHaveBeenCalledWith(GUILD_ID, [
      { logId: LOG_ID, kind: 'role', eventId: 'r1' },
    ]);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('honours a valid configured period', async () => {
    process.env.CLUB_LOGS_PERIOD = 'week';

    await runClubLogsPost();

    expect(mocks.pageView.loadClubLogView).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      tag: 'ALPHA',
      period: 'week',
    });
    const request = mocks.post.mock.calls[0]?.[1] as Record<string, unknown>;
    const body = request['body'] as Record<string, unknown>;
    expect(body['content']).toContain('This Week');
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

  it('leaves events undelivered when rendering fails', async () => {
    mocks.image.buildClubLogPageImage.mockRejectedValue(new Error('render failed'));

    await runClubLogsPost();

    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.service.markClubLogEventsDelivered).not.toHaveBeenCalled();
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
