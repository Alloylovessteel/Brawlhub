import { createTrustedClient } from '@brawlhub/database';
import { createLogger } from '@brawlhub/logging';
import type { SyncNotificationInput, SyncNotifier, SyncNotifierWithChannel } from '@brawlhub/sync';
import { REST, Routes } from 'discord.js';
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
    .replace(/<[@#&](?:!?\d+|everyone|here)>/gi, '')
    .replace(/[<@>`]/g, '')
    .trim();
  if (sanitized === '') {
    return 'unknown';
  }
  return sanitized.slice(0, maxLength);
}

function formatPlayer(input: SyncNotificationInput): string {
  const name = clean(input.playerName, 60);
  if (name !== 'unknown') return name;
  const tag = clean(input.playerTag, 24).replace(/^#+/, '');
  return tag === '' || tag === 'unknown' ? 'Unknown player' : `#${tag}`;
}

function formatClubName(value: string | undefined): string {
  const cleaned = clean(value, 80);
  return cleaned === 'unknown' ? 'the club' : cleaned;
}

function formatAction(input: SyncNotificationInput): string {
  const clubName = formatClubName(input.clubName);
  switch (input.eventType) {
    case 'join':
      return `joined ${clubName}`;
    case 'leave':
      return `left ${clubName}`;
    case 'transfer':
      return `transferred from ${formatClubName(input.fromClubName)} to ${formatClubName(input.toClubName)}`;
    default:
      return 'updated club membership';
  }
}

/** Build the public, mention-safe plain-text membership notice. */
export function buildClubMembershipNoticeContent(input: SyncNotificationInput): string {
  return `${formatPlayer(input)} ${formatAction(input)}`;
}

function readFallbackChannelId(): string | undefined {
  const raw = process.env.DISCORD_NOTIFICATION_CHANNEL_ID?.trim();
  if (raw === undefined || raw === '' || raw.startsWith('your-')) {
    return undefined;
  }
  return raw;
}

/**
 * A notifier that intentionally sends nothing. `undefined` means "not sent":
 * sync must leave the event retryable rather than recording a delivery.
 */
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
        const content = buildClubMembershipNoticeContent(input);
        const message = (await rest.post(Routes.channelMessages(channelId), {
          body: {
            content,
            allowed_mentions: { parse: [] },
          },
        })) as { id?: string } | undefined;
        return message?.id;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to send Discord sync notification', {
          error: message.includes(token) ? message.split(token).join(REDACTED) : message,
        });
        // Returning undefined means "not sent"; sync keeps the claim retryable.
        return undefined;
      }
    },
  };
}
