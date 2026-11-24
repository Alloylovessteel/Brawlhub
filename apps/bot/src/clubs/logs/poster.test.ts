import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const GUILD_ID = '123456789012345678';
const LOG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CHANNEL_ID = '111111111111111222';
const TOKEN = 'discord-token-should-never-be-logged';
const SEASON_START = '2026-11-05T08:00:00.000Z';
const SEASON_END = '2026-12-03T08:00:00.000Z';
const NOV_22 = new Date('2026-11-22T00:00:00.000Z');

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  getBotConfig: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  service: {
    readClubLogGuildIds: vi.fn(),
    loadUndeliveredClubLogEvents: vi.fn(),
    markClubLogEventsDelivered: vi.fn(),
    loadClubLogs: vi.fn(),
    readPostedClubLogDigests: vi.fn(),
    claimClubLogDigestWindows: vi.fn(),
    releaseClubLogDigestClaims: vi.fn(),
    markClubLogDigestClaimDelivered: vi.fn(),
    markClubLogDigestPosted: vi.fn(),
  },
  digest: { dueClubLogDigests: vi.fn() },
  pageView: { loadClubLogView: vi.fn() },
  image: { buildClubLogEventImage: vi.fn(), buildClubLogDigestImage: vi.fn() },
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
vi.mock('./digest', () => mocks.digest);
vi.mock('./page-view', () => mocks.pageView);
vi.mock('./image', () => mocks.image);

import { runClubLogsPost, runClubLogDigests, startClubLogsSchedule } from './poster';
import type { ClubLogPeriod } from '../types';
import type { ClubLogGroup } from './types';
import type { ClubLogView } from '../types';

