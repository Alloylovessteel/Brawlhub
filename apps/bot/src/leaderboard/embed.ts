import { EmbedBuilder } from 'discord.js';
import type { BotConfig } from '../config';
import {
  fitEmbedToDiscordLimits,
  formatAbsoluteTime,
  formatSyncTime,
} from '../clubs/embed';
import {
  cleanTag,
  formatClubLink,
  formatEmoji,
  formatInteger,
  formatPlayerLink,
} from '../discord/format';
import type { Page } from '../discord/pagination';
import type { ClubMembershipStatus, PlayerClubRef, PlayerIdentity } from '../players/types';
import type {
  ClubLeaderboardView,
  PlayerLeaderboardView,
  ProgressionLeaderboardView,
  ProgressionPeriod,
  RankedRow,
  TrophyLeaderboardView,
} from './types';

const EMBED_COLOR = 0x5865_f2;

const PERIOD_LABELS: Readonly<Record<ProgressionPeriod, string>> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};

const MEMBERSHIP_LABELS: Readonly<Record<ClubMembershipStatus, string>> = {
  current: 'Current',
  'last-recorded': 'Last recorded',
  past: 'Previous',
  incomplete: 'Incomplete',
};

type LeaderboardEmbedConfig = Pick<
  BotConfig,
  'emojis' | 'playerProfileUrlTemplate' | 'clubProfileUrlTemplate'
>;

