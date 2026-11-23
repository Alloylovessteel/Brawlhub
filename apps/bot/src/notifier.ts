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
    .replace(/[<@>`]/g, '')
    .trim();
  if (sanitized === '') {
    return 'unknown';
  }
  return sanitized.slice(0, maxLength);
}

function formatPlayer(input: SyncNotificationInput): string {
  const name = clean(input.playerName, 60);
  const tag = clean(input.playerTag, 24).replace(/^#+/, '');
  return tag === '' || tag === 'unknown' ? name : `${name} (#${tag})`;
}

function formatOccurredAt(value: string | undefined): string {
  if (value === undefined) return 'an unknown time';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'an unknown time';
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(parsed);
  const date = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
  return `${time} UTC, ${date}`;
}

function formatRemainingMembers(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  return Math.trunc(value).toLocaleString('en-US');
}

function formatAction(input: SyncNotificationInput): string {
  switch (input.eventType) {
    case 'join':
      return 'joined the club';
    case 'leave':
      return 'left the club';
    case 'transfer':
      return `transferred from ${clean(input.fromClubName, 60)} to ${clean(input.toClubName, 60)}`;
    default:
      return 'updated club membership';
  }
}

/** Build the public, mention-safe plain-text membership notice. */
export function buildClubMembershipNoticeContent(input: SyncNotificationInput): string {
  return [
    `${formatPlayer(input)} ${formatAction(input)} at ${formatOccurredAt(input.occurredAt)}`,
    `remaining members: ${formatRemainingMembers(input.remainingMembers)}`,
  ].join('\n');
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
        // Returning undefined lets sync delete its notification claim.
        return undefined;
      }
    },
  };
}
