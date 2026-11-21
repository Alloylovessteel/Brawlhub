import type { BrawlStarsClient } from '@brawlhub/brawl-stars';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearBrawlerCatalogCache, loadBrawlerCatalog } from './catalog.js';

function fakeApi(getBrawlers: () => Promise<Array<{ id: number; name: string }>>): BrawlStarsClient {
  return {
    getClub: vi.fn(),
    getClubMembers: vi.fn(),
    getPlayer: vi.fn(),
    getBattleLog: vi.fn(),
    getBrawlers,
    getEventRotation: vi.fn(),
  } as unknown as BrawlStarsClient;
}

beforeEach(() => {
  clearBrawlerCatalogCache();
});

describe('official brawler catalog loader', () => {
  it('returns only IDs and names, sorted and de-duplicated', async () => {
    const api = fakeApi(async () => [
      { id: 2, name: 'Colt' },
      { id: 1, name: 'Shelly' },
      { id: 3, name: 'shelly' },
    ]);

    const catalog = await loadBrawlerCatalog({ api, useCache: false });

    expect(catalog).toEqual([
      { id: 2, name: 'Colt' },
      { id: 1, name: 'Shelly' },
    ]);
  });

  it('caches successful catalog loads', async () => {
    const getBrawlers = vi.fn(async () => [{ id: 1, name: 'Shelly' }]);
    const api = fakeApi(getBrawlers);

    await loadBrawlerCatalog({ api });
    const cached = await loadBrawlerCatalog({ api });

    expect(getBrawlers).toHaveBeenCalledTimes(1);
    expect(cached).toEqual([{ id: 1, name: 'Shelly' }]);
  });

  it('returns an empty catalog when the official request fails without a cache', async () => {
    const api = fakeApi(async () => {
      throw new Error('offline');
    });

    await expect(loadBrawlerCatalog({ api })).resolves.toEqual([]);
  });

  it('keeps using cached names when a refresh fails', async () => {
    let calls = 0;
    const api = fakeApi(async () => {
      calls += 1;
      if (calls === 1) return [{ id: 1, name: 'Shelly' }];
      throw new Error('offline');
    });

    await loadBrawlerCatalog({ api });
    const stale = await loadBrawlerCatalog({ api, useCache: false });

    expect(stale).toEqual([{ id: 1, name: 'Shelly' }]);
  });
});
