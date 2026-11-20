// Config is imported first: its top-level dotenv call must run before any other
// module (for example @brawlhub/logging) gets a chance to read environment variables.
import { getBotConfig } from './config.js';
import { createLogger } from '@brawlhub/logging';
import { Client, type Interaction } from 'discord.js';
import { handleInteraction, registerCommands } from './commands/index.js';
import { createDiscordNotifier } from './notifier.js';
import { recoverInterruptedSyncs } from '@brawlhub/sync';
import { runManagedSync } from './sync/guard.js';
import { registerDiscordAuthorizationEvents } from './discord/events.js';
import { getGatewayIntents } from './discord/intents.js';
import { markDiscordDisconnected, markDiscordReady } from './status/runtime.js';
import { startClubOverviewSchedule } from './clubs/overview/service.js';

const logger = createLogger('bot');

/** Log a sanitized error message; the bot token is never included in logs. */
function safeError(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (secret !== undefined && secret !== '' && message.includes(secret)) {
    return message.split(secret).join('[REDACTED]');
  }
  return message;
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

const SYNC_INTERVAL_MS = readSyncIntervalMinutes() * 60_000;
const INITIAL_SYNC_DELAY_MS = 5_000;

let initialSyncTimer: ReturnType<typeof setTimeout> | undefined;
let syncTimer: ReturnType<typeof setInterval> | undefined;
let stopOverviewSchedule: (() => void) | undefined;

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
    void executeSync();
  }, INITIAL_SYNC_DELAY_MS);
  syncTimer = setInterval(() => {
    void executeSync();
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
  stopOverviewSchedule = startClubOverviewSchedule(async (guildId) => {
    try {
      const guild = await client.guilds.fetch(guildId);
      return guild.name;
    } catch {
      return null;
    }
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down');
  stopSyncSchedule();
  stopOverviewSchedule?.();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  stopSyncSchedule();
  stopOverviewSchedule?.();
  client.destroy();
  process.exit(0);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled promise rejection', { error: safeError(reason, token) });
  process.exit(1);
});

process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught exception', { error: safeError(error, token) });
  process.exit(1);
});

try {
  await client.login(token);
} catch (error) {
  logger.error('Discord login failed', { error: safeError(error, token) });
  process.exit(1);
}
