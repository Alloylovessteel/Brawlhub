import { z, type ZodType } from 'zod';
import {
  brawlApiBrawlersResponseSchema,
  brawlApiGameModesResponseSchema,
  brawlApiIconsResponseSchema,
  brawlApiMapsResponseSchema,
  type BrawlApiBrawlerAsset,
  type BrawlApiClubBadge,
  type BrawlApiGameModeAsset,
  type BrawlApiIconsResponse,
  type BrawlApiMapAsset,
  type BrawlApiPlayerIcon,
  type GameAssetMetadata,
} from './types';

export class BrawlApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrawlApiError';
  }
}

export interface BrawlApiClientOptions {
  /** Defaults to BRAWLAPI_BASE_URL, then https://api.brawlapi.com. */
  readonly baseUrl?: string;
  /** Injectable fetch implementation (useful for tests). */
  readonly fetchFn?: typeof fetch;
  /** Per-request timeout. Defaults to BRAWLAPI_TIMEOUT_MS, then 5000ms. */
  readonly timeoutMs?: number;
  /** Successful-response cache TTL. Defaults to BRAWLAPI_CACHE_TTL_MS, then 1 hour. */
  readonly cacheTtlMs?: number;
  /** Injectable clock for deterministic cache tests. */
  readonly nowFn?: () => number;
}

export interface GameAssetInput {
  readonly playerIconId?: number | null;
  readonly clubBadgeId?: number | null;
  readonly brawlerName?: string | null;
  readonly mapName?: string | null;
  readonly gameModeName?: string | null;
}

export interface BrawlApiClient {
  getIconCatalog(): Promise<BrawlApiIconsResponse>;
  getBrawlerAssets(): Promise<readonly BrawlApiBrawlerAsset[]>;
  getGameModeAssets(): Promise<readonly BrawlApiGameModeAsset[]>;
  getMapAssets(): Promise<readonly BrawlApiMapAsset[]>;
  playerIconUrl(iconId: number | null | undefined): string | null;
  clubBadgeUrl(badgeId: number | null | undefined): string | null;
  resolveGameAssets(input: GameAssetInput): Promise<GameAssetMetadata>;
  clearCache(): void;
}

const DEFAULT_BASE_URL = 'https://api.brawlapi.com';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1_000;

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

function readPositiveInt(value: number | undefined, envName: string, fallback: number): number {
  const raw = value ?? Number(readEnv(envName));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.trunc(raw);
}

