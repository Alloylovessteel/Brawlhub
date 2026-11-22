import { createHash } from 'node:crypto';
import { createTrustedClient } from '@brawlhub/database';
import { readBrawlStarsTimeoutMs } from '@brawlhub/brawl-stars';
import type { SupabaseClient } from '@supabase/supabase-js';

export { getSharedBrawlStarsClient } from '@brawlhub/brawl-stars';

const PROVIDER = 'brawl_stars';
const DEFAULT_SUCCESS_TTL_MS = 30_000;
const DEFAULT_NEGATIVE_TTL_MS = 5_000;
const MAX_SUCCESS_TTL_MS = 60 * 60_000;
const MAX_NEGATIVE_TTL_MS = 5 * 60_000;
const MAX_ERROR_LENGTH = 1000;

export interface OfficialCachePolicy {
  /** TTL for successful official API payloads. */
  readonly successTtlMs: number;
  /** TTL for cached official API failures (never reuse the success TTL). */
  readonly negativeTtlMs: number;
  /** Per-request timeout applied by the shared client. */
  readonly timeoutMs: number;
}

export type OfficialCacheParamValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly OfficialCacheParamValue[];

export type OfficialCacheParams = Readonly<Record<string, OfficialCacheParamValue>>;

export interface OfficialCacheSuccess<T> {
  readonly kind: 'success';
  readonly payload: T;
  readonly fetchedAt: string;
  readonly etag: string | null;
}

export interface OfficialCacheFailure {
  readonly kind: 'failure';
  readonly status: number;
  readonly lastError: string;
  readonly fetchedAt: string;
}

export type OfficialCacheEntry<T> = OfficialCacheSuccess<T> | OfficialCacheFailure;

export type OfficialCacheWrite<T> =
  | {
      readonly kind: 'success';
      readonly payload: T;
      readonly status?: number;
      readonly etag?: string | null;
      readonly ttlMs?: number;
    }
  | {
      readonly kind: 'failure';
      readonly status: number;
      readonly lastError: string;
      readonly ttlMs?: number;
    };

interface StoredCacheEntry {
  readonly entry: OfficialCacheEntry<unknown>;
  readonly expiresAtMs: number;
}

const memoryCache = new Map<string, StoredCacheEntry>();

function readDurationEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.trunc(parsed));
}

/** Single source of truth for official API cache TTLs and request timeout. */
export function readOfficialCachePolicy(): OfficialCachePolicy {
  return {
    successTtlMs: readDurationEnv(
      'BRAWL_STARS_SUCCESS_CACHE_MS',
      DEFAULT_SUCCESS_TTL_MS,
      MAX_SUCCESS_TTL_MS,
    ),
    negativeTtlMs: readDurationEnv(
      'BRAWL_STARS_NEGATIVE_CACHE_MS',
      DEFAULT_NEGATIVE_TTL_MS,
      MAX_NEGATIVE_TTL_MS,
    ),
    timeoutMs: readBrawlStarsTimeoutMs(),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item !== undefined) sorted[key] = canonicalize(item);
    }
    return sorted;
  }
  return value;
}

function normalizeTag(tag: string | null | undefined): string | null {
  const value = tag?.trim().replace(/^#+/, '').toUpperCase() ?? '';
  return value === '' ? null : value;
}

function normalizeGuildId(guildId: string | null | undefined): string | null {
  const value = guildId?.trim() ?? '';
  return value === '' ? null : value;
}

interface CacheIdentity {
  readonly key: string;
  readonly paramsHash: string;
  readonly tag: string | null;
  readonly guildId: string | null;
}

function cacheIdentity(
  tag: string | null | undefined,
  endpoint: string,
  params: OfficialCacheParams | undefined,
  guildId: string | null | undefined,
): CacheIdentity {
  const normalizedTag = normalizeTag(tag);
  const scopeGuildId = normalizeGuildId(guildId);
  const paramsHash = createHash('sha256')
    .update(JSON.stringify(canonicalize({ endpoint, params: params ?? {} })))
    .digest('hex');
  return {
    key: [PROVIDER, endpoint, scopeGuildId ?? '', normalizedTag ?? '', paramsHash].join('|'),
    paramsHash,
    tag: normalizedTag,
    guildId: scopeGuildId,
  };
}

function getCacheDb(): SupabaseClient | null {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() === '') return null;
  try {
    return createTrustedClient();
  } catch {
    // Cache is best-effort; without a trusted client we use process memory.
    return null;
  }
}

function entryFromRow(row: Record<string, unknown>): OfficialCacheEntry<unknown> | null {
  const fetchedAtValue = row['fetched_at'];
  const fetchedAt =
    typeof fetchedAtValue === 'string' && !Number.isNaN(Date.parse(fetchedAtValue))
      ? new Date(fetchedAtValue).toISOString()
      : new Date().toISOString();
  const payload = row['payload'];
  if (payload !== null && payload !== undefined) {
    return {
      kind: 'success',
      payload,
      fetchedAt,
      etag: typeof row['etag'] === 'string' ? row['etag'] : null,
    };
  }
  const statusValue = row['status'];
  return {
    kind: 'failure',
    status: typeof statusValue === 'number' ? statusValue : 0,
    lastError:
      typeof row['last_error'] === 'string' && row['last_error'].length > 0
        ? row['last_error']
        : 'Official API request failed',
    fetchedAt,
  };
}

/**
 * Reads a cached official response or short-lived failure. Results are scoped
 * by provider, endpoint, normalized tag, params hash and optional guild id.
 */