interface LeaderboardMeta {
  readonly generatedAt: string;
  readonly latestSyncAt: string | null;
  readonly warning: string | null;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function displayTag(tag: string): string {
  return `#${cleanTag(tag)}`;
}

function formatDelta(value: number): string {
  const formatted = formatInteger(value) ?? '0';
  return value > 0 ? `+${formatted}` : formatted;
}

function playerLabel(player: PlayerIdentity, config: LeaderboardEmbedConfig): string {
  return `${formatPlayerLink(player.name, player.tag, config.playerProfileUrlTemplate)} (${displayTag(player.tag)})`;
}

function clubLabel(club: PlayerClubRef, config: LeaderboardEmbedConfig): string {
  return `${formatClubLink(club.name, club.tag, config.clubProfileUrlTemplate)} (${displayTag(club.tag)})`;
}

function clubLine(
  club: PlayerClubRef | null,
  status: ClubMembershipStatus | null,
  config: LeaderboardEmbedConfig,
): string {
  if (club === null) return 'Club: Unavailable';
  const label = status === null ? '' : ` — ${MEMBERSHIP_LABELS[status]}`;
  return `Club: ${clubLabel(club, config)}${label}`;
}

function sharedSuffix(rows: readonly RankedRow[], index: number): string {
  const row = rows[index];
  if (row === undefined) return '';
  const previous = rows[index - 1];
  const next = rows[index + 1];
  return previous?.rank === row.rank || next?.rank === row.rank ? ' (shared)' : '';
}

function withWarning(description: string, warning: string | null): string {
  return warning === null ? description : `${description} ${warning}`;
}

function baseEmbed(
  title: string,
  description: string,
  meta: LeaderboardMeta,
  page: Page<unknown>,
  category: string,
): EmbedBuilder {
  const latestSync = formatSyncTime(meta.latestSyncAt);
  const generated = formatSyncTime(meta.generatedAt);
  const footer = [
    category,
    `Page ${page.page} / ${page.pageCount}`,
    `Showing ${page.start}–${page.end} of ${page.total}`,
    latestSync === null ? null : `Latest sync: ${latestSync}`,
    generated === null ? null : `Generated: ${generated}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' • ');

  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(title, 256))
    .setDescription(truncate(description, 2048))
    .setFooter({ text: truncate(footer, 2048) });
}

/** Build the `/leaderboard clubs` page. */
export function buildClubLeaderboardPageEmbed(
  view: ClubLeaderboardView,
  page: Page<ClubLeaderboardView['rows'][number]>,
  config: LeaderboardEmbedConfig,
): EmbedBuilder {
  const embed = baseEmbed(
    'Global Club Leaderboard',
    withWarning(
      'Ranked by total trophies from the latest valid completed synchronisation.',
      view.warning,
    ),
    view,
    page,
    'Clubs',
  );

  if (page.items.length === 0) {
    embed.addFields({
      name: 'No ranked clubs',
      value: 'No registered club has a valid completed snapshot with trophies yet.',
    });
    return fitEmbedToDiscordLimits(embed);
  }

  page.items.forEach((row, index) => {
    const globalIndex = page.start + index;
    embed.addFields({
      name: truncate(
        `${globalIndex}. ${row.rank}. ${formatClubLink(row.club.name, row.club.tag, config.clubProfileUrlTemplate)} (${displayTag(row.club.tag)})${sharedSuffix(view.rows, globalIndex - 1)}`,
        256,
      ),
      value: truncate(
        [
          `Total trophies: ${formatInteger(row.totalTrophies) ?? '0'}`,
          `Members: ${formatInteger(row.memberCount) ?? 'Unavailable'}`,
          `Average trophies: ${formatInteger(row.averageTrophies) ?? 'Unavailable'}`,
          `Snapshot: ${formatAbsoluteTime(row.snapshotAt) ?? row.snapshotAt}`,
        ].join('\n'),
        1024,
      ),
    });
  });

  return fitEmbedToDiscordLimits(embed);
}

/** Build the `/leaderboard players` page. */
export function buildPlayerLeaderboardPageEmbed(
  view: PlayerLeaderboardView,
  page: Page<PlayerLeaderboardView['rows'][number]>,
  config: LeaderboardEmbedConfig,
): EmbedBuilder {
  const embed = baseEmbed(
    'Global Player Leaderboard — Current Trophies',
    withWarning('Ranked by stored current trophies across tracked players.', view.warning),
    view,
    page,
    'Players',
  );

  if (page.items.length === 0) {
    embed.addFields({
      name: 'No ranked players',
      value: 'No tracked player has valid stored trophy data yet.',
    });
    return fitEmbedToDiscordLimits(embed);
  }

  page.items.forEach((row, index) => {
    const globalIndex = page.start + index;
    embed.addFields({
      name: truncate(
        `${globalIndex}. ${row.rank}. ${playerLabel(row.player, config)}${sharedSuffix(view.rows, globalIndex - 1)}`,
        256,
      ),
      value: truncate(
        [
          `${formatEmoji(config.emojis.trophies, 'trophies')}Trophies: ${formatInteger(row.trophies) ?? '0'}`.trim(),
          clubLine(row.club, row.clubStatus, config),
          `Synced: ${formatSyncTime(row.player.lastSyncedAt) ?? 'unknown'}`,
        ].join('\n'),
        1024,
      ),
    });
  });

  return fitEmbedToDiscordLimits(embed);
}

/** Build the `/leaderboard trophies` page. */
export function buildTrophyLeaderboardPageEmbed(
  view: TrophyLeaderboardView,
  page: Page<TrophyLeaderboardView['rows'][number]>,
  config: LeaderboardEmbedConfig,
): EmbedBuilder {
  const embed = baseEmbed(
    'Global Player Leaderboard — Recorded Personal Bests',
    withWarning(
      'Ranked by recorded personal-best trophies. Current trophies are shown separately and do not affect the ranking.',
      view.warning,
    ),
    view,
    page,
    'Trophies',
  );

  if (page.items.length === 0) {
    embed.addFields({
      name: 'No ranked players',
      value: 'No tracked player has a recorded personal-best trophy value.',
    });
    return fitEmbedToDiscordLimits(embed);
  }

  page.items.forEach((row, index) => {
    const globalIndex = page.start + index;
    embed.addFields({
      name: truncate(
        `${globalIndex}. ${row.rank}. ${playerLabel(row.player, config)}${sharedSuffix(view.rows, globalIndex - 1)}`,
        256,
      ),
      value: truncate(
        [
          `Personal best: ${formatInteger(row.highestTrophies) ?? '0'}`,
          `Current trophies: ${formatInteger(row.currentTrophies) ?? 'Unavailable'}`,
          clubLine(row.club, row.clubStatus, config),
        ].join('\n'),
        1024,
      ),
    });
  });

  return fitEmbedToDiscordLimits(embed);
}

/** Build the `/leaderboard progression` page. */
export function buildProgressionLeaderboardPageEmbed(
  view: ProgressionLeaderboardView,
  page: Page<ProgressionLeaderboardView['rows'][number]>,
  config: LeaderboardEmbedConfig,
): EmbedBuilder {
  const embed = baseEmbed(
    `Global Progression Leaderboard — ${PERIOD_LABELS[view.period]}`,
    withWarning(
      `Ranked by trophy gains between actual stored snapshots in ${PERIOD_LABELS[view.period].toLowerCase()}. Missing snapshots are never estimated.`,
      view.warning,
    ),
    view,
    page,
    'Progression',
  );

  if (page.items.length === 0) {
    embed.addFields({
      name: 'Insufficient progression history',
      value: `No player has at least two valid stored snapshots in ${PERIOD_LABELS[view.period].toLowerCase()}.`,
    });
    return fitEmbedToDiscordLimits(embed);
  }

  page.items.forEach((row, index) => {
    const globalIndex = page.start + index;
    embed.addFields({
      name: truncate(
        `${globalIndex}. ${row.rank}. ${playerLabel(row.player, config)}${sharedSuffix(view.rows, globalIndex - 1)}`,
        256,
      ),
      value: truncate(
        [
          `Gain: ${formatDelta(row.difference)}`,
          `Start: ${formatInteger(row.startTrophies) ?? '0'} (${formatAbsoluteTime(row.startAt) ?? row.startAt})`,
          `Latest: ${formatInteger(row.latestTrophies) ?? '0'} (${formatAbsoluteTime(row.latestAt) ?? row.latestAt})`,
          clubLine(row.club, row.clubStatus, config),
        ].join('\n'),
        1024,
      ),
    });
  });

  return fitEmbedToDiscordLimits(embed);
}
