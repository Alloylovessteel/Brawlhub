// Config is imported first: its top-level dotenv call must run before any other
// module (for example @brawlhub/logging) gets a chance to read environment variables.
import { getBotConfig } from './config.js';
import { createLogger } from '@brawlhub/logging';
import { Client, type Interaction } from 'discord.js';
import { handleInteraction, registerCommands } from './commands/index.js';
import { createDiscordNotifier } from './notifier.js';
import { notifySyncResult } from './operator-notifier.js';
import { recoverInterruptedSyncs, type SyncResult } from '@brawlhub/sync';
import { runManagedSync } from './sync/guard.js';
import { registerDiscordAuthorizationEvents } from './discord/events.js';
import { getGatewayIntents } from './discord/intents.js';
import { markDiscordDisconnected, markDiscordReady } from './status/runtime.js';
import {
  refreshOverviewNow,
  startClubOverviewSchedule,
  type GuildOverviewContext,
} from './clubs/overview/service.js';
import { refreshTodayClubLogDigest, startClubLogsSchedule } from './clubs/logs/poster.js';
import { startReportsSchedule } from './reports/schedule.js';
import { waitForInFlightWork } from './shutdown.js';
import {
  acquireSingleInstanceLock,
  releaseSingleInstanceLock,
  SingleInstanceBusyError,
  type SingleInstanceLock,
} from './single-instance.js';
import { startBattleRawRetentionSchedule } from './retention/schedule.js';
import { refreshAllConfiguredClubRoles } from './club-roles/service.js';
import { refreshAllConfiguredNicknames } from './nickname-sync/service.js';
import {
  reconcileAllConfiguredRoles,
  setRoleAutomationClient,
} from './role-automation/index.js';
import { startVerificationAutoCheckSchedule } from './verification/auto-check.js';
import {
  startLiveBattleSchedule,
  stopLiveBattleSchedule,
} from './live/service.js';

const logger = createLogger('bot');

/** Log a sanitized error message; the bot token is never included in logs. */
function safeError(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (secret !== undefined && secret !== '' && message.includes(secret)) {
    return message.split(secret).join('[REDACTED]');
  }
  return message;
}

async function releaseLockSafely(): Promise<void> {
  try {
    await releaseSingleInstanceLock(instanceLock);
  } catch (error) {
    logger.warn('Could not release the single-instance lock', {
      error: safeError(error, token),
    });
  }
}

const config = getBotConfig();
const { token } = config;

/** Read the sync cadence in minutes, defaulting to 15 and clamping to 1..1440. */
function readSyncIntervalMinutes(): number {
  const raw = process.env.SYNC_INTERVAL_MINUTES;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) {
    return 15;
  }
  return Math.min(1440, Math.max(1, Math.floor(parsed)));
}

/** Read the auto-role reconciliation cadence in minutes, defaulting to 15. */
function readAutoRoleIntervalMinutes(): number {
  const raw = process.env.AUTO_ROLE_INTERVAL_MINUTES;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) {
    return 15;
  }
  return Math.min(1440, Math.max(1, Math.floor(parsed)));
}

const SYNC_INTERVAL_MS = readSyncIntervalMinutes() * 60_000;
const AUTO_ROLE_INTERVAL_MS = readAutoRoleIntervalMinutes() * 60_000;
const INITIAL_SYNC_DELAY_MS = 5_000;

let initialSyncTimer: ReturnType<typeof setTimeout> | undefined;
let autoRoleTimer: ReturnType<typeof setInterval> | undefined;
let syncTimer: ReturnType<typeof setInterval> | undefined;
let stopOverviewSchedule: (() => void) | undefined;
let stopClubLogsSchedule: (() => void) | undefined;
let stopReportsSchedule: (() => void) | undefined;
let stopRetentionSchedule: (() => void) | undefined;
let stopVerificationAutoCheckSchedule: (() => void) | undefined;
let activeSync: Promise<void> | undefined;
let activeRoleReconcile: Promise<void> | undefined;
let instanceLock: SingleInstanceLock | undefined;

