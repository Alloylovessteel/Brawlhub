import { EmbedBuilder } from 'discord.js';
import type { BotConfig } from '../config';
import {
  cleanTag,
  escapeMarkdown,
  formatEmoji,
  formatInteger,
  formatPlayerLink,
} from '../discord/format';
import { paginate, type Page } from '../discord/pagination';
import { calculateAverage, calculateTrophyProgression, calculateTrophyRange, countRole } from './calculate';
import type { ClubSummary, ClubView, RosterMember } from './types';

export const CLUB_MEMBER_CAPACITY = 30;
const EMBED_COLOR = 0x5865_f2;

type EmbedConfig = Pick<
  BotConfig,
  'emojis' | 'playerProfileUrlTemplate' | 'seasonStartIso'
>;

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function displayTag(tag: string): string {
  return `#${cleanTag(tag)}`;
}

function label(emoji: string, text: string): string {
  return `${emoji}${text}`;
}

function formatDelta(value: number): string {
  const formatted = formatInteger(value) ?? '0';
  return value > 0 ? `+${formatted}` : formatted;
}

/** Discord relative timestamp for a stored ISO value. */
export function formatSyncTime(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return null;
  return `<t:${Math.floor(milliseconds / 1000)}:R>`;
}

function president(roster: readonly RosterMember[]): RosterMember | null {
  return roster.find((member) => member.role === 'president' && member.name !== '') ?? null;
}

function progressionLines(view: ClubView, config: EmbedConfig, now: Date): string[] {
  const progression = calculateTrophyProgression({
    snapshots: view.snapshots,
    currentTrophies: view.currentTrophies,
    currentAt: view.currentAt,
    now,
    seasonStartIso: config.seasonStartIso,
  });

  const lines: string[] = [];
  if (progression.today !== null) lines.push(`Today: ${formatDelta(progression.today)}`);
  if (progression.week !== null) lines.push(`Week: ${formatDelta(progression.week)}`);
  if (progression.season !== null) lines.push(`Season: ${formatDelta(progression.season)}`);
  return lines;
}

/** Build the detailed `/club` embed in the required section order. */
export function buildClubEmbed(
  view: ClubView,
  config: EmbedConfig,
  now: Date = new Date(),
): EmbedBuilder {
  const emoji = {
    trophies: formatEmoji(config.emojis.trophies, 'trophies'),
    trophyRange: formatEmoji(config.emojis.trophyRange, 'trophy_range'),
    president: formatEmoji(config.emojis.president, 'president'),
    requiredTrophies: formatEmoji(config.emojis.requiredTrophies, 'required_trophies'),
    members: formatEmoji(config.emojis.members, 'members'),
    progression: formatEmoji(config.emojis.progression, 'progression'),
    description: formatEmoji(config.emojis.description, 'description'),
  };

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(`${escapeMarkdown(view.club.name)} • ${displayTag(view.club.tag)}`, 256))
    .setTimestamp(now);

  const total = formatInteger(view.currentTrophies);
  const average = view.rosterAvailable
    ? formatInteger(calculateAverage(view.roster.map((member) => member.trophies)))
    : null;
  if (total !== null || average !== null) {
    const lines: string[] = [];
    if (total !== null) lines.push(`Total: ${total}`);
    if (average !== null) lines.push(`Average: ${average}`);
    embed.addFields({ name: label(emoji.trophies, 'Trophies'), value: truncate(lines.join('\n'), 1024) });
  }

  const range = view.rosterAvailable ? calculateTrophyRange(view.roster) : null;
  if (range !== null) {
    embed.addFields({
      name: label(emoji.trophyRange, 'Trophy Range'),
      value: truncate(`Lowest: ${formatInteger(range.low)}\nHighest: ${formatInteger(range.high)}`, 1024),
    });
  }

  const leader = view.rosterAvailable ? president(view.roster) : null;
  if (leader !== null) {
    embed.addFields({
      name: label(emoji.president, 'President'),
      value: truncate(
        formatPlayerLink(leader.name, leader.tag, config.playerProfileUrlTemplate),
        1024,
      ),
    });
  }

  const required = formatInteger(view.requiredTrophies);
  if (required !== null) {
    embed.addFields({
      name: label(emoji.requiredTrophies, 'Required Trophies'),
      value: required,
    });
  }

  if (view.rosterAvailable) {
    const lines = [`Current: ${view.roster.length} / ${CLUB_MEMBER_CAPACITY}`];
    const vicePresidents = countRole(view.roster, 'vicePresident');
    const seniors = countRole(view.roster, 'senior');
    if (vicePresidents !== null) lines.push(`Vice-Presidents: ${vicePresidents}`);
    if (seniors !== null) lines.push(`Seniors: ${seniors}`);
    embed.addFields({ name: label(emoji.members, 'Members'), value: truncate(lines.join('\n'), 1024) });
  }

  // Average Matches Played and Mega Pig Rank are omitted until reliable data exists.

  const progression = progressionLines(view, config, now);
  if (progression.length > 0) {
    embed.addFields({
      name: label(emoji.progression, 'Trophy Progression'),
      value: truncate(progression.join('\n'), 1024),
    });
  }

  const description = view.description?.trim();
  if (description !== undefined && description !== '') {
    embed.addFields({
      name: label(emoji.description, 'Description'),
      value: truncate(escapeMarkdown(description), 1024),
    });
  }

  const footer: string[] = [
    view.liveStatus === 'live' ? 'Live official API data' : 'Latest synced data',
  ];
  const syncedAt = formatSyncTime(view.latestSyncAt);
  if (syncedAt !== null) footer.push(`Synced ${syncedAt}`);
  embed.setFooter({ text: truncate(footer.join(' • '), 2048) });

  return embed;
}

/** Build a compact, paginated `/clubs` embed. */
export function buildClubsPageEmbed(
  summaries: readonly ClubSummary[],
  page: Page<ClubSummary>,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('Registered Clubs')
    .setFooter({
      text: `Page ${page.page} / ${page.pageCount} • Showing ${page.start}–${page.end} of ${page.total}`,
    });

  if (page.items.length === 0) {
    embed.setDescription('No clubs are registered with BrawlHub yet.');
    return embed;
  }

  page.items.forEach((summary, index) => {
    const average = formatInteger(summary.averageTrophies);
    const members = formatInteger(summary.memberCount);
    const syncedAt = formatSyncTime(summary.latestSyncAt) ?? 'Not yet synced';
    const lines = [`Total: ${formatInteger(summary.totalTrophies) ?? '—'}`];
    if (average !== null) lines.push(`Average: ${average}`);
    if (members !== null) lines.push(`Members: ${members} / ${CLUB_MEMBER_CAPACITY}`);
    lines.push(`Last sync: ${syncedAt}`);

    embed.addFields({
      name: truncate(`${page.start + index}. ${escapeMarkdown(summary.club.name)} • ${displayTag(summary.club.tag)}`, 256),
      value: truncate(lines.join('\n'), 1024),
    });
  });

  return embed;
}

export function paginateClubs(
  summaries: readonly ClubSummary[],
  page: number,
  pageSize = 5,
): Page<ClubSummary> {
  return paginate(summaries, page, pageSize);
}