/** Match official API names (often SCREAMING_SNAKE or camelCase) to BrawlAPI names. */
export function normalizeAssetName(value: string | null | undefined): string {
  if (value === undefined || value === null) return '';
  return value
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function fallbackPlayerIconUrl(iconId: number): string {
  return `https://cdn.brawlify.com/profile-icons/regular/${iconId}.png`;
}

function fallbackClubBadgeUrl(badgeId: number): string {
  return `https://cdn.brawlify.com/club-badges/regular/${badgeId}.png`;
}

interface CacheEntry {
  readonly value: unknown;
  readonly expiresAt: number;
}

export function createBrawlApiClient(options: BrawlApiClientOptions = {}): BrawlApiClient {
  const baseUrl = (options.baseUrl ?? readEnv('BRAWLAPI_BASE_URL') ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );
  const fetchFn: typeof fetch = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = readPositiveInt(options.timeoutMs, 'BRAWLAPI_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const cacheTtlMs = readPositiveInt(
    options.cacheTtlMs,
    'BRAWLAPI_CACHE_TTL_MS',
    DEFAULT_CACHE_TTL_MS,
  );
  const nowFn = options.nowFn ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  async function cached<S extends ZodType>(key: string, path: string, schema: S): Promise<z.infer<S>> {
    const now = nowFn();
    const hit = cache.get(key);
    if (hit !== undefined && hit.expiresAt > now) {
      return schema.parse(hit.value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchFn(`${baseUrl}${path}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
      } catch (error) {
        throw new BrawlApiError(
          `BrawlAPI request failed: ${error instanceof Error ? error.message : 'network error'}`,
        );
      }

      if (!response.ok) {
        throw new BrawlApiError(`BrawlAPI request failed with status ${response.status}`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted) {
          throw new BrawlApiError(
            `BrawlAPI request failed: ${error instanceof Error ? error.message : 'network error'}`,
          );
        }
        throw new BrawlApiError('BrawlAPI returned invalid JSON');
      }

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new BrawlApiError('BrawlAPI returned an unexpected response shape');
      }

      cache.set(key, { value: parsed.data, expiresAt: nowFn() + cacheTtlMs });
      return parsed.data;
    } finally {
      // The timeout must also cover body reads; a stalled `response.json()`
      // would otherwise keep the request alive after the timer was cleared.
      clearTimeout(timer);
    }
  }

  function cachedValue<T>(key: string): T | undefined {
    const hit = cache.get(key);
    if (hit === undefined || hit.expiresAt <= nowFn()) return undefined;
    return hit.value as T;
  }

  async function playerIcon(iconId: number | null | undefined): Promise<BrawlApiPlayerIcon | null> {
    if (iconId === null || iconId === undefined) return null;
    const catalog = cachedValue<BrawlApiIconsResponse>('icons') ?? (await getIconCatalog());
    return catalog.player[String(iconId)] ?? null;
  }

  async function clubBadge(badgeId: number | null | undefined): Promise<BrawlApiClubBadge | null> {
    if (badgeId === null || badgeId === undefined) return null;
    const catalog = cachedValue<BrawlApiIconsResponse>('icons') ?? (await getIconCatalog());
    return catalog.club[String(badgeId)] ?? null;
  }

  function getIconCatalog(): Promise<BrawlApiIconsResponse> {
    return cached('icons', '/v1/icons', brawlApiIconsResponseSchema);
  }

  function getBrawlerAssets(): Promise<readonly BrawlApiBrawlerAsset[]> {
    return cached('brawlers', '/v1/brawlers', brawlApiBrawlersResponseSchema).then(
      (response) => response.list,
    );
  }

  function getGameModeAssets(): Promise<readonly BrawlApiGameModeAsset[]> {
    return cached('gamemodes', '/v1/gamemodes', brawlApiGameModesResponseSchema).then(
      (response) => response.list,
    );
  }

  function getMapAssets(): Promise<readonly BrawlApiMapAsset[]> {
    return cached('maps', '/v1/maps', brawlApiMapsResponseSchema).then((response) => response.list);
  }

  return {
    getIconCatalog,
    getBrawlerAssets,
    getGameModeAssets,
    getMapAssets,
    playerIconUrl(iconId) {
      if (iconId === null || iconId === undefined) return null;
      const cachedIcon = cachedValue<BrawlApiIconsResponse>('icons')?.player[String(iconId)];
      return cachedIcon?.imageUrl ?? fallbackPlayerIconUrl(iconId);
    },
    clubBadgeUrl(badgeId) {
      if (badgeId === null || badgeId === undefined) return null;
      const cachedBadge = cachedValue<BrawlApiIconsResponse>('icons')?.club[String(badgeId)];
      return cachedBadge?.imageUrl ?? fallbackClubBadgeUrl(badgeId);
    },
    async resolveGameAssets(input) {
      const result: GameAssetMetadata = {
        playerIconUrl: null,
        clubBadgeUrl: null,
        brawlerImageUrl: null,
        mapImageUrl: null,
        gameModeImageUrl: null,
        gameModeColor: null,
      };

      if (input.playerIconId !== null && input.playerIconId !== undefined) {
        try {
          result.playerIconUrl = (await playerIcon(input.playerIconId))?.imageUrl ?? null;
        } catch {
          result.playerIconUrl = fallbackPlayerIconUrl(input.playerIconId);
        }
      }
      if (input.clubBadgeId !== null && input.clubBadgeId !== undefined) {
        try {
          result.clubBadgeUrl = (await clubBadge(input.clubBadgeId))?.imageUrl ?? null;
        } catch {
          result.clubBadgeUrl = fallbackClubBadgeUrl(input.clubBadgeId);
        }
      }

      const brawlerName = normalizeAssetName(input.brawlerName);
      if (brawlerName !== '') {
        try {
          const assets = await getBrawlerAssets();
          result.brawlerImageUrl =
            assets.find((asset) => normalizeAssetName(asset.name) === brawlerName)?.imageUrl ?? null;
        } catch {
          result.brawlerImageUrl = null;
        }
      }

      const gameModeName = normalizeAssetName(input.gameModeName);
      if (gameModeName !== '') {
        try {
          const assets = await getGameModeAssets();
          const match = assets.find((asset) => normalizeAssetName(asset.name) === gameModeName);
          result.gameModeImageUrl = match?.imageUrl ?? null;
          result.gameModeColor = match?.color ?? null;
        } catch {
          result.gameModeImageUrl = null;
          result.gameModeColor = null;
        }
      }

      const mapName = normalizeAssetName(input.mapName);
      if (mapName !== '') {
        try {
          const assets = await getMapAssets();
          const match = assets.find((asset) => normalizeAssetName(asset.name) === mapName);
          result.mapImageUrl = match?.imageUrl ?? null;
          if (result.gameModeImageUrl === null && match?.gameMode !== undefined) {
            result.gameModeImageUrl = match.gameMode.imageUrl ?? null;
          }
          if (result.gameModeColor === null && match?.gameMode !== undefined) {
            result.gameModeColor = match.gameMode.color ?? null;
          }
        } catch {
          result.mapImageUrl = null;
        }
      }

      return result;
    },
    clearCache() {
      cache.clear();
    },
  };
}