const SHUTDOWN_SYNC_TIMEOUT_MS = 10_000;

/** Start a scheduled sync and remember it so shutdown can drain it. */
function startTrackedSync(): void {
  const run = executeSync();
  activeSync = run;
  const clear = (): void => {
    if (activeSync === run) activeSync = undefined;
  };
  void run.then(clear, clear);
}

/** Refresh configured club-rank roles after a successful sync batch. */
async function refreshConfiguredClubRolesSafely(): Promise<void> {
  try {
    const result = await refreshAllConfiguredClubRoles(client);
    if (result.guilds > 0 || result.errors > 0) {
      logger.info('Club role refresh after sync', {
        guilds: result.guilds,
        planned: result.planned,
        processed: result.processed,
        cleanedMembers: result.cleanedMembers,
        errors: result.errors,
      });
    }
  } catch (error: unknown) {
    logger.warn('Club role refresh after sync failed', { error: safeError(error, token) });
  }
}

/** Reconcile declarative auto roles without affecting the sync outcome. */
async function refreshAutoRolesSafely(): Promise<void> {
  try {
    const result = await reconcileAllConfiguredRoles(client);
    if (result.configuredGuilds > 0 || result.errorCount > 0) {
      logger.info('Auto role reconciliation finished', {
        configuredGuilds: result.configuredGuilds,
        guilds: result.guilds,
        rolesAdded: result.rolesAdded,
        rolesRemoved: result.rolesRemoved,
        rolesUnchanged: result.rolesUnchanged,
        membersNotFound: result.membersNotFound,
        errors: result.errorCount,
      });
    }
  } catch (error) {
    logger.warn('Auto role reconciliation failed', { error: safeError(error, token) });
  }
  await refreshVerifiedNicknamesSafely();
}

/** Sync verified-member nicknames without affecting role reconciliation or sync outcomes. */
async function refreshVerifiedNicknamesSafely(): Promise<void> {
  try {
    const result = await refreshAllConfiguredNicknames(client);
    if (result.guilds > 0 || result.failures > 0) {
      logger.info('Verified nickname refresh finished', {
        guilds: result.guilds,
        members: result.members,
        updated: result.updated,
        unchanged: result.unchanged,
        notMembers: result.notMembers,
        unresolved: result.unresolved,
        restored: result.restored,
        released: result.released,
        failures: result.failures,
      });
    }
  } catch (error) {
    logger.warn('Verified nickname refresh failed', { error: safeError(error, token) });
  }
}

/** Start a tracked auto-role reconciliation so shutdown can drain it. */
function startTrackedRoleReconcile(): void {
  const run = refreshAutoRolesSafely();
  activeRoleReconcile = run;
  const clear = (): void => {
    if (activeRoleReconcile === run) activeRoleReconcile = undefined;
  };
  void run.then(clear, clear);
}

function startAutoRoleSchedule(): void {
  setRoleAutomationClient(client);
  autoRoleTimer = setInterval(() => {
    startTrackedRoleReconcile();
  }, AUTO_ROLE_INTERVAL_MS);
  logger.info('Auto role reconciliation enabled', {
    intervalMinutes: AUTO_ROLE_INTERVAL_MS / 60_000,
  });
}

function stopAutoRoleSchedule(): void {
  if (autoRoleTimer !== undefined) {
    clearInterval(autoRoleTimer);
    autoRoleTimer = undefined;
  }
}

/** Post operator summaries without letting notification failures affect sync. */
async function postOperatorSyncResult(result: SyncResult): Promise<void> {
  try {
    await notifySyncResult(result);
  } catch (error: unknown) {
    logger.warn('Operator sync notice failed', { error: safeError(error, token) });
  }
}

/** Edit today's club log in place after a completed scheduled sync. */
async function refreshDailyClubLogAfterScheduledSync(guildId: string): Promise<void> {
  try {
    await refreshTodayClubLogDigest(guildId);
  } catch (error: unknown) {
    logger.warn('Scheduled daily club log refresh failed', {
      guildId,
      error: safeError(error, token),
    });
  }
}

