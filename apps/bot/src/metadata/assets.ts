import {
  createBrawlApiClient,
  type BrawlApiClient,
} from '@brawlhub/brawlapi';

/**
 * Process-wide BrawlAPI client. It is only ever used for static asset URLs;
 * official API data remains the source of truth for names and stats.
 */
let sharedClient: BrawlApiClient | null = null;

export function getGameAssetsClient(): BrawlApiClient {
  sharedClient ??= createBrawlApiClient();
  return sharedClient;
}

export interface AssetLookupOptions {
  /** Injectable client for tests. */
  readonly client?: BrawlApiClient;
}

function fallbackClubBadgeUrl(badgeId: number): string {
  return `https://cdn.brawlify.com/club-badges/regular/${badgeId}.png`;
}

function fallbackPlayerIconUrl(iconId: number): string {
  return `https://cdn.brawlify.com/profile-icons/regular/${iconId}.png`;
}

/** Resolve a club badge thumbnail, degrading to a stable bundled URL. */
export async function resolveClubBadgeUrl(
  badgeId: number | null,
  options: AssetLookupOptions = {},
): Promise<string | null> {
  if (badgeId === null) return null;
  const fallback = fallbackClubBadgeUrl(badgeId);
  try {
    const assets = await (options.client ?? getGameAssetsClient()).resolveGameAssets({
      clubBadgeId: badgeId,
    });
    return assets.clubBadgeUrl ?? fallback;
  } catch {
    return fallback;
  }
}

/** Resolve a player icon thumbnail, degrading to a stable bundled URL. */
export async function resolvePlayerIconUrl(
  iconId: number | null,
  options: AssetLookupOptions = {},
): Promise<string | null> {
  if (iconId === null) return null;
  const fallback = fallbackPlayerIconUrl(iconId);
  try {
    const assets = await (options.client ?? getGameAssetsClient()).resolveGameAssets({
      playerIconId: iconId,
    });
    return assets.playerIconUrl ?? fallback;
  } catch {
    return fallback;
  }
}

/** Resolve a brawler portrait using BrawlAPI static metadata only. */
export async function resolveBrawlerPortraitUrl(
  brawlerName: string | null,
  options: AssetLookupOptions = {},
): Promise<string | null> {
  if (brawlerName === null || brawlerName.trim() === '') return null;
  try {
    const assets = await (options.client ?? getGameAssetsClient()).resolveGameAssets({
      brawlerName,
    });
    return assets.brawlerImageUrl;
  } catch {
    return null;
  }
}

/** Test helper for resetting the shared client (also clears its cache). */
export function resetGameAssetsClient(): void {
  sharedClient?.clearCache();
  sharedClient = null;
}
