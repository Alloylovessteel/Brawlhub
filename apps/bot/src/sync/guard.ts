import { randomUUID } from 'node:crypto';
import { createLogger } from '@brawlhub/logging';
import {
  acquireRuntimeLease,
  releaseRuntimeLease,
  renewRuntimeLease,
  type RuntimeLease,
} from '../state/index.js';
import {
  runSyncForAllGuilds,
  type RunSyncOptions,
  type SyncNotifier,
  type SyncResult,
} from '@brawlhub/sync';

const logger = createLogger('bot');

const LEASE_KIND = 'managed-sync';
const LEASE_SCOPE = 'all-guilds';
const LEASE_TTL_MS = 5 * 60 * 1000;
const LEASE_RENEW_MS = 60 * 1000;

export type ManagedSyncOutcome =
  | { readonly kind: 'ran'; readonly results: SyncResult[] }
  | { readonly kind: 'overlap' };

export interface ManagedSyncOptions {
  readonly notifier?: SyncNotifier;
  readonly notifierForGuild?: RunSyncOptions['notifierForGuild'];
  readonly run?: (
    options?: Pick<RunSyncOptions, 'notifier' | 'notifierForGuild'>,
  ) => Promise<SyncResult[]>;
}

let inFlight = false;

/** True while this bot process is already running a managed sync batch. */
export function isManagedSyncInFlight(): boolean {
  return inFlight;
}

/** Test-only reset for the in-process guard. */
export function resetManagedSyncGuard(): void {
  inFlight = false;
}

/**
 * Run the sync pipeline for every guild with registered clubs, refusing
 * concurrent in-process starts and cluster-wide starts via a DB runtime lease.
 * Database locks inside runSync() remain authoritative; this guard only avoids
 * duplicate batches before those locks are reached.
 */
export async function runManagedSync(options: ManagedSyncOptions = {}): Promise<ManagedSyncOutcome> {
  if (inFlight) {
    return { kind: 'overlap' };
  }

  inFlight = true;
  let lease: RuntimeLease | null = null;
  let renewal: ReturnType<typeof setInterval> | null = null;
  try {
    try {
      const acquired = await acquireRuntimeLease({
        leaseKind: LEASE_KIND,
        scope: LEASE_SCOPE,
        ownerId: randomUUID(),
        ttlMs: LEASE_TTL_MS,
      });
      if (acquired.kind === 'held') {
        return { kind: 'overlap' };
      }
      lease = acquired.lease;
    } catch (error) {
      // sync_locks is authoritative. A lease-store failure must not take down
      // scheduled sync; log it and proceed with the in-process guard only.
      logger.warn('Managed sync could not acquire the DB runtime lease', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (lease !== null) {
      const heldLease = lease;
      renewal = setInterval(() => {
        void renewRuntimeLease(heldLease, LEASE_TTL_MS).catch((error: unknown) => {
          logger.warn('Managed sync could not renew the DB runtime lease', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, LEASE_RENEW_MS);
      renewal.unref?.();
    }

    const runner = options.run ?? runSyncForAllGuilds;
    const runOptions: Pick<RunSyncOptions, 'notifier' | 'notifierForGuild'> = {};
    if (options.notifier !== undefined) runOptions.notifier = options.notifier;
    if (options.notifierForGuild !== undefined) runOptions.notifierForGuild = options.notifierForGuild;
    const results = await runner(runOptions);
    return { kind: 'ran', results };
  } finally {
    if (renewal !== null) clearInterval(renewal);
    renewal = null;
    if (lease !== null) {
      const heldLease = lease;
      lease = null;
      try {
        await releaseRuntimeLease(heldLease);
      } catch (error) {
        logger.warn('Managed sync could not release the DB runtime lease', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    inFlight = false;
  }
}
