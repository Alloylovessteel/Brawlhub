import { createLogger } from '@brawlhub/logging';
import type { SyncResult } from '@brawlhub/sync';
import { EmbedBuilder, REST, Routes } from 'discord.js';
import { loadGuildSettings } from './admin/service.js';
import type { GuildSettingsView } from './admin/types.js';
import { getBotConfig } from './config.js';

const logger = createLogger('bot/operator');
const REDACTED = '[REDACTED]';
const EMBED_COLOR = 0x5865_f2;
const SNOWFLAKE = /^\d{17,20}$/;

type NoticePurpose = 'sync' | 'verification';
type SettingsLoader = (guildId: string) => Promise<GuildSettingsView>;

export interface OperatorNotifierOptions {
  /** Defaults to the configured Discord bot token. */
  readonly token?: string;
  /** Injectable for tests; always called with the notice's guild ID. */
  readonly loadSettings?: SettingsLoader;
}

export interface OperatorVerificationNotice {
  readonly guildId: string;
  readonly playerName: string | null;
  readonly playerTag: string;
  readonly discordUserId: string;
  readonly method: 'icon-verified' | 'staff-linked';
}

/** Strip mention/newline syntax from API or staff-provided text. */
function clean(value: string | null | undefined, maxLength: number, fallback = 'unknown'): string {
  const sanitized = (value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/<[@#&](?:!?\d+|everyone|here)>/gi, '')
    .replace(/[<@>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (sanitized === '') return fallback;
  const characters = Array.from(sanitized);
  return characters.length <= maxLength ? sanitized : `${characters.slice(0, maxLength - 1).join('')}…`;
}

function safeError(error: unknown, token: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(token) ? message.split(token).join(REDACTED) : message;
}

function discordUserId(value: string | null | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate !== undefined && SNOWFLAKE.test(candidate) ? candidate : undefined;
}

async function resolveChannelId(
  guildId: string,
  purpose: NoticePurpose,
  loadSettings: SettingsLoader,
): Promise<string | undefined> {
  const parsedGuildId = discordUserId(guildId);
  if (parsedGuildId === undefined) return undefined;
  try {
    const settings = await loadSettings(parsedGuildId);
    const announcement = discordUserId(settings.announcementChannelId);
    const verification = discordUserId(settings.verificationChannelId);
    const channelId =
      purpose === 'verification'
        ? verification ?? announcement
        : announcement ?? verification;
    return channelId;
  } catch (error) {
    logger.warn('Could not load guild settings for operator notice', {
      guildId: parsedGuildId,
      error: error instanceof Error ? error.message : 'unknown error',
    });
    return undefined;
  }
}

export function buildSyncOperatorEmbed(result: SyncResult): EmbedBuilder {
  const failures = result.memberFailures ?? [];
  const expected = result.membersExpected;
  const succeeded = result.membersSucceeded;
  const hasMemberFailures =
    failures.length > 0 || (expected !== undefined && succeeded !== undefined && succeeded < expected);
  const title =
    result.status === 'failed'
      ? 'Synchronization failed'
      : hasMemberFailures
        ? 'Member synchronization failed'
        : 'Sync completed';

  const embed = new EmbedBuilder().setColor(EMBED_COLOR).setTitle(title);

  if (result.status === 'failed') {
    const token = getBotConfig().token;
    const error =
      token !== undefined && result.error !== undefined && result.error.includes(token)
        ? result.error.split(token).join(REDACTED)
        : result.error;
    embed.setDescription(`Sync failed. ${clean(error, 900, 'No error details supplied.')}`);
  } else if (expected !== undefined && succeeded !== undefined) {
    embed.setDescription(
      hasMemberFailures
        ? `Sync completed. Successfully synced Members: ${succeeded}/${expected}.`
        : `Sync completed. Successfully synced Members: ${succeeded}/${expected}.`,
    );
  } else {
    embed.setDescription('Sync completed.');
  }

  embed.addFields(
    { name: 'Run', value: clean(result.syncRunId || 'not-started', 96), inline: true },
    { name: 'Clubs', value: String(result.clubsProcessed), inline: true },
    { name: 'Snapshots', value: String(result.snapshotsWritten), inline: true },
    { name: 'Membership events', value: String(result.membershipEvents), inline: true },
    { name: 'Notifications', value: String(result.notificationsSent), inline: true },
  );

  if (hasMemberFailures) {
    const lines = failures
      .slice(0, 8)
      .map((failure) => `#${clean(failure.tag, 16)} — ${clean(failure.reason, 90)}`);
    if (failures.length > 8) {
      lines.push(`+${failures.length - 8} more member(s) failed.`);
    }
    embed.addFields({
      name: 'Failed members',
      value: lines.length > 0 ? lines.join('\n') : 'Member profile data was incomplete.',
    });
  }

  embed.setFooter({ text: 'Guild-scoped operator notice • official Brawl Stars sync data' });
  return embed;
}

export function buildVerificationOperatorEmbed(input: OperatorVerificationNotice): EmbedBuilder {
  const player = `${clean(input.playerName, 60)} (#${clean(input.playerTag, 20)})`;
  const method = input.method === 'staff-linked' ? 'Staff-linked' : 'Icon-verified';
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('Verification completed')
    .setDescription(`${player} is now linked to Discord user ${clean(input.discordUserId, 24)}.`)
    .addFields(
      { name: 'Method', value: method, inline: true },
      { name: 'Player tag', value: clean(`#${input.playerTag}`, 20), inline: true },
    )
    .setFooter({ text: 'Guild-scoped operator notice • ownership confirmed without pings' });
}

async function postOperatorEmbed(
  guildId: string,
  purpose: NoticePurpose,
  embed: EmbedBuilder,
  options: OperatorNotifierOptions,
): Promise<string | undefined> {
  const token = options.token ?? getBotConfig().token;
  if (token === undefined) return undefined;
  const channelId = await resolveChannelId(
    guildId,
    purpose,
    options.loadSettings ?? ((id) => loadGuildSettings(id)),
  );
  if (channelId === undefined) return undefined;

  try {
    const rest = new REST({ version: '10' }).setToken(token);
    const message = (await rest.post(Routes.channelMessages(channelId), {
      body: {
        embeds: [embed.toJSON()],
        allowed_mentions: { parse: [] },
      },
    })) as { id?: string } | undefined;
    return message?.id;
  } catch (error) {
    logger.warn('Operator notice could not be posted', {
      guildId,
      channelId,
      error: safeError(error, token),
    });
    return undefined;
  }
}

/**
 * Post a guild-scoped operator summary for completed or failed syncs. Skipped
 * runs and results without a guild ID are intentionally silent.
 */
export async function notifySyncResult(
  result: SyncResult,
  options: OperatorNotifierOptions = {},
): Promise<string | undefined> {
  if (result.status === 'skipped') return undefined;
  const guildId = discordUserId(result.guildId);
  if (guildId === undefined) return undefined;
  return postOperatorEmbed(guildId, 'sync', buildSyncOperatorEmbed(result), options);
}

/** Post a guild-scoped, mention-safe verification completion notice. */
export async function notifyVerificationCompleted(
  input: OperatorVerificationNotice,
  options: OperatorNotifierOptions = {},
): Promise<string | undefined> {
  const guildId = discordUserId(input.guildId);
  if (guildId === undefined) return undefined;
  return postOperatorEmbed(guildId, 'verification', buildVerificationOperatorEmbed(input), options);
}
