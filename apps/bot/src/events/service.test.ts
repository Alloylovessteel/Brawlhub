import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrawlApiClient } from '@brawlhub/brawlapi';
import type { BrawlStarsClient, EventRotationSlot } from '@brawlhub/brawl-stars';
import { clearEventRotationCache, formatModeLabel, loadEventView, parseOfficialEventTime } from './service';

function slot(
  slotId: number,
  startTime: string,
  endTime: string,
  mode = 'brawlBall',
  map = 'Pinhole Punt',
): EventRotationSlot {
  return {
    startTime,
    endTime,
    slotId,
    event: { id: 15000026, mode, modeId: 5, map },
  };
}

function officialClient(slots: readonly EventRotationSlot[]): BrawlStarsClient {
  return {
    getClub: vi.fn(async () => ({}) as never),
    getClubMembers: vi.fn(async () => []),
    getPlayer: vi.fn(async () => ({}) as never),
    getBattleLog: vi.fn(async () => []),
    getBrawlers: vi.fn(async () => []),
    getEventRotation: vi.fn(async () => [...slots]),
  };
}

function metadataClient(): BrawlApiClient {
  return {
    getIconCatalog: vi.fn(async () => ({ player: {}, club: {} })) as never,
    getBrawlerAssets: vi.fn(async () => []),
    getGameModeAssets: vi.fn(async () => []),
    getMapAssets: vi.fn(async () => []),
    playerIconUrl: vi.fn(() => null),
    clubBadgeUrl: vi.fn(() => null),
    resolveGameAssets: vi.fn(async () => ({
      playerIconUrl: null,
      clubBadgeUrl: null,
      brawlerImageUrl: null,
      mapImageUrl: 'https://cdn.example.test/maps/15000026.png',
      gameModeImageUrl: 'https://cdn.example.test/modes/48000005.png',
      gameModeColor: '#9ab1fd',
    })),
    clearCache: vi.fn(),
  };
}

beforeEach(() => {
  clearEventRotationCache();
});

describe('event formatting helpers', () => {
  it('formats official mode names for display', () => {
    expect(formatModeLabel('brawlBall')).toBe('Brawl Ball');
    expect(formatModeLabel('gemGrab')).toBe('Gem Grab');
    expect(formatModeLabel('SHOWDOWN')).toBe('Showdown');
  });

  it('normalises official rotation timestamps into ISO strings', () => {
    expect(parseOfficialEventTime('20261119T080000.000Z')).toBe('2026-11-19T08:00:00.000Z');
    expect(parseOfficialEventTime('not-a-time')).toBeNull();
  });
});

describe('loadEventView', () => {
  const now = () => new Date('2026-11-19T12:00:00.000Z');

  it('classifies active slots from the official rotation and attaches static assets', async () => {
    const brawlApi = metadataClient();
    const client = officialClient([
      slot(1, '20261119T080000.000Z', '20261119T200000.000Z'),
      slot(2, '20261119T200000.000Z', '20261120T080000.000Z', 'gemGrab', 'Layer Cake'),
    ]);

    const view = await loadEventView('active', { client, brawlApi, now });

    expect(view.kind).toBe('active');
    expect(view.apiIssue).toBeNull();
    expect(view.slots).toHaveLength(1);
    expect(view.slots[0]).toMatchObject({
      slotId: 1,
      modeLabel: 'Brawl Ball',
      mapName: 'Pinhole Punt',
      startAt: '2026-11-19T08:00:00.000Z',
      mapImageUrl: 'https://cdn.example.test/maps/15000026.png',
      modeColor: '#9ab1fd',
    });
    expect(brawlApi.resolveGameAssets).toHaveBeenCalledWith({
      mapName: 'Pinhole Punt',
      gameModeName: 'brawlBall',
    });
  });

  it('returns upcoming slots sorted by start time', async () => {
    const client = officialClient([
      slot(3, '20261120T080000.000Z', '20261120T200000.000Z', 'hotZone', 'Double Sided'),
      slot(2, '20261119T200000.000Z', '20261120T080000.000Z', 'gemGrab', 'Layer Cake'),
    ]);

    const view = await loadEventView('upcoming', {
      client,
      brawlApi: metadataClient(),
      now,
    });

    expect(view.slots.map((entry) => entry.slotId)).toEqual([2, 3]);
  });

  it('reports an API issue without inventing events when the official API fails', async () => {
    const failing = officialClient([]);
    vi.mocked(failing.getEventRotation).mockRejectedValue(new Error('official API down'));

    const view = await loadEventView('active', {
      client: failing,
      brawlApi: metadataClient(),
      now,
    });

    expect(view.apiIssue).toBe('unavailable');
    expect(view.slots).toEqual([]);
  });

  it('keeps official data when static metadata is unavailable', async () => {
    const brawlApi = metadataClient();
    vi.mocked(brawlApi.resolveGameAssets).mockRejectedValue(new Error('brawlapi down'));

    const view = await loadEventView('active', {
      client: officialClient([slot(1, '20261119T080000.000Z', '20261119T200000.000Z')]),
      brawlApi,
      now,
    });

    expect(view.slots).toHaveLength(1);
    expect(view.slots[0]?.mapName).toBe('Pinhole Punt');
    expect(view.slots[0]?.mapImageUrl).toBeNull();
  });
});
