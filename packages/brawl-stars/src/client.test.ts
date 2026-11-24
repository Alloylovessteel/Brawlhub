import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrawlStarsApiError,
  createBrawlStarsClient,
  getSharedBrawlStarsClient,
  readBrawlStarsTimeoutMs,
  resetSharedBrawlStarsClientForTests,
} from './client';

const API_KEY = 'super-secret-bs-key-987654321';
const BASE_URL = 'https://api.example.test/v1';

const clubBody = {
  tag: '#G2P9',
  name: 'Example Club',
  trophies: 12345,
  requiredTrophies: 10000,
  members: [],
};
const memberBody = { tag: '#2C0Y', name: 'Example Player', trophies: 500, role: 'member' };
const playerBody = { tag: '#G2P9', name: 'Example Player', trophies: 500, highscore: 900 };

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('createBrawlStarsClient', () => {
  it('sends the API key as a Bearer header and normalizes the tag', async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      seen.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return jsonResponse(clubBody);
    });

    const client = createBrawlStarsClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetchFn });
    const club = await client.getClub('#g2p9');

    expect(club.tag).toBe('#G2P9');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorization).toBe(`Bearer ${API_KEY}`);
    expect(seen[0]?.url).toBe(`${BASE_URL}/clubs/%23G2P9`);
  });

  it('spaces consecutive requests by the configured minimum interval', async () => {
    const delays: number[] = [];
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(clubBody));
    const client = createBrawlStarsClient({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchFn,
      minIntervalMs: 250,
      throttleSleepFn: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await client.getClub('#G2P9');
    await client.getClub('#G2P9');

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(delays).toHaveLength(1);
    expect(delays[0] ?? 0).toBeGreaterThan(0);
    expect(delays[0] ?? 0).toBeLessThanOrEqual(250);
  });

  it('retries a 429 response once and spaces the retry with a throttle slot', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ reason: 'slow down' }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(playerBody));
    const sleepFn = vi.fn(async () => {});
    const throttleDelays: number[] = [];

    const client = createBrawlStarsClient({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchFn,
      sleepFn,
      minIntervalMs: 250,
      throttleSleepFn: async (delayMs) => {
        throttleDelays.push(delayMs);
      },
    });
    const player = await client.getPlayer('#g2p9');

    expect(player.trophies).toBe(500);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(throttleDelays).toHaveLength(1);
    expect(throttleDelays[0] ?? 0).toBeGreaterThan(0);
  });

  it('throws a sanitized error whose message never contains the API key', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ reason: `rejected ${API_KEY}` }, 403),
    );
    const client = createBrawlStarsClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetchFn });

    expect.assertions(3);
    try {
      await client.getClub('#G2P9');
    } catch (error) {
      expect(error).toBeInstanceOf(BrawlStarsApiError);
      expect((error as BrawlStarsApiError).status).toBe(403);
      expect((error as BrawlStarsApiError).message).not.toContain(API_KEY);
    }
  });

  it('only requests official club/player endpoints, never token or authorize', async () => {
    const requested: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      requested.push(String(input));
      return jsonResponse({ items: [memberBody] });
    });

    const client = createBrawlStarsClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetchFn });
    const members = await client.getClubMembers('#g2p9');

    expect(members).toHaveLength(1);
    expect(requested).toEqual([`${BASE_URL}/clubs/%23G2P9/members`]);
    expect(requested.some((url) => /token|authorize|oauth/i.test(url))).toBe(false);
  });

  it('stops after three attempts on persistent 5xx responses', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    const sleepFn = vi.fn(async () => {});

    const client = createBrawlStarsClient({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchFn,
      sleepFn,
      minIntervalMs: 0,
    });

    await expect(client.getPlayer('#G2P9')).rejects.toBeInstanceOf(BrawlStarsApiError);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it('reads the official brawler catalog', async () => {
    const requested: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      requested.push(String(input));
      return jsonResponse({
        items: [
          {
            id: 16000000,
            name: 'SHELLY',
            gadgets: [{ id: 23000001, name: 'CLAY PIGEON' }],
          },
        ],
      });
    });

    const client = createBrawlStarsClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetchFn });
    const brawlers = await client.getBrawlers();

    expect(brawlers).toHaveLength(1);
    expect(brawlers[0]?.name).toBe('SHELLY');
    expect(requested).toEqual([`${BASE_URL}/brawlers`]);
  });

  it('accepts official battle log null maps and unavailable durations', async () => {
    const requested: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      requested.push(String(input));
      return jsonResponse({
        items: [
          {
            battleTime: '20261120T100000.000Z',
            event: { id: 15000026, mode: 'soloShowdown', modeId: 4, map: null },
            battle: {
              mode: 'showdown',
              type: 'solo',
              result: 'victory',
              duration: -1,
              trophyChange: 8,
              players: [
                {
                  tag: '#G2P9',
                  name: 'Example Player',
                  brawler: { id: 16000000, name: 'SHELLY', power: 11, trophies: 900 },
                  stats: { kills: 3, deaths: 1, damageDealt: 12345 },
                },
              ],
            },
          },
        ],
        paging: { cursors: {} },
      });
    });

    const client = createBrawlStarsClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetchFn });
    const items = await client.getBattleLog('#g2p9');

    expect(items).toHaveLength(1);
    expect(items[0]?.event?.map).toBeNull();
    expect(items[0]?.battle?.duration).toBe(-1);
    expect(requested).toEqual([`${BASE_URL}/players/%23G2P9/battlelog`]);
  });

  it('treats a 404 battle log as empty history without retrying', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ reason: 'notFound' }, 404));
    const client = createBrawlStarsClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetchFn });

    await expect(client.getBattleLog('#g2p9')).resolves.toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('reads the official live event rotation', async () => {
    const requested: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      requested.push(String(input));
      return jsonResponse([
        {
          startTime: '20261119T080000.000Z',
          endTime: '20261120T080000.000Z',
          slotId: 1,
          event: { id: 15000026, mode: 'brawlBall', modeId: 5, map: 'Pinhole Punt' },
        },
      ]);
    });

    const client = createBrawlStarsClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetchFn });
    const rotation = await client.getEventRotation();

    expect(rotation).toHaveLength(1);
    expect(rotation[0]?.event?.map).toBe('Pinhole Punt');
    expect(requested).toEqual([`${BASE_URL}/events/rotation`]);
  });

  it('aborts a stalled request with a safe status-0 timeout error', async () => {
    const signals: AbortSignal[] = [];
    const fetchFn = vi.fn<typeof fetch>((_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error('fetch was not given an abort signal');
      }
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error(`aborted ${API_KEY}`)));
      });
    });
    const client = createBrawlStarsClient({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchFn,
      timeoutMs: 10,
      minIntervalMs: 0,
    });

    await expect(client.getClub('#G2P9')).rejects.toMatchObject({
      name: 'BrawlStarsApiError',
      status: 0,
    });
    await expect(client.getClub('#G2P9')).rejects.toThrow(/timed out/i);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(true);
  });

  it('never includes the API key in a timeout message', async () => {
    const fetchFn = vi.fn<typeof fetch>((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error(`request failed with ${API_KEY}`)),
        );
      }),
    );
    const client = createBrawlStarsClient({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchFn,
      timeoutMs: 5,
      minIntervalMs: 0,
    });

    try {
      await client.getClub('#G2P9');
      throw new Error('expected a timeout');
    } catch (error) {
      expect(error).toBeInstanceOf(BrawlStarsApiError);
      expect((error as BrawlStarsApiError).message).not.toContain(API_KEY);
    }
  });
});

