import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getIconCatalog: vi.fn(),
  getBrawlers: vi.fn(),
}));

vi.mock('@brawlhub/brawlapi', () => ({
  createBrawlApiClient: () => ({ getIconCatalog: mocks.getIconCatalog }),
}));

vi.mock('@brawlhub/brawl-stars', () => ({
  getSharedBrawlStarsClient: () => ({ getBrawlers: mocks.getBrawlers }),
}));

import { clearVerificationIconCache, pickRandomVerificationIconAsync } from './icons';

const BRAWLERS = Array.from({ length: 110 }, (_, index) => ({
  id: 16_000_000 + index,
  name: `Brawler ${index}`,
  imageUrl: `https://assets.example/brawlers/${index}.png`,
}));

const PLAYER_ICONS = Object.fromEntries(
  BRAWLERS.map((brawler, index) => [
    28_000_000 + index,
    {
      id: 28_000_000 + index,
      name: `hero${index}`,
      name2: `player_icon_${index}`,
      imageUrl: `https://assets.example/icons/${index}.png`,
      brawler: brawler.id,
    },
  ]),
);

beforeEach(() => {
  vi.clearAllMocks();
  clearVerificationIconCache();
  mocks.getBrawlers.mockResolvedValue(BRAWLERS);
  mocks.getIconCatalog.mockResolvedValue({ player: PLAYER_ICONS });
});

describe('pickRandomVerificationIconAsync', () => {
  it('only returns an icon for an owned brawler id', async () => {
    const icon = await pickRandomVerificationIconAsync(undefined, {
      ids: new Set([BRAWLERS[5]!.id]),
    });

    expect(icon?.id).toBe(28_000_005);
  });

  it('matches owned brawler names against the bundled icon pool', async () => {
    mocks.getIconCatalog.mockRejectedValue(new Error('offline'));

    const icon = await pickRandomVerificationIconAsync(undefined, {
      names: new Set(['Spike']),
    });

    expect(icon?.name).toBe('Spike');
  });

  it('keeps a single owned icon even when it is the current icon', async () => {
    const icon = await pickRandomVerificationIconAsync(28_000_005, {
      ids: new Set([BRAWLERS[5]!.id]),
    });

    expect(icon?.id).toBe(28_000_005);
  });

  it('returns null instead of falling back to an unowned brawler', async () => {
    const icon = await pickRandomVerificationIconAsync(undefined, {
      ids: new Set([99_999_999]),
    });

    expect(icon).toBeNull();
  });
});
