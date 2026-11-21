import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrawlApiClient } from '@brawlhub/brawlapi';
import {
  resetGameAssetsClient,
  resolveBrawlerPortraitUrl,
  resolveClubBadgeUrl,
  resolvePlayerIconUrl,
} from './assets';

function clientReturning(resolver: BrawlApiClient['resolveGameAssets']): BrawlApiClient {
  return {
    getIconCatalog: vi.fn(async () => ({ player: {}, club: {} })) as never,
    getBrawlerAssets: vi.fn(async () => []),
    getGameModeAssets: vi.fn(async () => []),
    getMapAssets: vi.fn(async () => []),
    playerIconUrl: vi.fn(() => null),
    clubBadgeUrl: vi.fn(() => null),
    resolveGameAssets: resolver,
    clearCache: vi.fn(),
  };
}

beforeEach(() => {
  resetGameAssetsClient();
});

describe('static asset enrichment', () => {
  it('resolves a club badge from BrawlAPI', async () => {
    const client = clientReturning(vi.fn(async () => ({
      playerIconUrl: null,
      clubBadgeUrl: 'https://cdn.example.test/club/1.png',
      brawlerImageUrl: null,
      mapImageUrl: null,
      gameModeImageUrl: null,
      gameModeColor: null,
    })));

    expect(await resolveClubBadgeUrl(8000001, { client })).toBe(
      'https://cdn.example.test/club/1.png',
    );
    expect(client.resolveGameAssets).toHaveBeenCalledWith({ clubBadgeId: 8000001 });
  });

  it('resolves a player icon from BrawlAPI', async () => {
    const client = clientReturning(vi.fn(async () => ({
      playerIconUrl: 'https://cdn.example.test/player/1.png',
      clubBadgeUrl: null,
      brawlerImageUrl: null,
      mapImageUrl: null,
      gameModeImageUrl: null,
      gameModeColor: null,
    })));

    expect(await resolvePlayerIconUrl(28000003, { client })).toBe(
      'https://cdn.example.test/player/1.png',
    );
    expect(client.resolveGameAssets).toHaveBeenCalledWith({ playerIconId: 28000003 });
  });

  it('resolves a brawler portrait using only static BrawlAPI metadata', async () => {
    const client = clientReturning(vi.fn(async () => ({
      playerIconUrl: null,
      clubBadgeUrl: null,
      brawlerImageUrl: 'https://cdn.example.test/brawlers/16000000.png',
      mapImageUrl: null,
      gameModeImageUrl: null,
      gameModeColor: null,
    })));

    expect(await resolveBrawlerPortraitUrl('Shelly', { client })).toBe(
      'https://cdn.example.test/brawlers/16000000.png',
    );
    expect(client.resolveGameAssets).toHaveBeenCalledWith({ brawlerName: 'Shelly' });
  });

  it('returns null when a brawler portrait is unavailable', async () => {
    const client = clientReturning(vi.fn(async () => {
      throw new Error('brawlapi down');
    }));

    expect(await resolveBrawlerPortraitUrl('Shelly', { client })).toBeNull();
    expect(await resolveBrawlerPortraitUrl(' ', { client })).toBeNull();
    expect(client.resolveGameAssets).toHaveBeenCalledTimes(1);
  });

  it('falls back to bundled URLs when BrawlAPI fails', async () => {
    const client = clientReturning(vi.fn(async () => {
      throw new Error('brawlapi down');
    }));

    expect(await resolveClubBadgeUrl(8000001, { client })).toBe(
      'https://cdn.brawlify.com/club-badges/regular/8000001.png',
    );
    expect(await resolvePlayerIconUrl(28000003, { client })).toBe(
      'https://cdn.brawlify.com/profile-icons/regular/28000003.png',
    );
  });

  it('returns null when no icon id is available', async () => {
    const client = clientReturning(vi.fn(async () => {
      throw new Error('should not be called');
    }));

    expect(await resolveClubBadgeUrl(null, { client })).toBeNull();
    expect(await resolvePlayerIconUrl(null, { client })).toBeNull();
    expect(client.resolveGameAssets).not.toHaveBeenCalled();
  });
});