describe('timeout configuration', () => {
  const original = process.env.BRAWL_STARS_TIMEOUT_MS;

  afterEach(() => {
    if (original === undefined) delete process.env.BRAWL_STARS_TIMEOUT_MS;
    else process.env.BRAWL_STARS_TIMEOUT_MS = original;
  });

  it('defaults to 30s, parses the environment and clamps invalid values', () => {
    delete process.env.BRAWL_STARS_TIMEOUT_MS;
    expect(readBrawlStarsTimeoutMs()).toBe(30_000);

    process.env.BRAWL_STARS_TIMEOUT_MS = ' 2500 ';
    expect(readBrawlStarsTimeoutMs()).toBe(2_500);

    process.env.BRAWL_STARS_TIMEOUT_MS = 'not-a-number';
    expect(readBrawlStarsTimeoutMs()).toBe(30_000);

    process.env.BRAWL_STARS_TIMEOUT_MS = '-10';
    expect(readBrawlStarsTimeoutMs()).toBe(30_000);

    expect(readBrawlStarsTimeoutMs(999_999_999)).toBe(300_000);
    expect(readBrawlStarsTimeoutMs(0)).toBe(30_000);
  });
});

describe('getSharedBrawlStarsClient', () => {
  afterEach(() => {
    resetSharedBrawlStarsClientForTests();
  });

  it('returns a module-level singleton until reset', () => {
    resetSharedBrawlStarsClientForTests();
    const first = getSharedBrawlStarsClient({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchFn: vi.fn<typeof fetch>(),
    });
    expect(getSharedBrawlStarsClient()).toBe(first);
    expect(getSharedBrawlStarsClient({ apiKey: 'ignored' })).toBe(first);

    resetSharedBrawlStarsClientForTests();
    expect(getSharedBrawlStarsClient()).not.toBe(first);
  });
});