function group(period: ClubLogPeriod = 'today'): ClubLogGroup {
  return {
    log: {
      id: LOG_ID,
      guildId: GUILD_ID,
      clubId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      clubTag: 'ALPHA',
      clubName: 'Alpha',
      channelId: CHANNEL_ID,
      periods: [period],
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

function log(periods: readonly ClubLogPeriod[] = ['today', 'week', 'season']) {
  return {
    id: LOG_ID,
    guildId: GUILD_ID,
    clubId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    clubTag: 'ALPHA',
    clubName: 'Alpha',
    channelId: CHANNEL_ID,
    periods,
  };
}

function view(period: ClubLogPeriod = 'today'): ClubLogView {
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
    period,
    rows: [],
    unavailable: 0,
    latestSnapshotAt: '2026-11-20T12:00:00.000Z',
    latestSyncAt: '2026-11-20T12:01:00.000Z',
  };
}

function boundaries() {
  return [
    {
      period: 'today' as const,
      periodKey: '2026-11-21',
      windowStart: new Date('2026-11-21T00:00:00.000Z'),
      windowEnd: new Date('2026-11-21T23:59:59.999Z'),
      label: 'Nov 21',
    },
  ];
}

beforeEach(() => {
  mocks.post.mockReset();
  mocks.post.mockResolvedValue({ id: 'message-1' });
  mocks.getBotConfig.mockReset();
  mocks.getBotConfig.mockReturnValue({
    token: TOKEN,
    seasonStartIso: SEASON_START,
    seasonEndIso: SEASON_END,
  });
  mocks.logger.info.mockReset();
  mocks.logger.warn.mockReset();
  mocks.logger.error.mockReset();
  mocks.service.readClubLogGuildIds.mockReset();
  mocks.service.readClubLogGuildIds.mockResolvedValue([GUILD_ID]);
  mocks.service.loadUndeliveredClubLogEvents.mockReset();
  mocks.service.loadUndeliveredClubLogEvents.mockResolvedValue([group()]);
  mocks.service.markClubLogEventsDelivered.mockReset();
  mocks.service.markClubLogEventsDelivered.mockResolvedValue(undefined);
  mocks.service.loadClubLogs.mockReset();
  mocks.service.loadClubLogs.mockResolvedValue([log()]);
  mocks.service.readPostedClubLogDigests.mockReset();
  mocks.service.readPostedClubLogDigests.mockResolvedValue(new Set<string>());
  mocks.service.claimClubLogDigestWindows.mockReset();
  mocks.service.claimClubLogDigestWindows.mockResolvedValue({
    claimId: 'claim-1',
    keys: new Set([`${LOG_ID}:today:2026-11-21`]),
  });
  mocks.service.releaseClubLogDigestClaims.mockReset();
  mocks.service.releaseClubLogDigestClaims.mockResolvedValue(undefined);
  mocks.service.markClubLogDigestClaimDelivered.mockReset();
  mocks.service.markClubLogDigestClaimDelivered.mockResolvedValue(undefined);
  mocks.service.markClubLogDigestPosted.mockReset();
  mocks.service.markClubLogDigestPosted.mockResolvedValue(undefined);
  mocks.digest.dueClubLogDigests.mockReset();
  mocks.digest.dueClubLogDigests.mockReturnValue(boundaries());
  mocks.pageView.loadClubLogView.mockReset();
  mocks.pageView.loadClubLogView.mockResolvedValue({ kind: 'ok', value: view() });
  mocks.image.buildClubLogEventImage.mockReset();
  mocks.image.buildClubLogEventImage.mockResolvedValue(Buffer.from('fake-event-png'));
  mocks.image.buildClubLogDigestImage.mockReset();
  mocks.image.buildClubLogDigestImage.mockResolvedValue(Buffer.from('fake-digest-png'));
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

  it('posts one Members & Roles PNG and records the legacy today delivery', async () => {
    await runClubLogsPost();

    expect(mocks.pageView.loadClubLogView).not.toHaveBeenCalled();
    expect(mocks.image.buildClubLogEventImage).toHaveBeenCalledWith(
      { name: 'Alpha', tag: 'ALPHA' },
      group().events,
    );
    expect(mocks.post).toHaveBeenCalledOnce();
    const [route, request] = mocks.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(route).toBe(`channels/${CHANNEL_ID}/messages`);
    const body = request['body'] as Record<string, unknown>;
    expect(body['content']).toBe('Alpha • Club Log / Members & Roles');
    expect(body['allowed_mentions']).toEqual({ parse: [] });
    const attachments = body['attachments'] as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    const filename = attachments[0]?.['filename'] as string;
    expect(filename).toMatch(/^club-log-alpha-changes-\d+\.png$/);
    const files = request['files'] as Array<Record<string, unknown>>;
    expect(files).toEqual([
      {
        key: 'files[0]',
        name: filename,
        data: Buffer.from('fake-event-png'),
        contentType: 'image/png',
      },
    ]);
    expect(mocks.service.markClubLogEventsDelivered).toHaveBeenCalledWith(GUILD_ID, [
      { logId: LOG_ID, period: 'today', kind: 'role', eventId: 'r1' },
    ]);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('posts each club once even when it subscribes to multiple trophy periods', async () => {
    mocks.service.loadUndeliveredClubLogEvents.mockResolvedValue([
      group('today'),
      group('week'),
      group('season'),
    ]);

    await runClubLogsPost();

    expect(mocks.post).toHaveBeenCalledTimes(3);
    expect(mocks.service.markClubLogEventsDelivered).toHaveBeenCalledTimes(3);
    for (const call of mocks.service.markClubLogEventsDelivered.mock.calls) {
      expect(call[1]).toEqual([{ logId: LOG_ID, period: 'today', kind: 'role', eventId: 'r1' }]);
    }
  });

  it('marks only the clubs that posted successfully', async () => {
    mocks.service.loadUndeliveredClubLogEvents.mockResolvedValue([group(), group()]);
    mocks.post
      .mockResolvedValueOnce({ id: 'message-1' })
      .mockRejectedValueOnce(new Error('rate limited'));

    await runClubLogsPost();

    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.service.markClubLogEventsDelivered).toHaveBeenCalledOnce();
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
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
    mocks.image.buildClubLogEventImage.mockRejectedValue(new Error('render failed'));

    await runClubLogsPost();

    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.service.markClubLogEventsDelivered).not.toHaveBeenCalled();
  });
});

describe('runClubLogDigests', () => {
  it('does nothing without a Discord token', async () => {
    mocks.getBotConfig.mockReturnValue({ token: undefined });

    await runClubLogDigests(NOV_22);

    expect(mocks.digest.dueClubLogDigests).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('posts a trophy-only digest for each due subscribed window and records it once', async () => {
    await runClubLogDigests(NOV_22);

    expect(mocks.digest.dueClubLogDigests).toHaveBeenCalledWith(NOV_22, {
      seasonStartIso: SEASON_START,
      seasonEndIso: SEASON_END,
    });
    expect(mocks.service.claimClubLogDigestWindows).toHaveBeenCalledWith(
      GUILD_ID,
      [
        {
          logId: LOG_ID,
          period: 'today',
          periodKey: '2026-11-21',
          channelId: CHANNEL_ID,
        },
      ],
      { now: NOV_22 },
    );
    expect(mocks.pageView.loadClubLogView).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      tag: 'ALPHA',
      period: 'today',
      now: new Date('2026-11-21T23:59:59.999Z'),
      asOf: new Date('2026-11-21T23:59:59.999Z'),
    });
    expect(mocks.image.buildClubLogDigestImage).toHaveBeenCalledWith(view(), 'Daily');
    expect(mocks.post).toHaveBeenCalledOnce();
    const [route, request] = mocks.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(route).toBe(`channels/${CHANNEL_ID}/messages`);
    const body = request['body'] as Record<string, unknown>;
    expect(body['content']).toBe('Alpha • Club Log / Trophy Progression / Daily — Nov 21 (UTC)');
    expect(body['allowed_mentions']).toEqual({ parse: [] });
    expect(mocks.service.markClubLogDigestPosted).toHaveBeenCalledWith(GUILD_ID, [
      {
        logId: LOG_ID,
        period: 'today',
        periodKey: '2026-11-21',
        channelId: CHANNEL_ID,
        messageId: 'message-1',
      },
    ]);
  });

  it('skips already-posted windows and periods the log does not subscribe to', async () => {
    mocks.service.readPostedClubLogDigests.mockResolvedValue(
      new Set([`${LOG_ID}:today:2026-11-21`]),
    );
    mocks.service.loadClubLogs.mockResolvedValue([log(['week'])]);
    mocks.digest.dueClubLogDigests.mockReturnValue(boundaries());

    await runClubLogDigests(NOV_22);

    expect(mocks.service.claimClubLogDigestWindows).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.service.markClubLogDigestPosted).not.toHaveBeenCalled();
  });

  it('passes the completed season baseline and label to the season renderer', async () => {
    const seasonBoundary = {
      period: 'season' as const,
      periodKey: '2026-12-03',
      windowStart: new Date(SEASON_START),
      windowEnd: new Date('2026-12-03T07:59:59.999Z'),
      label: 'Nov 5 – Dec 2, 2026',
    };
    mocks.digest.dueClubLogDigests.mockReturnValue([seasonBoundary]);
    mocks.service.claimClubLogDigestWindows.mockResolvedValue({
      claimId: 'claim-season',
      keys: new Set([`${LOG_ID}:season:2026-12-03`]),
    });

    await runClubLogDigests(new Date('2026-12-04T00:00:00.000Z'));

    expect(mocks.pageView.loadClubLogView).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      tag: 'ALPHA',
      period: 'season',
      now: seasonBoundary.windowEnd,
      asOf: seasonBoundary.windowEnd,
      seasonStartIso: SEASON_START,
    });
    expect(mocks.image.buildClubLogDigestImage).toHaveBeenCalledWith(view(), 'Season');
    expect(mocks.service.markClubLogDigestPosted).toHaveBeenCalledWith(GUILD_ID, [
      {
        logId: LOG_ID,
        period: 'season',
        periodKey: '2026-12-03',
        channelId: CHANNEL_ID,
        messageId: 'message-1',
      },
    ]);
  });

  it('releases the claim when a post fails so the window stays retryable', async () => {
    mocks.post.mockRejectedValue(new Error('rate limited'));

    await runClubLogDigests(NOV_22);

    expect(mocks.service.releaseClubLogDigestClaims).toHaveBeenCalledWith(GUILD_ID, 'claim-1', [
      `${LOG_ID}:today:2026-11-21`,
    ]);
    expect(mocks.service.markClubLogDigestPosted).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
  });

  it('does not post or render a window it did not win', async () => {
    mocks.service.claimClubLogDigestWindows.mockResolvedValue({
      claimId: 'claim-lost',
      keys: new Set<string>(),
    });

    await runClubLogDigests(NOV_22);

    expect(mocks.pageView.loadClubLogView).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.service.markClubLogDigestPosted).not.toHaveBeenCalled();
    expect(mocks.service.releaseClubLogDigestClaims).not.toHaveBeenCalled();
  });

  it('persists the known message ID when the Discord post succeeded but the ledger write failed', async () => {
    mocks.service.markClubLogDigestPosted.mockRejectedValue(new Error('ledger down'));

    await runClubLogDigests(NOV_22);

    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.service.releaseClubLogDigestClaims).not.toHaveBeenCalled();
    expect(mocks.service.markClubLogDigestClaimDelivered).toHaveBeenCalledWith(GUILD_ID, 'claim-1', [
      {
        logId: LOG_ID,
        period: 'today',
        periodKey: '2026-11-21',
        channelId: CHANNEL_ID,
        messageId: 'message-1',
      },
    ]);
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
    const warning = mocks.logger.warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(warning['keys']).toEqual([`${LOG_ID}:today:2026-11-21`]);
  });

  it('still keeps the claim when persisting the recovered message ID fails', async () => {
    mocks.service.markClubLogDigestPosted.mockRejectedValue(new Error('ledger down'));
    mocks.service.markClubLogDigestClaimDelivered.mockRejectedValue(new Error('sentinel down'));

    await runClubLogDigests(NOV_22);

    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.service.releaseClubLogDigestClaims).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no window is due', async () => {
    mocks.digest.dueClubLogDigests.mockReturnValue([]);

    await runClubLogDigests(NOV_22);

    expect(mocks.service.readClubLogGuildIds).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe('startClubLogsSchedule', () => {
  it('polls events and digests independently and can be stopped', () => {
    process.env.CLUB_LOGS_INTERVAL_MINUTES = '2';
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const stop = startClubLogsSchedule();

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 20_000);
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 120_000);
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    stop();
    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
  });

  it('clamps invalid event intervals to 1..1440 minutes', () => {
    process.env.CLUB_LOGS_INTERVAL_MINUTES = '99999';
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');

    const stop = startClubLogsSchedule();

    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 1440 * 60_000);
    stop();
  });
});
