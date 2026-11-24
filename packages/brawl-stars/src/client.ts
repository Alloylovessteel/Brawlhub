import { z, type ZodType } from 'zod';
import {
  battleLogResponseSchema,
  brawlerCatalogResponseSchema,
  clubMembersResponseSchema,
  clubSchema,
  eventRotationResponseSchema,
  playerSchema,
  type BattleLogItem,
  type BrawlerCatalogItem,
  type Club,
  type ClubMember,
  type EventRotationSlot,
  type Player,
} from './types';

export class BrawlStarsApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'BrawlStarsApiError';
    this.status = status;
  }
}

export interface BrawlStarsClientOptions {
  /** Developer API key sent as `Authorization: Bearer <key>`. Defaults to BRAWL_STARS_API_KEY. */
  apiKey?: string;
  /** Defaults to BRAWL_STARS_BASE_URL, then https://api.brawlstars.com/v1. */
  baseUrl?: string;
  /**
   * Per-request timeout in milliseconds. Defaults to BRAWL_STARS_TIMEOUT_MS,
   * then 30000. Invalid values fall back to the default; valid values are
   * clamped to 1..300000.
   */
  timeoutMs?: number;
  /** Injectable fetch implementation (useful for tests). */
  fetchFn?: typeof fetch;
  /** Injectable wait between retries; tests can pass a no-op. */
  sleepFn?: (delayMs: number) => Promise<void>;
  /**
   * Minimum spacing between the start of consecutive API requests. Defaults to
   * BRAWL_STARS_MIN_INTERVAL_MS (150ms). Set to 0 to disable spacing.
   */
  minIntervalMs?: number;
  /** Injectable wait used only for request spacing (useful in tests). */
  throttleSleepFn?: (delayMs: number) => Promise<void>;
}

export interface BrawlStarsClient {
  getClub(tag: string): Promise<Club>;
  getClubMembers(tag: string): Promise<ClubMember[]>;
  getPlayer(tag: string): Promise<Player>;
  getBattleLog(tag: string): Promise<BattleLogItem[]>;
  getBrawlers(): Promise<BrawlerCatalogItem[]>;
  getEventRotation(): Promise<EventRotationSlot[]>;
}

const MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 200;
const DEFAULT_MIN_INTERVAL_MS = 150;
const MAX_MIN_INTERVAL_MS = 60_000;
export const DEFAULT_BRAWL_STARS_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_BASE_URL = 'https://api.brawlstars.com/v1';
const TAG_PATTERN = /^[0289CGJLPQRUVY]{3,10}$/;

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** Local tag normalization keeps this package standalone (no @brawlhub/shared dependency). */
function normalizeTag(tag: string): string {
  const normalized = tag.trim().replace(/^#+/, '').toUpperCase();
  if (!TAG_PATTERN.test(normalized)) {
    throw new BrawlStarsApiError('Invalid Brawl Stars tag', 0);
  }
  return `#${normalized}`;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function readMinInterval(value: number | undefined): number {
  const raw = value ?? readEnv('BRAWL_STARS_MIN_INTERVAL_MS');
  if (raw === undefined) {
    return DEFAULT_MIN_INTERVAL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MIN_INTERVAL_MS;
  }
  return Math.min(MAX_MIN_INTERVAL_MS, Math.trunc(parsed));
}

/** Safely resolves the per-request timeout from an option or the environment. */
export function readBrawlStarsTimeoutMs(value?: number | string): number {
  const raw = value ?? readEnv('BRAWL_STARS_TIMEOUT_MS');
  if (raw === undefined) {
    return DEFAULT_BRAWL_STARS_TIMEOUT_MS;
  }
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_BRAWL_STARS_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(parsed)));
}

