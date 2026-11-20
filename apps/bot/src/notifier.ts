import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import type { SyncNotifier, SyncNotifierWithChannel } from '@brawlhub/sync';
import { EmbedBuilder, REST, Routes } from 'discord.js';
import { getBotConfig } from './config.js';

const logger = createLogger('bot/notifier');
const REDACTED = '[REDACTED]';

/** Strip newlines and mention syntax so API-provided names cannot inject Discord pings. */
function clean(value: string | undefined, maxLength: number): string {
  if (value === undefined) {
    return 'unknown';
  }
  const sanitized = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<@>`]/g, '')
    .trim();
  if (sanitized === '') {
    return 'unknown';
  }
  return sanitized.slice(0, maxLength);
}

function formatEmbed(input: Parameters<SyncNotifier['send']>[0]): EmbedBuilder {
  const player = `${clean(input.playerName, 60)} (${clean(input.playerTag, 24)})`;
  const embed = new EmbedBuilder().setColor(0x5865_f2).setTitle('Club membership update');

  switch (input.eventType) {
    case 'join':
      return embed.setDescription(`${player} joined **${clean(input.clubName, 60)}**.`);
    case 'leave':
      return embed.setDescription(`${player} left **${clean(input.clubName, 60)}**.`);
    case 'transfer':
      return embed.setDescription(
        `${player} transferred from **${clean(input.fromClubName, 60)}** to **${clean(input.toClubName, 60)}**.`,
      );
  }
}

function readFallbackChannelId(): string | undefined {
  const raw = process.env.DISCORD_NOTIFICATION_CHANNEL_ID?.trim();
  if (raw === undefined || raw === '' || raw.startsWith('your-')) {
    return undefined;
  }
  return raw;
}

/** A notifier that intentionally sends nothing, allowing sync to clear its claim. */
const SKIP_NOTIFIER: SyncNotifier = {
  async send() {
    return undefined;
  },
};

async function readGuildAnnouncementChannelId(guildId: string): Promise<string | undefined> {
  try {
    const db = createTrustedClient();
    const { data, error } = await db
      .from('guild_settings')
      .select('announcement_channel_id')
      .eq('guild_id', guildId)
      .maybeSingle();
    if (error) return undefined;
    const value =
      data !== null &&
      typeof data === 'object' &&
      data !== null &&
      typeof (data as { announcement_channel_id?: unknown }).announcement_channel_id === 'string'
        ? ((data as { announcement_channel_id: string }).announcement_channel_id.trim() || undefined)
        : undefined;
    return value;
  } catch {
    return undefined;
  }
}

export interface DiscordNotifierOptions {
  readonly guildId?: string | null;
}

/**
 * Creates the notifier passed to runSync(). Missing channel configuration (or a
 * missing bot token) disables notifications instead of failing the sync run.
 * When guildId is provided, the guild's configured announcement channel is used.
 */
export async function createDiscordNotifier(
  options: DiscordNotifierOptions = {},
): Promise<SyncNotifierWithChannel> {
  const guildId = options.guildId?.trim();
  const channelId =
    (guildId && guildId.length > 0 ? await readGuildAnnouncementChannelId(guildId) : undefined) ??
    readFallbackChannelId();
  if (channelId === undefined) {
    return SKIP_NOTIFIER;
  }

  const token = getBotConfig().token;
  if (token === undefined) {
    logger.warn(
      'Discord notification channel is configured but DISCORD_TOKEN is missing; notifications are disabled.'
    );
    return SKIP_NOTIFIER;
  }

  const rest = new REST({ version: '10' }).setToken(token);

  return {
    channelId,
    async send(input) {
      try {
        const embed = formatEmbed(input);
        const message = (await rest.post(Routes.channelMessages(channelId), {
          body: { embeds: [embed.toJSON()] },
        })) as { id?: string } | undefined;
        return message?.id;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to send Discord sync notification', {
          error: message.includes(token) ? message.split(token).join(REDACTED) : message,
        });
        // Returning undefined lets sync delete its notification claim.
        return undefined;
      }
    },
  };
}
