import { describe, expect, it, vi } from 'vitest';
import { BrawlStarsApiError, createBrawlStarsClient } from './client';

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

  it('retries a 429 response once and returns the successful response', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ reason: 'slow down' }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(playerBody));
    const sleepFn = vi.fn(async () => {});

    const client = createBrawlStarsClient({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchFn,
      sleepFn,
    });
    const player = await client.getPlayer('#g2p9');

    expect(player.trophies).toBe(500);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
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
});
