import {
  runSyncForAllGuilds,
  type RunSyncOptions,
  type SyncNotifier,
  type SyncResult,
} from '@brawlhub/sync';

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
 * concurrent in-process starts. Database locks inside runSync() still protect
 * overlapping runs from other processes; this guard only covers this bot.
 */
export async function runManagedSync(options: ManagedSyncOptions = {}): Promise<ManagedSyncOutcome> {
  if (inFlight) {
    return { kind: 'overlap' };
  }

  inFlight = true;
  try {
    const runner = options.run ?? runSyncForAllGuilds;
    const runOptions: Pick<RunSyncOptions, 'notifier' | 'notifierForGuild'> = {};
    if (options.notifier !== undefined) runOptions.notifier = options.notifier;
    if (options.notifierForGuild !== undefined) runOptions.notifierForGuild = options.notifierForGuild;
    const results = await runner(runOptions);
    return { kind: 'ran', results };
  } finally {
    inFlight = false;
  }
}
