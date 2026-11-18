/** Discord embeds for the BrawlHub membership command group. */

import { EmbedBuilder } from 'discord.js';
import type { BotConfig } from '../config';
import { escapeMarkdown, formatClubLink, formatInteger, formatPlayerLink, cleanTag } from '../discord/format';
import type { Page } from '../discord/pagination';
import { fitEmbedToDiscordLimits, formatAbsoluteTime } from '../clubs/embed';
import { statusLabel } from '../players/embed';
import type { MemberListView, MemberSearchView, TrackedMemberRecord } from './types';

const EMBED_COLOR = 0x5865_f2;

type MemberEmbedConfig = Pick<
  BotConfig,
  'playerProfileUrlTemplate' | 'clubProfileUrlTemplate'
>;

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function footer(page: Page<unknown>, label: string): string {
  return `${label} • Page ${page.page} / ${page.pageCount} • Showing ${page.start}–${page.end} of ${page.total}`;
}

function membershipValue(record: TrackedMemberRecord, config: MemberEmbedConfig): string {
  const lines = [
    `Club: ${formatClubLink(record.club.name, record.club.tag, config.clubProfileUrlTemplate)} (#${cleanTag(record.club.tag)})`,
    `Status: ${statusLabel(record.status)}`,
  ];
  const trophies = formatInteger(record.trophies);
  if (trophies !== null) lines.push(`Trophies: ${trophies}`);
  if (record.club.role !== null) lines.push(`Role: ${escapeMarkdown(record.club.role)}`);
  if (record.club.validFrom !== null) {
    lines.push(`Joined: ${formatAbsoluteTime(record.club.validFrom) ?? record.club.validFrom}`);
  }
  if (record.club.validTo !== null) {
    lines.push(`Left: ${formatAbsoluteTime(record.club.validTo) ?? record.club.validTo}`);
  }
  return truncate(lines.join('\n'), 1024);
}

/** Build the paginated `/members` embed. */
export function buildMembersPageEmbed(
  view: MemberListView,
  page: Page<TrackedMemberRecord>,
  config: MemberEmbedConfig,
): EmbedBuilder {
  const title = view.club === null
    ? 'Tracked Members'
    : `${escapeMarkdown(view.club.name)} • #${cleanTag(view.club.tag)} — Members`;
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(title, 256))
    .setFooter({ text: truncate(footer(page, 'Stored memberships'), 2048) });

  embed.setDescription(
    truncate(
      `Current: ${view.currentCount} • Historical/unverified: ${view.historicalCount}\n` +
        'Current means confirmed by a recent synchronisation. All other rows are shown as historical or incomplete.',
      2048,
    ),
  );

  if (page.items.length === 0) {
    embed.addFields({
      name: 'Members',
      value: view.records.length === 0
        ? 'No stored membership records match this view.'
        : 'No members on this page.',
    });
    return fitEmbedToDiscordLimits(embed);
  }

  page.items.forEach((record, index) => {
    embed.addFields({
      name: truncate(
        `${page.start + index}. ${formatPlayerLink(record.playerName, record.playerTag, config.playerProfileUrlTemplate)} (#${cleanTag(record.playerTag)})`,
        256,
      ),
      value: membershipValue(record, config),
    });
  });

  return fitEmbedToDiscordLimits(embed);
}

/** Build the paginated `/member-search` embed. */
export function buildMemberSearchPageEmbed(
  view: MemberSearchView,
  page: Page<MemberSearchView['entries'][number]>,
  config: MemberEmbedConfig,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(view.identityContext ? 'Linked Discord Players' : 'Tracked Player Search')
    .setFooter({ text: truncate(footer(page, 'Search results'), 2048) });

  embed.setDescription(
    truncate(
      view.identityContext
        ? `Discord ID: ${view.query}\nOnly stored, trusted identity links are shown. No ownership is inferred from names, tags or roles.`
        : `Query: ${escapeMarkdown(view.query)}`,
      2048,
    ),
  );

  if (page.items.length === 0) {
    embed.addFields({
      name: 'Results',
      value: 'No tracked players matched this search.',
    });
    return fitEmbedToDiscordLimits(embed);
  }

  page.items.forEach((player, index) => {
    const club = player.currentClub;
    const lines = [
      `Trophies: ${formatInteger(player.trophies) ?? '—'}`,
      club === null
        ? 'Current club: No stored current membership'
        : `Current club: ${formatClubLink(club.name, club.tag, config.clubProfileUrlTemplate)} (#${cleanTag(club.tag)})`,
    ];
    embed.addFields({
      name: truncate(
        `${page.start + index}. ${formatPlayerLink(player.playerName, player.playerTag, config.playerProfileUrlTemplate)} (#${cleanTag(player.playerTag)})`,
        256,
      ),
      value: truncate(lines.join('\n'), 1024),
    });
  });

  return fitEmbedToDiscordLimits(embed);
}
