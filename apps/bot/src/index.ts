// Config is imported first: its top-level dotenv call must run before any other
// module (for example @brawlhub/logging) gets a chance to read environment variables.
import { getBotConfig } from './config.js';
import { createLogger } from '@brawlhub/logging';
import { Client, type Interaction } from 'discord.js';
import { handleInteraction, registerCommands } from './commands/index.js';
import type { SyncNotifier } from '@brawlhub/sync';
import { createDiscordNotifier } from './notifier.js';
import { runManagedSync } from './sync/guard.js';
import { registerDiscordAuthorizationEvents } from './discord/events.js';
import { getGatewayIntents } from './discord/intents.js';

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

/** Run one sync, skipping it if a previous run is still in progress. */
async function executeSync(): Promise<void> {
  try {
    const notifier: SyncNotifier = createDiscordNotifier();
    const outcome = await runManagedSync({ notifier });
    if (outcome.kind === 'overlap') {
      logger.warn('Scheduled sync skipped: a sync run is already in progress');
      return;
    }
    const result = outcome.result;
    logger.info('Scheduled sync finished', {
      syncRunId: result.syncRunId,
      status: result.status,
      clubsProcessed: result.clubsProcessed,
      playersUpserted: result.playersUpserted,
      snapshotsWritten: result.snapshotsWritten,
      membershipEvents: result.membershipEvents,
      notificationsSent: result.notificationsSent,
      ...(result.error === undefined ? {} : { error: result.error }),
    });
  } catch (error: unknown) {
    logger.error('Scheduled sync failed', { error: safeError(error, token) });
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

client.once('clientReady', () => {
  logger.info(`Logged in as ${client.user?.tag ?? 'unknown'}`);
  registerCommands().catch((error: unknown) => {
    logger.error('Unexpected error while registering commands', { error: safeError(error, token) });
  });
  startSyncSchedule();
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down');
  stopSyncSchedule();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  stopSyncSchedule();
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