/** Resolve guild presentation details without letting Discord failures stop sync. */
async function resolveGuildOverviewContext(guildId: string): Promise<GuildOverviewContext> {
  try {
    const guild = await client.guilds.fetch(guildId);
    return { label: guild.name, iconUrl: guild.iconURL() ?? null };
  } catch {
    return { label: null, iconUrl: null };
  }
}

/** Refresh the posted overview as soon as scheduled sync makes snapshots visible. */
async function refreshOverviewAfterScheduledSync(guildId: string): Promise<void> {
  try {
    const context = await resolveGuildOverviewContext(guildId);
    await refreshOverviewNow(guildId, context);
  } catch (error: unknown) {
    logger.warn('Scheduled club overview refresh failed', {
      guildId,
      error: safeError(error, token),
    });
  }
}

/** Run scheduled sync for all guilds, skipping if a previous batch is running. */
async function executeSync(): Promise<void> {
  try {
    const outcome = await runManagedSync({
      notifierForGuild: (guildId) => createDiscordNotifier({ guildId }),
    });
    if (outcome.kind === 'overlap') {
      logger.warn('Scheduled sync skipped: a sync run is already in progress');
      return;
    }
    const followUps: Promise<void>[] = [];
    for (const result of outcome.results) {
      const meta = {
        syncRunId: result.syncRunId,
        status: result.status,
        clubsProcessed: result.clubsProcessed,
        playersUpserted: result.playersUpserted,
        snapshotsWritten: result.snapshotsWritten,
        membershipEvents: result.membershipEvents,
        notificationsSent: result.notificationsSent,
        ...(result.error === undefined ? {} : { error: result.error }),
      };

      if (result.status === 'failed') {
        logger.warn('Scheduled sync failed', meta);
        followUps.push(postOperatorSyncResult(result));
        continue;
      }
      if (result.status === 'skipped') {
        if (typeof result.error === 'string' && result.error.includes('No clubs registered')) {
          logger.info('Scheduled sync skipped: no clubs registered', meta);
        } else {
          logger.warn('Scheduled sync skipped', meta);
        }
        continue;
      }

      logger.info('Scheduled sync finished', meta);
      followUps.push(postOperatorSyncResult(result));
      if (result.guildId !== undefined && result.guildId !== '') {
        followUps.push(refreshOverviewAfterScheduledSync(result.guildId));
        followUps.push(refreshDailyClubLogAfterScheduledSync(result.guildId));
      }
    }

    await Promise.allSettled(followUps);
    if (outcome.results.some((result) => result.status === 'completed')) {
      await refreshConfiguredClubRolesSafely();
      await refreshAutoRolesSafely();
    }
  } catch (error: unknown) {
    logger.error('Scheduled sync failed', { error: safeError(error, token) });
  }
}

/** Release sync claims abandoned by a previous process before scheduling work. */
async function recoverSyncState(): Promise<void> {
  try {
    const outcome = await recoverInterruptedSyncs();
    if (outcome.recoveredRuns > 0) {
      logger.warn('Recovered sync runs interrupted by a previous process', {
        runs: outcome.recoveredRuns,
        scopes: outcome.clearedScopes.join(', '),
      });
    }
  } catch (error: unknown) {
    logger.warn('Could not recover interrupted sync runs', { error: safeError(error, token) });
  }
}

function startSyncSchedule(): void {
  initialSyncTimer = setTimeout(() => {
    startTrackedSync();
  }, INITIAL_SYNC_DELAY_MS);
  syncTimer = setInterval(() => {
    startTrackedSync();
  }, SYNC_INTERVAL_MS);

  logger.info('Scheduled sync enabled', {
    intervalMinutes: SYNC_INTERVAL_MS / 60_000,
    initialDelayMs: INITIAL_SYNC_DELAY_MS,
  });
}

function stopSyncSchedule(): void {
  if (initialSyncTimer !== undefined) {
    clearTimeout(initialSyncTimer);
    initialSyncTimer = undefined;
  }
  if (syncTimer !== undefined) {
    clearInterval(syncTimer);
    syncTimer = undefined;
  }
}

