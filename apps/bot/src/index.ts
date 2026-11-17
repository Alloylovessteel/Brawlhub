// Config is imported first: its top-level dotenv call must run before any other
// module (for example @brawlhub/logging) gets a chance to read environment variables.
import { getBotConfig } from './config.js';
import { createLogger } from '@brawlhub/logging';
import { Client, GatewayIntentBits, type Interaction } from 'discord.js';
import { handleInteraction, registerCommands } from './commands/index.js';

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
  intents: [GatewayIntentBits.Guilds],
});

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
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down');
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
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
