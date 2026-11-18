import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// Workspace scripts run with `apps/bot` as the cwd, so resolve from there to the monorepo root.
loadEnv({ path: resolve(process.cwd(), '../../.env') });

const PLACEHOLDER_PREFIX = 'your-';

/**
 * Bot-related environment values. Every field is `string | undefined` so callers
 * can decide how to handle missing configuration explicitly.
 */
export interface BotEmojiConfig {
  readonly trophies: string | undefined;
  readonly trophyRange: string | undefined;
  readonly president: string | undefined;
  readonly requiredTrophies: string | undefined;
  readonly members: string | undefined;
  readonly matches: string | undefined;
  readonly progression: string | undefined;
  readonly description: string | undefined;
}

export interface BotConfig {
  readonly token: string | undefined;
  readonly clientId: string | undefined;
  readonly guildId: string | undefined;
  readonly callbackUrl: string | undefined;
  readonly logLevel: string | undefined;
  /** Discord custom emoji IDs used in embeds. Names are generated at render time. */
  readonly emojis: BotEmojiConfig;
  /** Template for Brawl Stars player links. Must contain `{tag}`. */
  readonly playerProfileUrlTemplate: string | undefined;
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

/** Read an optional Discord snowflake, rejecting blank/placeholder values. */
function readSnowflakeEnv(name: string): string | undefined {
  const value = readEnv(name);
  return value !== undefined && /^\d{17,20}$/.test(value) ? value : undefined;
}

/** Read a URL template that must contain the `{tag}` placeholder. */
function readProfileTemplateEnv(): string | undefined {
  const value = readEnv('BRAWL_STARS_PROFILE_URL_TEMPLATE');
  if (value === undefined || !value.includes('{tag}')) {
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
    emojis: {
      trophies: readSnowflakeEnv('DISCORD_EMOJI_TROPHIES'),
      trophyRange: readSnowflakeEnv('DISCORD_EMOJI_TROPHY_RANGE'),
      president: readSnowflakeEnv('DISCORD_EMOJI_PRESIDENT'),
      requiredTrophies: readSnowflakeEnv('DISCORD_EMOJI_REQUIRED_TROPHIES'),
      members: readSnowflakeEnv('DISCORD_EMOJI_MEMBERS'),
      matches: readSnowflakeEnv('DISCORD_EMOJI_MATCHES'),
      progression: readSnowflakeEnv('DISCORD_EMOJI_PROGRESSION'),
      description: readSnowflakeEnv('DISCORD_EMOJI_DESCRIPTION'),
    },
    playerProfileUrlTemplate: readProfileTemplateEnv(),
  };
}

/** True when the minimum configuration required to start the bot is present. */
export function isBotConfigured(): boolean {
  return getBotConfig().token !== undefined;
}
