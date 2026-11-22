import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPlayerCardImage, selectTopBrawlers } from './card';
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

  it('renders a 1200x720 PNG', async () => {
    const buffer = await buildPlayerCardImage(profile());
    const metadata = await sharp(buffer).metadata();

    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(720);
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

  it('normalizes valid static assets into the rendered card', async () => {
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
      brawlerPortraitUrls: [
        'https://cdn.example.test/shelly.png',
        'https://cdn.example.test/nita.png',
        'https://cdn.example.test/colt.png',
      ],
    });
    const metadata = await sharp(buffer).metadata();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(720);
    expect(buffer.byteLength).toBeGreaterThan(1_000);
  });
});
