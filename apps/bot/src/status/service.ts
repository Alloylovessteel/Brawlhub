import { createBrawlStarsClient, type BrawlStarsClient } from '@brawlhub/brawl-stars';
import { createTrustedClient, isSupabaseConfigured } from '@brawlhub/database';
import { withTimeout } from '@brawlhub/sync';
import { loadSyncStatus } from '../admin/service';
import type { SyncStatusView } from '../admin/types';
import { asString, record } from '../clubs/service';
import { isManagedSyncInFlight } from '../sync/guard';
import { getBotRuntimeSnapshot, type BotRuntimeSnapshot } from './runtime';
import { applicationVersionLabel } from './version';

type DatabaseClient = ReturnType<typeof createTrustedClient>;

export type CheckState = 'ok' | 'unavailable' | 'error';

export interface HealthCheck {
  readonly state: CheckState;
  /** Generic, non-sensitive explanation safe to show to ordinary users. */
  readonly detail: string;
}

export interface DatabaseCheck extends HealthCheck {
  /** Null when the count could not be read. */
  readonly clubCount: number | null;
}

export interface SyncCheck extends HealthCheck {
  readonly status: string | null;
  readonly lastTimestamp: Date | null;
  readonly running: boolean;
}

export interface StatusView {
  readonly generatedAt: Date;
  readonly version: string;
  readonly overall: 'operational' | 'degraded';
  readonly discord: HealthCheck & { readonly uptimeMs: number; readonly connectedAt: Date | null };
  readonly database: DatabaseCheck;
  readonly api: HealthCheck;
  readonly sync: SyncCheck;
}

export interface StatusServiceOptions {
  readonly now?: () => Date;
  readonly runtime?: BotRuntimeSnapshot;
  readonly supabaseConfigured?: boolean;
  readonly db?: DatabaseClient;
  readonly apiClient?: BrawlStarsClient;
  readonly apiKeyConfigured?: boolean;
  readonly apiTimeoutMs?: number;
  readonly apiCacheMs?: number;
  readonly loadSync?: () => Promise<SyncStatusView>;
  readonly isSyncInFlight?: () => boolean;
}

const DEFAULT_API_TIMEOUT_MS = 5_000;
const DEFAULT_API_CACHE_MS = 60_000;

interface CachedApiCheck {
  readonly tag: string;
  readonly checkedAtMs: number;
  readonly check: HealthCheck;
}

let cachedApiCheck: CachedApiCheck | null = null;

/** Clear the cached lightweight API check (used by tests). */
export function resetStatusApiCache(): void {
  cachedApiCheck = null;
}

function apiKeyIsConfigured(): boolean {
  const raw = process.env.BRAWL_STARS_API_KEY?.trim();
  return raw !== undefined && raw.length > 0;
}

