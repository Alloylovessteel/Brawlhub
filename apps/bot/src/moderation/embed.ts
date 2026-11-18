import { EmbedBuilder } from 'discord.js';
import { fitEmbedToDiscordLimits } from '../clubs/embed';
import type { BotConfig } from '../config';
import { escapeMarkdown, formatPlayerLink } from '../discord/format';
import type { Page } from '../discord/pagination';
import type {
  AddBlacklistResult,
  BlacklistEntry,
  BlacklistListView,
  BlacklistTarget,
  RemoveBlacklistResult,
} from './types';

const EMBED_COLOR = 0x5865_f2;

type EmbedConfig = Pick<BotConfig, 'playerProfileUrlTemplate'>;

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function timestamp(value: string | Date | null | undefined, style: 'F' | 'R'): string {
  if (value === null || value === undefined) return '—';
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(milliseconds)) return '—';
  return `<t:${Math.floor(milliseconds / 1000)}:${style}>`;
}

function displayTag(tag: string | null): string {
  return tag === null || tag === '' ? 'no tag' : `#${tag.replace(/^#+/, '')}`;
}

function plainPlayer(player: BlacklistTarget): string {
  return `**${escapeMarkdown(player.name)}** (${displayTag(player.tag)})`;
}

function linkedPlayer(entry: BlacklistEntry, config: EmbedConfig): string {
  if (entry.playerName === null) return 'Unknown player';
  const name = formatPlayerLink(entry.playerName, entry.playerTag ?? '', config.playerProfileUrlTemplate);
  return `${name} (${displayTag(entry.playerTag)})`;
}

function staffLabel(discordUserId: string | null): string {
  return discordUserId === null ? 'Unknown staff' : `<@${discordUserId}>`;
}

function entryLine(entry: BlacklistEntry, config: EmbedConfig): string {
  const reason = truncate(escapeMarkdown(entry.reason), 300);
  const created = timestamp(entry.createdAt, 'F');
  return `${linkedPlayer(entry, config)}\nReason: ${reason}\nStaff: ${staffLabel(entry.createdByDiscordId)} • Added: ${created}`;
}

export function buildBlacklistListEmbed(
  view: BlacklistListView,
  page: Page<BlacklistEntry>,
  config: EmbedConfig,
  now: Date = new Date(),
): EmbedBuilder {
  const lines = page.items.map((entry) => entryLine(entry, config));
  const description =
    lines.length === 0
      ? 'No active blacklists.'
      : lines.join('\n\n');

  return fitEmbedToDiscordLimits(
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('Active blacklists')
      .setDescription(truncate(description, 4000))
      .addFields({
        name: 'Page',
        value: `${page.start}–${page.end} of ${page.total} (page ${page.page}/${page.pageCount})`,
      })
      .setTimestamp(now)
      .setFooter({
        text: `Active entries only • Generated ${timestamp(view.generatedAt, 'R')}`,
      }),
  );
}

export function buildBlacklistAddConfirmationEmbed(
  player: BlacklistTarget,
  reason: string,
  actorDiscordId: string,
  now: Date = new Date(),
): EmbedBuilder {
  return fitEmbedToDiscordLimits(
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('Confirm blacklist addition')
      .setDescription(
        '⚠️ Ephemeral preview — this action is **not applied until Confirm** is pressed. ' +
          'No blacklist entry has been created yet.',
      )
      .addFields(
        { name: 'Player', value: truncate(plainPlayer(player), 1024) },
        { name: 'Reason', value: truncate(escapeMarkdown(reason), 1024) },
        { name: 'Requested by', value: staffLabel(actorDiscordId) },
        { name: 'Previewed at', value: timestamp(now, 'F') },
      )
      .setTimestamp(now)
      .setFooter({ text: 'Ephemeral preview • Nothing is saved until you press Confirm' }),
  );
}

export function buildBlacklistAddedEmbed(
  result: AddBlacklistResult,
  actorDiscordId: string,
  now: Date = new Date(),
): EmbedBuilder {
  return fitEmbedToDiscordLimits(
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('Player blacklisted')
      .setDescription(`${plainPlayer(result.player)} was added to the active blacklist.`)
      .addFields(
        { name: 'Reason', value: truncate(escapeMarkdown(result.reason), 1024) },
        { name: 'Added by', value: staffLabel(actorDiscordId) },
        { name: 'Created', value: timestamp(result.createdAt, 'F') },
        { name: 'Entry ID', value: `\`${result.id}\`` },
      )
      .setTimestamp(now),
  );
}

export function buildBlacklistRemovedEmbed(
  result: RemoveBlacklistResult,
  now: Date = new Date(),
): EmbedBuilder {
  return fitEmbedToDiscordLimits(
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('Blacklist entry removed')
      .setDescription('The entry is no longer active. Its original details are kept for audit history.')
      .addFields(
        { name: 'Entry ID', value: `\`${result.id}\`` },
        { name: 'Removed', value: timestamp(result.removedAt, 'F') },
      )
      .setTimestamp(now)
      .setFooter({ text: 'The removal was recorded in the audit log.' }),
  );
}
