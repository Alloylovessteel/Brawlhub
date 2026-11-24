import { describe, expect, it, vi } from 'vitest';
import { BrawlApiError, createBrawlApiClient, normalizeAssetName } from './client';

const BASE_URL = 'https://brawlapi.example.test';

const iconsBody = {
  player: {
    '28000003': {
      id: 28000003,
      name: 'hero1',
      name2: 'player_icon_shelly',
      imageUrl: 'https://cdn.example.test/player/28000003.png',
      brawler: 16000000,
    },
  },
  club: {
    '8000000': {
      id: 8000000,
      imageUrl: 'https://cdn.example.test/club/8000000.png',
    },
  },
};

const brawlersBody = {
  list: [
    {
      id: 16000000,
      name: 'Shelly',
      imageUrl: 'https://cdn.example.test/brawlers/16000000.png',
    },
  ],
};

const mapsBody = {
  list: [
    {
      id: 15000026,
      name: 'Pinhole Punt',
      imageUrl: 'https://cdn.example.test/maps/15000026.png',
      gameMode: {
        id: 48000005,
        name: 'Brawl Ball',
        imageUrl: 'https://cdn.example.test/modes/48000005.png',
        color: '#9ab1fd',
      },
    },
  ],
};

const gameModesBody = {
  list: [
    {
      id: 48000005,
      name: 'Brawl Ball',
      imageUrl: 'https://cdn.example.test/modes/48000005.png',
      color: '#9ab1fd',
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function hangingBodyResponse(signal: AbortSignal | null | undefined): Response {
  return {
    ok: true,
    status: 200,
    json: () =>
      new Promise<unknown>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('Aborted'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      }),
  } as unknown as Response;
}

function routingFetch(extra: Record<string, unknown> = {}): {
  fetchFn: typeof fetch;
  requested: string[];
} {
  const routes: Record<string, unknown> = {
    '/v1/icons': iconsBody,
    '/v1/brawlers': brawlersBody,
    '/v1/maps': mapsBody,
    '/v1/gamemodes': gameModesBody,
    ...extra,
  };
  const requested: string[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    requested.push(url);
    const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
    const body = routes[path];
    return body === undefined ? jsonResponse({ error: 'not found' }, 404) : jsonResponse(body);
  });
  return { fetchFn, requested };
}

describe('normalizeAssetName', () => {
  it('normalizes official API name styles to comparable labels', () => {
    expect(normalizeAssetName('brawlBall')).toBe('BRAWL BALL');
    expect(normalizeAssetName('SHELLY')).toBe('SHELLY');
    expect(normalizeAssetName('Pinhole_Punt')).toBe('PINHOLE PUNT');
    expect(normalizeAssetName(null)).toBe('');
  });
});

describe('createBrawlApiClient', () => {
  it('fetches static icons without authentication and caches successful responses', async () => {
    const { fetchFn, requested } = routingFetch();
    const client = createBrawlApiClient({ baseUrl: BASE_URL, fetchFn });

    const first = await client.getIconCatalog();
    const second = await client.getIconCatalog();

    expect(first.player['28000003']?.name2).toBe('player_icon_shelly');
    expect(second.player['28000003']?.name2).toBe('player_icon_shelly');
    expect(requested).toEqual([`${BASE_URL}/v1/icons`]);
  });

  it('uses resolved asset URLs and falls back when BrawlAPI is unavailable', async () => {
    const { fetchFn } = routingFetch();
    const online = createBrawlApiClient({ baseUrl: BASE_URL, fetchFn });
    const resolved = await online.resolveGameAssets({
      playerIconId: 28000003,
      clubBadgeId: 8000000,
      brawlerName: 'SHELLY',
      mapName: 'Pinhole Punt',
      gameModeName: 'brawlBall',
    });

    expect(resolved).toEqual({
      playerIconUrl: 'https://cdn.example.test/player/28000003.png',
      clubBadgeUrl: 'https://cdn.example.test/club/8000000.png',
      brawlerImageUrl: 'https://cdn.example.test/brawlers/16000000.png',
      mapImageUrl: 'https://cdn.example.test/maps/15000026.png',
      gameModeImageUrl: 'https://cdn.example.test/modes/48000005.png',
      gameModeColor: '#9ab1fd',
    });

    const offline = createBrawlApiClient({
      baseUrl: BASE_URL,
      fetchFn: vi.fn<typeof fetch>(async () => jsonResponse({}, 500)),
    });
    const fallback = await offline.resolveGameAssets({
      playerIconId: 28000003,
      clubBadgeId: 8000000,
      brawlerName: 'SHELLY',
      mapName: 'Pinhole Punt',
      gameModeName: 'brawlBall',
    });

    expect(fallback.playerIconUrl).toBe('https://cdn.brawlify.com/profile-icons/regular/28000003.png');
    expect(fallback.clubBadgeUrl).toBe('https://cdn.brawlify.com/club-badges/regular/8000000.png');
    expect(fallback.brawlerImageUrl).toBeNull();
    expect(fallback.mapImageUrl).toBeNull();
  });

  it('rejects malformed payloads and exposes cache clearing', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ unexpected: true }));
    const client = createBrawlApiClient({ baseUrl: BASE_URL, fetchFn });

    await expect(client.getBrawlerAssets()).rejects.toBeInstanceOf(BrawlApiError);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    client.clearCache();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('applies the timeout while reading the response body', async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) =>
      hangingBodyResponse(init?.signal),
    );
    const client = createBrawlApiClient({ baseUrl: BASE_URL, fetchFn, timeoutMs: 10 });

    await expect(client.getIconCatalog()).rejects.toThrow(/BrawlAPI request failed/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
