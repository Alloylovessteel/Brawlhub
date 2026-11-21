import {
  createBrawlStarsClient,
  type BrawlerCatalogItem,
  type BrawlStarsClient,
} from '@brawlhub/brawl-stars';
import type { OfficialBrawlerRef } from './types';

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

interface CachedCatalog {
  readonly expiresAt: number;
  readonly items: readonly OfficialBrawlerRef[];
}

let cachedCatalog: CachedCatalog | null = null;

export interface BrawlerCatalogOptions {
  readonly api?: BrawlStarsClient;
  readonly now?: Date;
  /** Disable caching in tests or one-off scripts. */
  readonly useCache?: boolean;
}

function toRefs(items: readonly BrawlerCatalogItem[]): readonly OfficialBrawlerRef[] {
  const unique = new Map<string, OfficialBrawlerRef>();
  for (const item of items) {
    if (item.name.trim() === '') continue;
    const key = item.name.trim().toLowerCase();
    const ref: OfficialBrawlerRef = { id: item.id, name: item.name.trim() };
    if (!unique.has(key)) unique.set(key, ref);
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load the official static brawler catalog. The official endpoint has no image,
 * class, rarity or description fields, so only IDs and names are exposed here.
 */
export async function loadBrawlerCatalog(
  options: BrawlerCatalogOptions = {},
): Promise<readonly OfficialBrawlerRef[]> {
  const now = options.now ?? new Date();
  const useCache = options.useCache ?? true;
  if (useCache && cachedCatalog !== null && cachedCatalog.expiresAt > now.getTime()) {
    return cachedCatalog.items;
  }

  try {
    const api = options.api ?? createBrawlStarsClient();
    const items = await api.getBrawlers();
    const refs = toRefs(items);
    if (useCache) cachedCatalog = { items: refs, expiresAt: now.getTime() + CATALOG_TTL_MS };
    return refs;
  } catch {
    // A stale catalog is still valid name metadata; no stats are inferred from it.
    return cachedCatalog?.items ?? [];
  }
}

/** Test helper for clearing the process-wide catalog cache. */
export function clearBrawlerCatalogCache(): void {
  cachedCatalog = null;
}