if (token === undefined) {
  const missing: string[] = [];
  if (config.token === undefined) {
    missing.push('DISCORD_TOKEN');
  }
  if (config.clientId === undefined) {
    missing.push('DISCORD_CLIENT_ID');
  }
  if (config.guildId === undefined) {
    missing.push('DISCORD_GUILD_ID');
  }
  if (config.callbackUrl === undefined) {
    missing.push('DISCORD_CALLBACK_URL');
  }
  if (config.logLevel === undefined) {
    missing.push('LOG_LEVEL');
  }

  logger.warn(
    'BrawlHub bot is running in configuration-check (dry-run) mode: DISCORD_TOKEN is not configured, so no Discord connection will be attempted.'
  );
  logger.warn('Missing environment variables', { names: missing.join(', ') });
  process.exit(0);
}

try {
  instanceLock = await acquireSingleInstanceLock();
} catch (error) {
  if (error instanceof SingleInstanceBusyError) {
    logger.warn(error.message, {
      lockPath: error.lockPath,
      holderPid: error.holderPid,
    });
  } else {
    logger.error('Could not acquire the single-instance lock', {
      error: safeError(error, token),
    });
  }
  process.exit(1);
}

const client = new Client({
  intents: getGatewayIntents(),
});

registerDiscordAuthorizationEvents(client, config.guildId);

client.on('interactionCreate', (interaction: Interaction) => {
  handleInteraction(interaction).catch((error: unknown) => {
    logger.error('Unexpected error while handling an interaction', { error: safeError(error, token) });
  });
});

client.on('shardDisconnect', () => markDiscordDisconnected());
client.on('shardReconnecting', () => markDiscordDisconnected());
client.on('shardResume', () => markDiscordReady());

client.once('clientReady', async () => {
  markDiscordReady();
  logger.info(`Logged in as ${client.user?.tag ?? 'unknown'}`);
  registerCommands().catch((error: unknown) => {
    logger.error('Unexpected error while registering commands', { error: safeError(error, token) });
  });
  await recoverSyncState();
  startSyncSchedule();
  stopOverviewSchedule = startClubOverviewSchedule(resolveGuildOverviewContext);
  stopClubLogsSchedule = startClubLogsSchedule();
  stopReportsSchedule = startReportsSchedule();
  stopRetentionSchedule = startBattleRawRetentionSchedule();
  startLiveBattleSchedule(client);
  startAutoRoleSchedule();
  stopVerificationAutoCheckSchedule = startVerificationAutoCheckSchedule(client);
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);
  stopSyncSchedule();
  stopOverviewSchedule?.();
  stopClubLogsSchedule?.();
  stopReportsSchedule?.();
  stopRetentionSchedule?.();
  stopLiveBattleSchedule();
  stopAutoRoleSchedule();
  stopVerificationAutoCheckSchedule?.();

  if (activeRoleReconcile !== undefined) {
    const drained = await waitForInFlightWork(activeRoleReconcile, SHUTDOWN_SYNC_TIMEOUT_MS);
    if (drained) {
      logger.info('In-flight auto role reconciliation finished; shutting down');
    } else {
      logger.warn('In-flight auto role reconciliation did not finish in time; shutting down anyway');
    }
  }

  if (activeSync !== undefined) {
    logger.info('Waiting for in-flight sync before shutdown');
    const drained = await waitForInFlightWork(activeSync, SHUTDOWN_SYNC_TIMEOUT_MS);
    if (drained) {
      logger.info('In-flight sync finished; shutting down');
    } else {
      logger.warn('In-flight sync did not finish in time; shutting down anyway');
    }
  }

  client.destroy();
  await releaseLockSafely();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled promise rejection', { error: safeError(reason, token) });
  void releaseLockSafely().finally(() => process.exit(1));
});

process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught exception', { error: safeError(error, token) });
  void releaseLockSafely().finally(() => process.exit(1));
});

try {
  await client.login(token);
} catch (error) {
  logger.error('Discord login failed', { error: safeError(error, token) });
  await releaseLockSafely();
  process.exit(1);
}