function parseTimestamp(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

async function checkDatabase(
  options: StatusServiceOptions,
): Promise<{ check: DatabaseCheck; db: DatabaseClient | null; sampleTag: string | null }> {
  const configured = options.supabaseConfigured ?? isSupabaseConfigured();
  if (!configured) {
    return {
      check: { state: 'unavailable', detail: 'Database is not configured.', clubCount: null },
      db: null,
      sampleTag: null,
    };
  }

  let db: DatabaseClient;
  try {
    db = options.db ?? createTrustedClient();
  } catch {
    return {
      check: { state: 'unavailable', detail: 'Database is not configured.', clubCount: null },
      db: null,
      sampleTag: null,
    };
  }

  try {
    const result = await db.from('clubs').select('tag', { count: 'exact' }).limit(1);
    if (result.error !== null && result.error !== undefined) {
      return {
        check: { state: 'error', detail: 'Database check failed.', clubCount: null },
        db,
        sampleTag: null,
      };
    }

    const firstRow = Array.isArray(result.data) ? result.data[0] : undefined;
    const sampleTag = asString(record(firstRow)?.['tag']);
    const clubCount = typeof result.count === 'number' && Number.isFinite(result.count)
      ? result.count
      : null;

    return {
      check: { state: 'ok', detail: 'Database responded.', clubCount },
      db,
      sampleTag,
    };
  } catch {
    return {
      check: { state: 'error', detail: 'Database check failed.', clubCount: null },
      db,
      sampleTag: null,
    };
  }
}

async function checkBrawlApi(
  sampleTag: string | null,
  options: StatusServiceOptions,
  nowMs: number,
): Promise<HealthCheck> {
  if (!(options.apiKeyConfigured ?? apiKeyIsConfigured())) {
    return { state: 'unavailable', detail: 'Official API key is not configured.' };
  }
  if (sampleTag === null) {
    return { state: 'unavailable', detail: 'No registered club is available for a lightweight API check.' };
  }

  const cacheMs = options.apiCacheMs ?? DEFAULT_API_CACHE_MS;
  const cached = cachedApiCheck;
  if (cached !== null && cached.tag === sampleTag && nowMs - cached.checkedAtMs < cacheMs) {
    return cached.check;
  }

  const client = options.apiClient ?? createBrawlStarsClient();
  const timeoutMs = options.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  let check: HealthCheck;
  try {
    await withTimeout(client.getClub(sampleTag), timeoutMs, 'status-api-check');
    check = { state: 'ok', detail: 'Official API responded for a registered club.' };
  } catch (error) {
    const timedOut = error instanceof Error && error.message.includes('timed out');
    check = {
      state: 'error',
      detail: timedOut
        ? 'Official API check timed out.'
        : 'Official API check failed.',
    };
  }

  cachedApiCheck = { tag: sampleTag, checkedAtMs: nowMs, check };
  return check;
}

const NO_SYNC_VIEW = (): SyncStatusView => ({
  latestRun: null,
  lock: { scope: 'all-clubs', lockedBy: null, lockedAt: null, lockedUntil: null, active: false },
  generatedAt: new Date(0),
});

async function checkSync(db: DatabaseClient | null, options: StatusServiceOptions): Promise<SyncCheck> {
  try {
    const view = await (options.loadSync ?? (() => loadSyncStatus(db === null ? {} : { db })))();
    const latest = view.latestRun;
    if (latest === null) {
      return {
        state: 'unavailable',
        detail: 'No synchronisation has been recorded.',
        status: null,
        lastTimestamp: null,
        running: view.lock.active || (options.isSyncInFlight?.() ?? isManagedSyncInFlight()),
      };
    }

    const running =
      view.lock.active ||
      latest.status === 'running' ||
      (options.isSyncInFlight?.() ?? isManagedSyncInFlight());
    return {
      state: latest.status === 'failed' ? 'error' : 'ok',
      detail: running ? 'Synchronisation is currently running.' : 'Stored synchronisation status is available.',
      status: latest.status,
      lastTimestamp:
        parseTimestamp(latest.finishedAt) ??
        parseTimestamp(latest.startedAt) ??
        parseTimestamp(latest.periodStart),
      running,
    };
  } catch {
    return {
      state: 'unavailable',
      detail: 'Synchronisation history is unavailable.',
      status: null,
      lastTimestamp: null,
      running: options.isSyncInFlight?.() ?? isManagedSyncInFlight(),
    };
  }
}

/** Build a public-safe operational snapshot. Raw errors and configuration are never included. */
export async function loadStatusView(options: StatusServiceOptions = {}): Promise<StatusView> {
  const now = options.now?.() ?? new Date();
  const runtime = options.runtime ?? getBotRuntimeSnapshot();
  const database = await checkDatabase(options);
  const api = await checkBrawlApi(database.sampleTag, options, now.getTime());
  const sync = await checkSync(database.db, options);

  const discord: StatusView['discord'] = runtime.discordReady
    ? {
        state: 'ok',
        detail: 'Discord gateway is connected.',
        uptimeMs: Math.max(0, now.getTime() - runtime.startedAt.getTime()),
        connectedAt: runtime.discordReadyAt,
      }
    : {
        state: 'error',
        detail: 'Discord gateway is not connected.',
        uptimeMs: Math.max(0, now.getTime() - runtime.startedAt.getTime()),
        connectedAt: null,
      };

  const allOk =
    discord.state === 'ok' &&
    database.check.state === 'ok' &&
    api.state === 'ok' &&
    sync.state === 'ok';

  return {
    generatedAt: now,
    version: applicationVersionLabel(),
    overall: allOk ? 'operational' : 'degraded',
    discord,
    database: database.check,
    api,
    sync,
  };
}

/** Test helper providing an explicit empty sync view. */
export function emptySyncStatusView(): SyncStatusView {
  return NO_SYNC_VIEW();
}
