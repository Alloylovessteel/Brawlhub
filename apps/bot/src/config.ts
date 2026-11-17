import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// Workspace scripts run with `apps/bot` as the cwd, so resolve from there to the monorepo root.
loadEnv({ path: resolve(process.cwd(), '../../.env') });

const PLACEHOLDER_PREFIX = 'your-';

/**
 * Bot-related environment values. Every field is `string | undefined` so callers
 * can decide how to handle missing configuration explicitly.
 */
export interface BotConfig {
  readonly token: string | undefined;
  readonly clientId: string | undefined;
  readonly guildId: string | undefined;
  readonly callbackUrl: string | undefined;
  readonly logLevel: string | undefined;
}

/** Treat blank values and `.env.example` placeholders as not configured. */
function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }

  const value = raw.trim();
  if (value === '' || value.startsWith(PLACEHOLDER_PREFIX)) {
    return undefined;
  }

  return value;
}

/** Read the environment lazily on every call so current values are always used. */
export function getBotConfig(): BotConfig {
  return {
    token: readEnv('DISCORD_TOKEN'),
    clientId: readEnv('DISCORD_CLIENT_ID'),
    guildId: readEnv('DISCORD_GUILD_ID'),
    callbackUrl: readEnv('DISCORD_CALLBACK_URL'),
    logLevel: readEnv('LOG_LEVEL'),
  };
}

/** True when the minimum configuration required to start the bot is present. */
export function isBotConfigured(): boolean {
  return getBotConfig().token !== undefined;
}