export function createBrawlStarsClient(options?: BrawlStarsClientOptions): BrawlStarsClient {
  const apiKey = options?.apiKey ?? readEnv('BRAWL_STARS_API_KEY');
  const baseUrl = (
    options?.baseUrl ?? readEnv('BRAWL_STARS_BASE_URL') ?? DEFAULT_BASE_URL
  ).replace(/\/+$/, '');
  const fetchFn: typeof fetch = options?.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  const sleepFn = options?.sleepFn ?? defaultSleep;
  const minIntervalMs = readMinInterval(options?.minIntervalMs);
  const timeoutMs = readBrawlStarsTimeoutMs(options?.timeoutMs);
  const throttleSleepFn = options?.throttleSleepFn ?? defaultSleep;
  let lastRequestStartedAt = 0;
  let throttleQueue: Promise<void> = Promise.resolve();

  /** Serialize requests and keep at least minIntervalMs between their starts. */
  function acquireSlot(): Promise<void> {
    const slot = throttleQueue.then(async () => {
      const delay = Math.max(0, lastRequestStartedAt + minIntervalMs - Date.now());
      if (delay > 0) {
        await throttleSleepFn(delay);
      }
      lastRequestStartedAt = Date.now();
    });
    throttleQueue = slot.catch(() => {});
    return slot;
  }

  async function request<S extends ZodType>(path: string, schema: S): Promise<z.infer<S>> {
    if (apiKey === undefined) {
      throw new BrawlStarsApiError(
        'BRAWL_STARS_API_KEY is required to call the Brawl Stars API',
        0,
      );
    }

    const url = `${baseUrl}${path}`;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      // Every attempt is an API request, including retries, so each one needs
      // its own throttle slot. Otherwise a retry bypasses the minimum spacing.
      await acquireSlot();
      const controller = new AbortController();
      let timedOut = false;
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      let response: Response;
      try {
        response = await fetchFn(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });
        if (timedOut) {
          throw new BrawlStarsApiError('Brawl Stars API request timed out', 0);
        }

        if (response.ok) {
          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            throw new BrawlStarsApiError('Brawl Stars API returned invalid JSON', response.status);
          }

          const parsed = schema.safeParse(payload);
          if (!parsed.success) {
            throw new BrawlStarsApiError(
              'Brawl Stars API returned an unexpected response shape',
              response.status,
            );
          }
          return parsed.data;
        }
      } catch (error) {
        if (timedOut || controller.signal.aborted) {
          throw new BrawlStarsApiError('Brawl Stars API request timed out', 0);
        }
        if (error instanceof BrawlStarsApiError) {
          throw error;
        }
        // Never surface the underlying error: fetch implementations may include
        // request headers (and therefore the API key) in their messages.
        throw new BrawlStarsApiError('Network error while calling the Brawl Stars API', 0);
      } finally {
        clearTimeout(timer);
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS - 1) {
        throw new BrawlStarsApiError(
          `Brawl Stars API request failed with status ${response.status}`,
          response.status,
        );
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      await sleepFn(retryAfterMs ?? BASE_RETRY_DELAY_MS * (2 ** attempt));
    }

    // Unreachable, but required so the function has an explicit terminal path.
    throw new BrawlStarsApiError('Brawl Stars API request failed', 0);
  }

  return {
    getClub(tag) {
      return request(`/clubs/${encodeURIComponent(normalizeTag(tag))}`, clubSchema);
    },
    async getClubMembers(tag) {
      const response = await request(
        `/clubs/${encodeURIComponent(normalizeTag(tag))}/members`,
        clubMembersResponseSchema,
      );
      return response.items;
    },
    getPlayer(tag) {
      return request(`/players/${encodeURIComponent(normalizeTag(tag))}`, playerSchema);
    },
    async getBattleLog(tag) {
      try {
        const response = await request(
          `/players/${encodeURIComponent(normalizeTag(tag))}/battlelog`,
          battleLogResponseSchema,
        );
        return response.items;
      } catch (error) {
        // A private or unavailable battle log is simply empty history; do not
        // treat it as a sync failure or retry a definitively missing resource.
        if (error instanceof BrawlStarsApiError && error.status === 404) {
          return [];
        }
        throw error;
      }
    },
    async getBrawlers() {
      const response = await request('/brawlers', brawlerCatalogResponseSchema);
      return response.items;
    },
    getEventRotation() {
      return request('/events/rotation', eventRotationResponseSchema);
    },
  };
}

let sharedClient: BrawlStarsClient | null = null;

/**
 * Process-wide official API client. All callers should use this by default so
 * request throttling, timeouts and retry behavior are shared.
 * Options are only applied when the singleton has not been created yet.
 */
export function getSharedBrawlStarsClient(options?: BrawlStarsClientOptions): BrawlStarsClient {
  if (sharedClient === null) {
    sharedClient = createBrawlStarsClient(options);
  }
  return sharedClient;
}

/** Drops the module-level singleton. Intended for isolated tests only. */
export function resetSharedBrawlStarsClientForTests(): void {
  sharedClient = null;
}
