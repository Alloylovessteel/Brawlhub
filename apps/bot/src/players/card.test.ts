import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPlayerCardImage, PLAYER_CARD_MODES, selectTopBrawlers } from './card';
import type { PlayerProfileView } from './types';

vi.setConfig({ testTimeout: 20_000 });

function profile(overrides: Record<string, unknown> = {}): PlayerProfileView {
  return {
    player: {
      id: 'p1',
      tag: '2C0Y',
      name: 'Alpha',
      trophies: 5000,
      highestTrophies: 5200,
      expLevel: 35,
      iconId: 28000003,
      threeVsThreeVictories: 20,
      soloVictories: 5,
      duoVictories: 3,
    },
    currentClub: { tag: '8QCL', name: 'Alpha Club', role: 'president', id: 'club-a' },
    brawlers: [
      { name: 'Shelly', trophies: 900 },
      { name: 'Nita', trophies: 800 },
      { name: 'Colt', trophies: 700 },
      { name: 'Jessie', trophies: 600 },
    ],
    stats: { brawlerCount: 42 },
    source: 'live',
    apiIssue: null,
    profileFetchedAt: '2026-11-21T08:00:00.000Z',
    latestSnapshotAt: '2026-11-20T08:00:00.000Z',
    ...overrides,
  } as unknown as PlayerProfileView;
}

describe('selectTopBrawlers', () => {
  it('returns the three highest-trophy brawlers', () => {
    expect(selectTopBrawlers(profile()).map((brawler) => brawler.name)).toEqual([
      'Shelly',
      'Nita',
      'Colt',
    ]);
  });
});

describe('buildPlayerCardImage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a 1200x650 profile PNG', async () => {
    const buffer = await buildPlayerCardImage(profile());
    const metadata = await sharp(buffer).metadata();

    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(650);
    expect(buffer.byteLength).toBeGreaterThan(1_000);
  });

  it('renders safely when official names contain XML-sensitive characters', async () => {
    const buffer = await buildPlayerCardImage(
      profile({ player: { ...profile().player, name: '<Alpha & "Beta">' } }),
    );

    expect(buffer.byteLength).toBeGreaterThan(1_000);
  });

  it('ignores static assets that are not images', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('not an image', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const buffer = await buildPlayerCardImage(profile(), {
      playerIconUrl: 'https://cdn.example.test/icon.png',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(buffer.byteLength).toBeGreaterThan(1_000);
  });

  it('normalizes valid player and club assets into the rendered card', async () => {
    const png = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 80, g: 80, b: 200, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const fetchMock = vi.fn(
      async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const buffer = await buildPlayerCardImage(profile(), {
      playerIconUrl: 'https://cdn.example.test/icon.png',
      clubBadgeUrl: 'https://cdn.example.test/badge.png',
    });
    const metadata = await sharp(buffer).metadata();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(650);
    expect(buffer.byteLength).toBeGreaterThan(1_000);
  });

  it('renders every BrawlTools-style preset at its expected size', async () => {
    const gridModes = new Set(['brawler', 'rank', 'trophies', 'highest']);
    for (const mode of PLAYER_CARD_MODES) {
      const buffer = await buildPlayerCardImage(profile(), {}, {
        mode,
        seasonWindow: { start: '2026-11-05T08:00:00.000Z', end: '2026-12-03T08:00:00.000Z' },
        history: {
          points: 2,
          firstAt: '2026-11-01T00:00:00.000Z',
          latestAt: '2026-11-20T00:00:00.000Z',
          firstTrophies: 4800,
          latestTrophies: 5000,
          clubChanges: 1,
          nameChanges: null,
          events: [{ type: 'join', label: 'Joined Alpha Club', date: '2026-11-02T00:00:00.000Z' }],
          megaPig: { date: '2026-11-01T00:00:00.000Z', wins: 5, draws: 1, losses: 2, ticketsUsed: 4 },
        },
        snapshots: [
          { date: '2026-11-01T00:00:00.000Z', trophies: 4800 },
          { date: '2026-11-20T00:00:00.000Z', trophies: 5000 },
        ],
        modeStats: [{ label: 'Gem Grab', wins: 3, matches: 5, winRate: 60 }],
      });
      const metadata = await sharp(buffer).metadata();
      const expectedHeight = mode === 'history' ? 1800 : gridModes.has(mode) ? 1500 : mode === 'season' ? 720 : 650;

      expect(metadata.format, mode).toBe('png');
      expect(metadata.width, mode).toBe(1200);
      expect(metadata.height, mode).toBe(expectedHeight);
      expect(buffer.byteLength, mode).toBeGreaterThan(1_000);
    }
  });

  it('renders grid presets safely with missing optional brawler fields', async () => {
    const buffer = await buildPlayerCardImage(profile(), {}, { mode: 'rank' });
    expect(buffer.byteLength).toBeGreaterThan(1_000);
  });

  it('renders the history preset without stored data', async () => {
    const buffer = await buildPlayerCardImage(profile(), {}, { mode: 'history', history: null });
    expect(buffer.byteLength).toBeGreaterThan(1_000);
  });

  it('composites stored charts into the season preset', async () => {
    const chart = await sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 30, g: 20, b: 70, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const buffer = await buildPlayerCardImage(profile(), {}, {
      mode: 'season',
      charts: { trophyChartPng: chart, activityChartPng: chart },
    });
    const metadata = await sharp(buffer).metadata();

    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(720);
    expect(buffer.byteLength).toBeGreaterThan(1_000);
  });
});