export async function readOfficialCache<T>(
  tag: string | null | undefined,
  endpoint: string,
  params?: OfficialCacheParams,
  guildId?: string | null,
): Promise<OfficialCacheEntry<T> | null> {
  const identity = cacheIdentity(tag, endpoint, params, guildId);
  const cached = memoryCache.get(identity.key);
  if (cached !== undefined) {
    if (cached.expiresAtMs > Date.now()) {
      return cached.entry as OfficialCacheEntry<T>;
    }
    memoryCache.delete(identity.key);
  }

  const db = getCacheDb();
  if (db === null) return null;

  try {
    let query = db
      .from('official_api_cache')
      .select('payload, status, last_error, fetched_at, expires_at, etag')
      .eq('provider', PROVIDER)
      .eq('endpoint', endpoint)
      .eq('params_hash', identity.paramsHash);
    query = identity.guildId === null
      ? query.is('scope_guild_id', null)
      : query.eq('scope_guild_id', identity.guildId);
    query = identity.tag === null
      ? query.is('tag', null)
      : query.eq('tag', identity.tag);

    const { data, error } = await query.maybeSingle();
    if (error !== null && error !== undefined) return null;
    if (data === null || data === undefined) return null;

    const row = data as Record<string, unknown>;
    const expiresAtMs = Date.parse(String(row['expires_at'] ?? ''));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
    return entryFromRow(row) as OfficialCacheEntry<T> | null;
  } catch {
    return null;
  }
}

function resolveTtl(entry: OfficialCacheWrite<unknown>, policy: OfficialCachePolicy): number {
  const limit = entry.kind === 'success' ? MAX_SUCCESS_TTL_MS : MAX_NEGATIVE_TTL_MS;
  const fallback = entry.kind === 'success' ? policy.successTtlMs : policy.negativeTtlMs;
  const requested = entry.ttlMs;
  if (requested === undefined) return Math.max(0, Math.min(limit, fallback));
  if (!Number.isFinite(requested) || requested < 0) return Math.max(0, Math.min(limit, fallback));
  return Math.min(limit, Math.trunc(requested));
}

/** Stores a success or a failure using its own TTL; failures never use success TTL. */
export async function writeOfficialCache<T>(
  tag: string | null | undefined,
  endpoint: string,
  params: OfficialCacheParams | undefined,
  guildId: string | null | undefined,
  entry: OfficialCacheWrite<T>,
): Promise<void> {
  const identity = cacheIdentity(tag, endpoint, params, guildId);
  const policy = readOfficialCachePolicy();
  const ttlMs = resolveTtl(entry as OfficialCacheWrite<unknown>, policy);
  const nowMs = Date.now();
  const fetchedAt = new Date(nowMs).toISOString();
  const stored: OfficialCacheEntry<T> = entry.kind === 'success'
    ? {
        kind: 'success',
        payload: entry.payload,
        fetchedAt,
        etag: entry.etag ?? null,
      }
    : {
        kind: 'failure',
        status: entry.status,
        lastError: safeErrorText(entry.lastError) ?? 'Official API request failed',
        fetchedAt,
      };

  memoryCache.set(identity.key, {
    entry: stored as OfficialCacheEntry<unknown>,
    expiresAtMs: nowMs + ttlMs,
  });

  const db = getCacheDb();
  if (db === null || ttlMs <= 0) return;

  try {
    let scope = db
      .from('official_api_cache')
      .delete()
      .eq('provider', PROVIDER)
      .eq('endpoint', endpoint)
      .eq('params_hash', identity.paramsHash);
    scope = identity.guildId === null
      ? scope.is('scope_guild_id', null)
      : scope.eq('scope_guild_id', identity.guildId);
    scope = identity.tag === null
      ? scope.is('tag', null)
      : scope.eq('tag', identity.tag);
    const deleted = await scope;
    if (deleted.error !== null && deleted.error !== undefined) return;

    await db.from('official_api_cache').insert({
      provider: PROVIDER,
      endpoint,
      scope_guild_id: identity.guildId,
      tag: identity.tag,
      params_hash: identity.paramsHash,
      payload: entry.kind === 'success' ? entry.payload : null,
      status: entry.kind === 'success' ? (entry.status ?? 200) : entry.status,
      last_error: entry.kind === 'failure' ? safeErrorText(entry.lastError) : null,
      fetched_at: fetchedAt,
      expires_at: new Date(nowMs + ttlMs).toISOString(),
      etag: entry.kind === 'success' ? (entry.etag ?? null) : null,
    });
  } catch {
    // Memory cache is already populated; database persistence is optional.
  }
}

function safeErrorText(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = raw
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)(\S+)/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  if (sanitized === '') return null;
  return sanitized.length > MAX_ERROR_LENGTH
    ? `${sanitized.slice(0, MAX_ERROR_LENGTH - 3)}...`
    : sanitized;
}

export interface OfficialApiCallMetric {
  readonly guildId?: string | null;
  readonly endpoint: string;
  readonly status?: number | null;
  readonly durationMs?: number | null;
  readonly retryCount?: number;
  readonly error?: unknown;
}

/** Best-effort metrics write; never throws and never stores a raw secret. */
export async function recordOfficialApiCall(metric: OfficialApiCallMetric): Promise<void> {
  const db = getCacheDb();
  if (db === null) return;
  try {
    await db.from('api_call_metrics').insert({
      guild_id: normalizeGuildId(metric.guildId),
      provider: PROVIDER,
      endpoint: metric.endpoint,
      status: metric.status ?? null,
      duration_ms: metric.durationMs ?? null,
      retry_count: metric.retryCount ?? 0,
      error: safeErrorText(metric.error),
    });
  } catch {
    // Metrics are observational only.
  }
}

/** Clears the in-memory gateway cache. Intended for isolated tests. */
export function resetOfficialApiCacheForTests(): void {
  memoryCache.clear();
}
