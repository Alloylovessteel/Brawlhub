import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSeasonProgressPoints } from '../images/brawltools-style.js';
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
        now: new Date('2026-11-08T12:00:00.000Z'),
        brawlers: profile().brawlers,
        seasonWindow: { start: '2026-11-05T08:00:00.000Z', end: '2026-12-03T08:00:00.000Z' },
        battles: [
          {
            id: 'b1',
            battleTime: '2026-11-05T09:00:00.000Z',
            mode: 'gemGrab',
            result: 'victory',
          },
        ] as never,
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
      const expectedHeight = mode === 'history' ? 1800 : gridModes.has(mode) ? 1500 : mode === 'season' ? 1120 : 650;

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

  it('renders a zero-filled season graph from stored ranked and trophy battles', async () => {
    const now = new Date('2026-11-08T12:00:00.000Z');
    const options = {
      mode: 'season' as const,
      now,
      seasonWindow: { start: '2026-11-05T08:00:00.000Z', end: '2026-12-03T08:00:00.000Z' },
      battles: [
        {
          id: 'b0',
          battleTime: '2026-11-05T07:59:00.000Z',
          mode: 'gemGrab',
          result: 'victory',
        },
        {
          id: 'b1',
          battleTime: '2026-11-05T09:00:00.000Z',
          mode: 'gemGrab',
          result: 'victory',
        },
        {
          id: 'b2',
          battleTime: '2026-11-05T10:00:00.000Z',
          mode: 'soloShowdown',
          result: 'defeat',
        },
        {
          id: 'b3',
          battleTime: '2026-11-08T09:00:00.000Z',
          mode: 'brawlBall',
          result: 'victory',
        },
      ] as never,
      snapshots: [
        { date: '2026-11-05T08:30:00.000Z', trophies: 4800 },
        { date: '2026-11-08T08:30:00.000Z', trophies: 4860 },
      ],
    };

    const points = buildSeasonProgressPoints(profile(), options);
    expect(points.map((point) => point.key)).toEqual([
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
    expect(points.map((point) => point.matches)).toEqual([2, 0, 0, 1]);
    expect(points.map((point) => point.wins)).toEqual([1, 0, 0, 1]);
    expect(points.map((point) => point.trophies)).toEqual([4800, null, null, 5000]);

    const buffer = await buildPlayerCardImage(profile(), {}, options);
    const metadata = await sharp(buffer).metadata();

    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(1120);
    expect(buffer.byteLength).toBeGreaterThan(1_000);
  });
});
