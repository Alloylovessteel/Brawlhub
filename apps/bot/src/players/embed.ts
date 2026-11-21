import { EmbedBuilder } from 'discord.js';
import type { BotConfig, BotEmojiConfig } from '../config';
import { formatAbsoluteTime, formatSyncTime, fitEmbedToDiscordLimits } from '../clubs/embed';
import type { HistoryPeriod } from '../clubs/types';
import {
  cleanTag,
  escapeMarkdown,
  formatClubLink,
  formatEmoji,
  formatInteger,
  formatPlayerLink,
} from '../discord/format';
import type { Page } from '../discord/pagination';
import type {
  BrawlerFilter,
  BrawlerSort,
  ClubMembershipStatus,
  PlayerBattleHistoryView,
  PlayerBattleRecord,
  PlayerBrawlerDetail,
  PlayerBrawlersView,
  PlayerClubRef,
  PlayerClubsView,
  PlayerComparisonView,
  PlayerHistoryView,
  PlayerHighlightsView,
  PlayerMembershipEvent,
  PlayerMembershipRecord,
  PlayerProfileView,
} from './types';

const EMBED_COLOR = 0x5865_f2;

/** Static asset URLs are optional presentation only; never fabricate one. */
function applyThumbnail(embed: EmbedBuilder, url: string | null | undefined): void {
  if (url !== null && url !== undefined && url !== '') embed.setThumbnail(url);
}

type PlayerEmbedConfig = Pick<
  BotConfig,
  | 'emojis'
  | 'playerProfileUrlTemplate'
  | 'clubProfileUrlTemplate'
  | 'seasonStartIso'
>;

const PERIOD_LABELS: Readonly<Record<HistoryPeriod, string>> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All available history',
};

export const BRAWLER_SORT_LABELS: Readonly<Record<BrawlerSort, string>> = {
  trophies: 'Current trophies',
  highest: 'Highest trophies',
  power: 'Power level',
  rank: 'Rank',
  name: 'Name',
};

export const BRAWLER_FILTER_LABELS: Readonly<Record<BrawlerFilter, string>> = {
  all: 'All profile brawlers',
  maxed: 'Power level 11+',
  ranked: 'Has a rank',
  unowned: 'Not in profile',
};

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function displayTag(tag: string): string {
  return `#${cleanTag(tag)}`;
}

/** Shared BrawlTools-style emoji fallbacks for player embeds. */
function profileEmojis(config: { readonly emojis: Partial<BotEmojiConfig> }) {
  return {
    trophies: formatEmoji(config.emojis.trophies, 'trophies') || '🏆',
    crown: formatEmoji(config.emojis.president, 'president') || '👑',
    ranked: formatEmoji(config.emojis.ranked, 'ranked') || '🎖️',
    rank: formatEmoji(config.emojis.rank, 'rank') || '🔹',
    club: formatEmoji(config.emojis.members, 'members') || '👥',
    online: formatEmoji(config.emojis.online, 'online') || '🟢',
    wins: formatEmoji(config.emojis.wins, 'wins') || '✅',
    sync: '🕒',
  };
}

function formatDelta(value: number): string {
  const formatted = formatInteger(value) ?? '0';
  return value > 0 ? `+${formatted}` : formatted;
}

function playerName(view: { player: { name: string; tag: string } }, config: PlayerEmbedConfig): string {
  return formatPlayerLink(view.player.name, view.player.tag, config.playerProfileUrlTemplate);
}

function clubName(club: PlayerClubRef, config: PlayerEmbedConfig): string {
  return formatClubLink(club.name, club.tag, config.clubProfileUrlTemplate);
}

/** Shared, user-facing label for a stored membership status. */
export function statusLabel(status: ClubMembershipStatus): string {
  switch (status) {
    case 'current':
      return 'Current (verified by latest sync)';
    case 'last-recorded':
      return 'Last recorded; not verified as current';
    case 'past':
      return 'Confirmed previous membership';
    case 'incomplete':
      return 'Incomplete record';
  }
}

function formatDuration(ms: number | null): string | null {
  if (ms === null || ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Less than a minute';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (remainingMinutes > 0) parts.push(`${remainingMinutes}m`);
  return parts.join(' ');
}

function membershipLines(record: PlayerMembershipRecord): string[] {
  const lines = [`Status: ${statusLabel(record.status)}`];
  if (record.role !== null) lines.push(`Role: ${record.role}`);
  if (record.validFrom !== null) {
    lines.push(`Joined: ${formatAbsoluteTime(record.validFrom) ?? record.validFrom}`);
  }
  if (record.validTo !== null) {
    lines.push(`Left: ${formatAbsoluteTime(record.validTo) ?? record.validTo}`);
  }
  const duration = formatDuration(record.durationMs);
  if (duration !== null) lines.push(`Duration: ${duration}`);
  if (record.id === null) lines.push('Club identity is incomplete.');
  return lines;
}

function eventLines(event: PlayerMembershipEvent, config: PlayerEmbedConfig): string {
  const clubTag = (club: PlayerClubRef | null): string =>
    club === null ? 'unknown club' : `${clubName(club, config)} (#${cleanTag(club.tag)})`;
  const action = event.eventType === 'join'
    ? `joined ${clubTag(event.toClub)}`
    : event.eventType === 'leave'
      ? `left ${clubTag(event.fromClub)}`
      : `transferred from ${clubTag(event.fromClub)} to ${clubTag(event.toClub)}`;
  return `• ${action} — ${formatAbsoluteTime(event.detectedAt) ?? event.detectedAt}`;
}

function formatBestTime(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function formatRankedLine(name: string | null | undefined, elo: number | null): string | null {
  if ((name === null || name === undefined) && elo === null) return null;
  const parts = [name ?? null, elo === null ? null : `${formatInteger(elo)} Elo`].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return parts.length === 0 ? null : parts.join(' • ');
}

/** Build the detailed `/me` embed. Static icon images are optional and best-effort. */
export function buildPlayerProfileEmbed(
  view: PlayerProfileView,
  config: PlayerEmbedConfig,
  iconUrl: string | null = null,
): EmbedBuilder {
  const emoji = profileEmojis(config);
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(`${playerName(view, config)} • ${displayTag(view.player.tag)}`, 256))
    .setDescription(
      truncate(
        `Source: ${view.source === 'live' ? 'live official API' : 'stored sync data'}` +
          (view.apiIssue !== null ? ` • API notice: ${view.apiIssue}` : ''),
        2048,
      ),
    );
  if (iconUrl !== null) embed.setThumbnail(iconUrl);

  const trophies = formatInteger(view.player.trophies);
  if (trophies !== null) {
    embed.addFields({
      name: `${emoji.trophies} Current Trophies`,
      value: trophies,
      inline: true,
    });
  }
  const highest = formatInteger(view.player.highestTrophies);
  if (highest !== null) {
    embed.addFields({
      name: `${emoji.crown} Highest Trophies`,
      value: highest,
      inline: true,
    });
  }
  const expLevel = formatInteger(view.player.expLevel);
  if (expLevel !== null) {
    const expPoints = formatInteger(view.player.expPoints);
    embed.addFields({
      name: 'Experience',
      value: expPoints === null ? `Level ${expLevel}` : `Level ${expLevel} • ${expPoints} XP`,
      inline: true,
    });
  }

  const fameParts: string[] = [];
  if (view.player.fameTierName !== null) fameParts.push(view.player.fameTierName);
  if (view.player.fame !== null) fameParts.push(`${formatInteger(view.player.fame)} fame`);
  if (view.player.totalPrestigeLevel !== null) {
    fameParts.push(`Prestige ${formatInteger(view.player.totalPrestigeLevel)}`);
  }
  if (fameParts.length > 0) {
    embed.addFields({ name: 'Fame & Prestige', value: truncate(fameParts.join(' • '), 1024) });
  }

  const rankedCurrent = formatRankedLine(view.player.rankedRankName, view.player.rankedElo);
  const rankedSeasonHigh = formatRankedLine(
    view.player.highestSeasonRankedRankName,
    view.player.highestSeasonRankedElo,
  );
  const rankedAllTimeHigh = formatRankedLine(
    view.player.highestAllTimeRankedRankName,
    view.player.highestAllTimeRankedElo,
  );
  const rankedLines = [
    rankedCurrent === null ? null : `Current: ${rankedCurrent}`,
    rankedSeasonHigh === null ? null : `Season high: ${rankedSeasonHigh}`,
    rankedAllTimeHigh === null ? null : `All-time high: ${rankedAllTimeHigh}`,
    view.player.isQualifiedFromChampionshipChallenge === true ? 'Championship Challenge: Qualified' : null,
  ].filter((line): line is string => line !== null);
  if (rankedLines.length > 0) {
    embed.addFields({
      name: `${emoji.ranked} Ranked`,
      value: truncate(rankedLines.join('\n'), 1024),
    });
  }

  const lastBattle = formatSyncTime(view.player.lastBattleAt);
  if (lastBattle !== null) {
    embed.addFields({
      name: `${emoji.online} Player Activity`,
      value: truncate(
        `Last battle: ${lastBattle}\nLive online status is not exposed by the Brawl Stars API`,
        1024,
      ),
    });
  }

  const victoryLines = [
    view.player.threeVsThreeVictories === null
      ? null
      : `3v3: ${formatInteger(view.player.threeVsThreeVictories)}`,
    view.player.soloVictories === null ? null : `Solo: ${formatInteger(view.player.soloVictories)}`,
    view.player.duoVictories === null ? null : `Duo: ${formatInteger(view.player.duoVictories)}`,
  ].filter((line): line is string => line !== null);
  const recordLines = [
    formatBestTime(view.player.bestRoboRumbleTime) === null
      ? null
      : `Best Robo Rumble: ${formatBestTime(view.player.bestRoboRumbleTime)}`,
    formatBestTime(view.player.bestTimeAsBigBrawler) === null
      ? null
      : `Best Big Brawler: ${formatBestTime(view.player.bestTimeAsBigBrawler)}`,
  ].filter((line): line is string => line !== null);
  if (victoryLines.length > 0 || recordLines.length > 0) {
    embed.addFields({
      name: `${emoji.wins} Victories & Records`,
      value: truncate([...victoryLines, ...recordLines].join('\n'), 1024),
    });
  }

  if (view.currentClub !== null) {
    const club = view.currentClub;
    const lines = [`${emoji.club} Club: ${clubName(club, config)} (#${cleanTag(club.tag)})`];
    if (club.role !== null) lines.push(`Role: ${club.role}`);
    if (club.validFrom !== null) {
      lines.push(`Recorded from: ${formatAbsoluteTime(club.validFrom) ?? club.validFrom}`);
    }
    if (club.validTo !== null) {
      lines.push(`Recorded until: ${formatAbsoluteTime(club.validTo) ?? club.validTo}`);
    }
    embed.addFields({
      name: club.id === null ? 'Current Club (API)' : 'Current Club',
      value: truncate(lines.join('\n'), 1024),
    });
  }

  const latestSync = formatSyncTime(view.player.lastSyncedAt);
  const latestSnapshot = formatAbsoluteTime(view.latestSnapshotAt);
  if (latestSync !== null || latestSnapshot !== null) {
    embed.addFields({
      name: `${emoji.sync} Latest Synchronisation`,
      value: truncate(
        [
          latestSync === null ? null : `Player sync: ${latestSync}`,
          latestSnapshot === null ? null : `Snapshot: ${latestSnapshot}`,
        ]
          .filter((line): line is string => line !== null)
          .join('\n'),
        1024,
      ),
    });
  }

  if (view.brawlers.length > 0) {
    const statsPrefix = view.stats === null
      ? ''
      : `Brawlers: ${formatInteger(view.stats.brawlerCount) ?? view.brawlers.length}` +
        (view.stats.maxedBrawlers === null ? '' : ` • Maxed: ${formatInteger(view.stats.maxedBrawlers)}`) +
        '\n';
    embed.addFields({
      name: view.source === 'live' ? 'Top Brawlers (Live API)' : 'Top Brawlers',
      value: truncate(
        statsPrefix +
          view.brawlers
            .map((brawler) => {
              const parts = [
                `${emoji.trophies}${formatInteger(brawler.trophies) ?? 0}`,
                brawler.power === null ? null : `P${brawler.power}`,
                brawler.rank === null ? null : `R${brawler.rank}`,
                brawler.prestigeLevel !== null && brawler.prestigeLevel > 0
                  ? `Prestige ${brawler.prestigeLevel}`
                  : null,
                brawler.maxWinStreak !== null && brawler.maxWinStreak > 0
                  ? `Streak ${formatInteger(brawler.maxWinStreak)}`
                  : null,
              ].filter((part): part is string => part !== null);
              return `• ${escapeMarkdown(brawler.name)} — ${parts.join(' • ')}`;
            })
            .join('\n'),
        1024,
      ),
    });
  }

  embed.setFooter({
    text: truncate(
      view.profileFetchedAt === null
        ? 'Stored data only • No live API refresh was needed'
        : 'Current profile refreshed from the official Brawl Stars API',
      2048,
    ),
  });
  return fitEmbedToDiscordLimits(embed);
}

function hasBrawlerStats(brawler: PlayerBrawlerDetail): boolean {
  return (
    brawler.trophies !== null ||
    brawler.highestTrophies !== null ||
    brawler.power !== null ||
    brawler.rank !== null ||
    brawler.prestigeLevel !== null ||
    brawler.currentWinStreak !== null ||
    brawler.maxWinStreak !== null ||
    brawler.gadgets.length > 0 ||
    brawler.starPowers.length > 0 ||
    brawler.gears.length > 0 ||
    brawler.hyperCharges.length > 0
  );
}

function brawlerSummaryLine(brawler: PlayerBrawlerDetail): string {
  if (!hasBrawlerStats(brawler)) {
    return 'No stats in this player’s official profile payload.';
  }
  const parts = [
    brawler.trophies === null ? null : `🏆${formatInteger(brawler.trophies)}`,
    brawler.highestTrophies === null
      ? null
      : `Best ${formatInteger(brawler.highestTrophies)}`,
    brawler.power === null ? null : `P${brawler.power}`,
    brawler.rank === null ? null : `R${brawler.rank}`,
    brawler.prestigeLevel !== null && brawler.prestigeLevel > 0
      ? `Prestige ${brawler.prestigeLevel}`
      : null,
    brawler.maxWinStreak !== null && brawler.maxWinStreak > 0
      ? `Streak ${brawler.maxWinStreak}`
      : null,
  ].filter((part): part is string => part !== null && part !== '');
  return parts.join(' • ') || 'No numeric stats in this player’s official profile payload.';
}

function accessoryLine(name: string, items: readonly { readonly name: string | null; readonly id: number | null }[]): string | null {
  if (items.length === 0) return null;
  const labels = items
    .slice(0, 8)
    .map((item) => item.name ?? (item.id === null ? 'Unnamed' : `Unnamed (ID ${item.id})`));
  const extra = items.length > labels.length ? ` +${items.length - labels.length}` : '';
  return `• ${name}: ${escapeMarkdown(labels.join(', '))}${extra}`;
}

/** Build the paginated `/brawlers` roster embed from full official brawler data. */
export function buildPlayerBrawlersPageEmbed(
  view: PlayerBrawlersView,
  page: Page<PlayerBrawlerDetail>,
  sort: BrawlerSort,
  filter: BrawlerFilter,
  config: PlayerEmbedConfig,
  portraitUrl: string | null = null,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(`${playerName(view, config)} — Brawlers`, 256))
    .setDescription(
      truncate(
        `Source: ${view.source === 'live' ? 'live official player data' : 'stored official profile data'}` +
          (view.apiIssue === null ? '' : ` • API notice: ${view.apiIssue}`) +
          `\nShowing ${page.total} of ${view.brawlers.length} profile brawler${view.brawlers.length === 1 ? '' : 's'}` +
          (view.catalog.length > 0 ? ` • Official catalog: ${view.catalog.length}` : ''),
        2048,
      ),
    )
    .setFooter({
      text: truncate(
        `Sort: ${BRAWLER_SORT_LABELS[sort]} • Filter: ${BRAWLER_FILTER_LABELS[filter]} • Page ${page.page} / ${page.pageCount} • Showing ${page.start}–${page.end} of ${page.total}`,
        2048,
      ),
    });

  if (page.items.length === 0) {
    embed.addFields({
      name: 'Brawlers',
      value: filter === 'unowned' && view.catalog.length === 0
        ? 'The official brawler catalog is unavailable right now, so this filter cannot be applied.'
        : 'No brawlers match this filter.',
    });
  } else {
    page.items.forEach((brawler, index) => {
      embed.addFields({
        name: truncate(`${page.start + index}. ${escapeMarkdown(brawler.name)}`, 256),
        value: truncate(brawlerSummaryLine(brawler), 1024),
      });
    });
  }

  applyThumbnail(embed, portraitUrl);
  return fitEmbedToDiscordLimits(embed);
}

/** Build the detailed `/brawler` embed. Official API supplies no class/rarity text. */
export function buildBrawlerDetailEmbed(
  view: PlayerBrawlersView,
  brawler: PlayerBrawlerDetail,
  config: PlayerEmbedConfig,
  portraitUrl: string | null = null,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(
      truncate(
        `${escapeMarkdown(brawler.name)}${brawler.id === null ? '' : ` (ID ${brawler.id})`}`,
        256,
      ),
    )
    .setDescription(
      truncate(
        `${playerName(view, config)} (#${cleanTag(view.player.tag)}) • ` +
          `Source: ${view.source === 'live' ? 'live official player data' : 'stored official profile data'}` +
          (hasBrawlerStats(brawler) ? '' : '\nThis brawler has no stats in the player’s official profile payload.'),
        2048,
      ),
    )
    .setFooter({
      text: 'Official Brawl Stars API exposes no brawler class, rarity or description.',
    });
  if (portraitUrl !== null) embed.setThumbnail(portraitUrl);

  const numericLines = [
    brawler.trophies === null ? null : `Trophies: ${formatInteger(brawler.trophies)}`,
    brawler.highestTrophies === null
      ? null
      : `Highest trophies: ${formatInteger(brawler.highestTrophies)}`,
    brawler.power === null ? null : `Power level: ${brawler.power}`,
    brawler.rank === null ? null : `Rank: ${brawler.rank}`,
    brawler.prestigeLevel === null ? null : `Prestige: ${brawler.prestigeLevel}`,
    brawler.currentWinStreak === null ? null : `Current win streak: ${brawler.currentWinStreak}`,
    brawler.maxWinStreak === null ? null : `Best win streak: ${brawler.maxWinStreak}`,
  ].filter((line): line is string => line !== null);
  embed.addFields({
    name: 'Official Profile Stats',
    value: truncate(numericLines.join('\n') || 'No numeric stats in the official profile payload.', 1024),
  });

  const accessoryLines = [
    accessoryLine('Gadgets', brawler.gadgets),
    accessoryLine('Star Powers', brawler.starPowers),
    accessoryLine('Gears', brawler.gears),
    accessoryLine('Hypercharges', brawler.hyperCharges),
  ].filter((line): line is string => line !== null);
  embed.addFields({
    name: 'Unlocks',
    value: truncate(accessoryLines.join('\n') || 'No accessory details in the official profile payload.', 1024),
  });

  return fitEmbedToDiscordLimits(embed);
}

/** Build a paginated `/player-history` embed. */
export function buildPlayerHistoryPageEmbed(
  view: PlayerHistoryView,
  page: Page<PlayerHistoryView['points'][number]>,
  config: PlayerEmbedConfig,
  iconUrl: string | null = null,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(`${playerName(view, config)} — Trophy History`, 256))
    .setFooter({
      text: truncate(
        `${PERIOD_LABELS[view.period]} • Page ${page.page} / ${page.pageCount} • Showing ${page.start}–${page.end} of ${page.total}`,
        2048,
      ),
    });

  const current = formatInteger(view.currentTrophies);
  embed.setDescription(
    truncate(
      `${PERIOD_LABELS[view.period]}` +
        (current === null ? '' : ` • Current trophies: ${current}`),
      2048,
    ),
  );

  const highest = formatInteger(view.highestRecordedTrophies);
  if (highest !== null) {
    embed.addFields({ name: 'Highest Recorded Trophies', value: highest });
  }
  embed.addFields({
    name: 'Stored Range',
    value: truncate(
      view.firstSnapshotAt === null || view.latestSnapshotAt === null
        ? 'No stored snapshots in this period.'
        : `${formatAbsoluteTime(view.firstSnapshotAt) ?? view.firstSnapshotAt} → ${formatAbsoluteTime(view.latestSnapshotAt) ?? view.latestSnapshotAt}\n${view.points.length} stored snapshot${view.points.length === 1 ? '' : 's'}`,
      1024,
    ),
  });

  if (view.change === null) {
    embed.addFields({
      name: 'Trophy Change',
      value: view.points.length === 0
        ? 'No stored snapshots in this period.'
        : 'At least two stored snapshots with trophy values are required.',
    });
  } else if (view.change.trophies !== null) {
    embed.addFields({
      name: 'Trophy Change',
      value: formatDelta(view.change.trophies),
    });
  }

  const progression = view.progression;
  if (progression !== null) {
    const lines: string[] = [];
    if (progression.today !== null) lines.push(`Today: ${formatDelta(progression.today)}`);
    if (progression.week !== null) lines.push(`Week: ${formatDelta(progression.week)}`);
    if (progression.season !== null) lines.push(`Season: ${formatDelta(progression.season)}`);
    if (lines.length > 0) {
      embed.addFields({ name: 'Trophy Progression', value: truncate(lines.join('\n'), 1024) });
    }
  }

  if (page.items.length === 0) {
    embed.addFields({
      name: 'Snapshots',
      value: 'No stored snapshots exist for this player in the selected period.',
    });
  } else {
    page.items.forEach((point) => {
      embed.addFields({
        name: truncate(formatAbsoluteTime(point.capturedAt) ?? point.capturedAt, 256),
        value: truncate(
          point.trophies === null
            ? 'Snapshot contains no stored trophy value.'
            : `Trophies: ${formatInteger(point.trophies)}`,
          1024,
        ),
      });
    });
  }

  if (page.page === 1 && (view.memberships.length > 0 || view.events.length > 0)) {
    const lines: string[] = [
      ...view.memberships
        .slice(0, 3)
        .map(
          (record) =>
            `• ${clubName(record, config)} — ${statusLabel(record.status)}` +
            (record.validFrom === null ? '' : ` from ${formatAbsoluteTime(record.validFrom) ?? record.validFrom}`),
        ),
      ...view.events.slice(0, 3).map((event) => eventLines(event, config)),
    ];
    embed.addFields({
      name: 'Club Membership Context',
      value: truncate(lines.join('\n'), 1024),
    });
  }

  applyThumbnail(embed, iconUrl);
  return fitEmbedToDiscordLimits(embed);
}

function battleResultLabel(result: string | null): string {
  switch (result?.toLowerCase()) {
    case 'victory':
      return 'Victory';
    case 'defeat':
      return 'Defeat';
    case 'draw':
    case 'tie':
      return 'Draw';
    default:
      return result === null ? 'Result not stored' : result;
  }
}

/** Build a paginated `/player-battles` embed from stored battle-log rows. */
export function buildPlayerBattlesPageEmbed(
  view: PlayerBattleHistoryView,
  page: Page<PlayerBattleRecord>,
  config: PlayerEmbedConfig,
  iconUrl: string | null = null,
  battlePortraitUrl: string | null = null,
): EmbedBuilder {
  const emojis = profileEmojis(config);
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(`${playerName(view, config)} — Battle History`, 256))
    .setDescription(
      truncate(
        `${PERIOD_LABELS[view.period]} • ${page.total} stored battle${page.total === 1 ? '' : 's'}` +
          (view.latestBattleAt === null
            ? ''
            : `\nLatest: ${formatAbsoluteTime(view.latestBattleAt) ?? view.latestBattleAt}`),
        2048,
      ),
    )
    .setFooter({
      text: truncate(
        `${PERIOD_LABELS[view.period]} • Page ${page.page} / ${page.pageCount} • Showing ${page.start}–${page.end} of ${page.total} • Official battle-log data only`,
        2048,
      ),
    });

  embed.addFields({
    name: 'Stored Results',
    value: `${emojis.wins} ${view.wins} wins • ${view.losses} losses • ${view.draws} draws`,
  });
  if (view.trophyChange !== null) {
    embed.addFields({ name: 'Trophy Change', value: formatDelta(view.trophyChange) });
  }
  if (view.topModes.length > 0) {
    embed.addFields({
      name: 'Most Recorded Modes',
      value: view.topModes.map((entry) => `• ${escapeMarkdown(entry.mode)} — ${entry.count}`).join('\n'),
    });
  }

  if (page.items.length === 0) {
    embed.addFields({
      name: 'Battles',
      value: 'No stored battle-log entries exist for this player in the selected period.',
    });
  } else {
    page.items.forEach((battle) => {
      embed.addFields({
        name: truncate(formatAbsoluteTime(battle.battleTime) ?? battle.battleTime, 256),
        value: truncate(
          [
            battle.mode === null ? null : `Mode: ${escapeMarkdown(battle.mode)}`,
            battle.map === null ? null : `Map: ${escapeMarkdown(battle.map)}`,
            battle.brawlerName ? `Brawler: ${escapeMarkdown(battle.brawlerName)}` : null,
            battle.starPlayerName ? `Star player: ${escapeMarkdown(battle.starPlayerName)}` : null,
            `Result: ${battleResultLabel(battle.result)}`,
            battle.trophyChange === null
              ? null
              : `Trophy change: ${formatDelta(battle.trophyChange)}`,
          ]
            .filter((line): line is string => line !== null)
            .join('\n'),
          1024,
        ),
      });
    });
  }

  applyThumbnail(embed, battlePortraitUrl ?? iconUrl);
  return fitEmbedToDiscordLimits(embed);
}

/** Build a paginated `/player-clubs` embed. */
export function buildPlayerClubsPageEmbed(
  view: PlayerClubsView,
  page: Page<PlayerMembershipRecord>,
  config: PlayerEmbedConfig,
  iconUrl: string | null = null,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(`${playerName(view, config)} — Club History`, 256))
    .setFooter({
      text: truncate(
        `Memberships • Page ${page.page} / ${page.pageCount} • Showing ${page.start}–${page.end} of ${page.total}`,
        2048,
      ),
    });

  const current = view.currentClub;
  embed.setDescription(
    truncate(
      current === null
        ? 'No currently verified club membership is stored for this player.'
        : `Current club: ${clubName(current, config)} (#${cleanTag(current.tag)})` +
            (current.role === null ? '' : ` • ${current.role}`),
      2048,
    ),
  );

  if (page.page === 1) {
    const lastBattle = formatSyncTime(view.lastBattleAt ?? view.player.lastBattleAt ?? null);
    const megaPig = view.player.megaPig ?? null;
    const megaPigLines: string[] = [];
    if (megaPig != null) {
      if (megaPig.date != null) megaPigLines.push(`Event: ${escapeMarkdown(megaPig.date)}`);
      if (megaPig.wins != null) megaPigLines.push(`Wins: ${formatInteger(megaPig.wins) ?? megaPig.wins}`);
      if (megaPig.ticketsUsed != null) megaPigLines.push(`Tickets used: ${formatInteger(megaPig.ticketsUsed) ?? megaPig.ticketsUsed}`);
      if (megaPig.draws != null) megaPigLines.push(`Draws: ${formatInteger(megaPig.draws) ?? megaPig.draws}`);
      if (megaPig.losses != null) megaPigLines.push(`Losses: ${formatInteger(megaPig.losses) ?? megaPig.losses}`);
    }
    embed.addFields({
      name: 'Activity & Mega Pig',
      value: truncate(
        [
          lastBattle == null
            ? 'Last online: not available from the official API • Last observed battle: not recorded'
            : `Last online: not available from the official API • Last observed battle: ${lastBattle}`,
          megaPigLines.length > 0
            ? `Mega Pig (stored profile): ${megaPigLines.join(' • ')}`
            : 'Past Mega Pig wins: not available in stored BrawlHub/profile data (official API does not expose full historical event wins/tickets).',
        ].join('\n'),
        1024,
      ),
    });
  }

  if (page.items.length === 0) {
    embed.addFields({
      name: 'Club Memberships',
      value: 'No stored club membership records exist for this player.',
    });
  } else {
    page.items.forEach((record, index) => {
      embed.addFields({
        name: truncate(`${page.start + index}. ${clubName(record, config)} (#${cleanTag(record.tag)})`, 256),
        value: truncate(membershipLines(record).join('\n'), 1024),
      });
    });
  }

  if (page.page === 1 && view.events.length > 0) {
    embed.addFields({
      name: 'Recorded Transitions',
      value: truncate(view.events.slice(0, 5).map((event) => eventLines(event, config)).join('\n'), 1024),
    });
  }

  applyThumbnail(embed, iconUrl);
  return fitEmbedToDiscordLimits(embed);
}

function addComparisonMetric(
  embed: EmbedBuilder,
  view: PlayerComparisonView,
  config: PlayerEmbedConfig,
  name: string,
  firstValue: number | null,
  secondValue: number | null,
  formatter: (value: number) => string = (value) => formatInteger(value) ?? '0',
): void {
  if (firstValue === null || secondValue === null) return;
  const firstLabel = playerName(view.first, config);
  const secondLabel = playerName(view.second, config);
  const lines = [
    `${firstLabel}: ${formatter(firstValue)}`,
    `${secondLabel}: ${formatter(secondValue)}`,
  ];
  if (firstValue > secondValue) {
    lines.push(`Leader: ${firstLabel}`);
  } else if (secondValue > firstValue) {
    lines.push(`Leader: ${secondLabel}`);
  } else {
    lines.push('Leader: Tied');
  }
  embed.addFields({ name, value: truncate(lines.join('\n'), 1024) });
}

/** Build the `/player-compare` embed. */
export function buildPlayerCompareEmbed(
  view: PlayerComparisonView,
  config: PlayerEmbedConfig,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('Player Comparison')
    .setDescription(
      truncate(
        view.warning ?? `${PERIOD_LABELS[view.period]} • Compared from stored snapshots.`,
        2048,
      ),
    );

  addComparisonMetric(embed, view, config, 'Current Trophies', view.first.currentTrophies, view.second.currentTrophies);
  addComparisonMetric(embed, view, config, 'Highest Trophies', view.first.highestTrophies, view.second.highestTrophies);
  addComparisonMetric(embed, view, config, 'Experience Level', view.first.expLevel, view.second.expLevel);
  addComparisonMetric(
    embed,
    view,
    config,
    'Highest Recorded Trophies',
    view.first.highestRecordedTrophies,
    view.second.highestRecordedTrophies,
  );

  const progressionWindows: ReadonlyArray<{
    readonly key: 'today' | 'week' | 'season';
    readonly name: string;
  }> = [
    { key: 'today', name: 'Trophy Progression · Today' },
    { key: 'week', name: 'Trophy Progression · Week' },
    { key: 'season', name: 'Trophy Progression · Season' },
  ];
  for (const window of progressionWindows) {
    addComparisonMetric(
      embed,
      view,
      config,
      window.name,
      view.first.progression?.[window.key] ?? null,
      view.second.progression?.[window.key] ?? null,
      formatDelta,
    );
  }

  const firstClub = view.first.currentClub;
  const secondClub = view.second.currentClub;
  if (firstClub !== null && secondClub !== null) {
    embed.addFields({
      name: 'Current Club',
      value: truncate(
        [
          `${playerName(view.first, config)}: ${clubName(firstClub, config)} (#${cleanTag(firstClub.tag)})`,
          `${playerName(view.second, config)}: ${clubName(secondClub, config)} (#${cleanTag(secondClub.tag)})`,
        ].join('\n'),
        1024,
      ),
    });
  }

  embed.addFields({
    name: 'Latest Snapshot Timestamps',
    value: truncate(
      [
        `${playerName(view.first, config)}: ${formatAbsoluteTime(view.first.latestSnapshotAt) ?? 'none stored'}`,
        `${playerName(view.second, config)}: ${formatAbsoluteTime(view.second.latestSnapshotAt) ?? 'none stored'}`,
      ].join('\n'),
      1024,
    ),
  });

  embed.setFooter({
    text: truncate(
      view.aligned ? 'Stored snapshots are aligned.' : 'Stored snapshots are not aligned.',
      2048,
    ),
  });
  return fitEmbedToDiscordLimits(embed);
}

/** Compact Summary section for interactive `/me`. */
export function buildMeSummaryEmbed(
  view: PlayerProfileView,
  config: PlayerEmbedConfig,
  iconUrl: string | null = null,
): EmbedBuilder {
  const emoji = profileEmojis(config);
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(`${playerName(view, config)} • ${displayTag(view.player.tag)}`, 256))
    .setDescription(
      truncate(
        `Source: ${view.source === 'live' ? 'live official API' : 'stored sync data'}` +
          (view.apiIssue === null ? '' : ` • API notice: ${view.apiIssue}`),
        2048,
      ),
    );
  if (iconUrl !== null) embed.setThumbnail(iconUrl);

  const trophies = formatInteger(view.player.trophies);
  if (trophies !== null) {
    embed.addFields({ name: `${emoji.trophies} Trophies`, value: trophies, inline: true });
  }
  const highest = formatInteger(view.player.highestTrophies);
  if (highest !== null) {
    embed.addFields({ name: `${emoji.crown} Highest`, value: highest, inline: true });
  }
  if (view.player.expLevel !== null) {
    const expPoints = formatInteger(view.player.expPoints);
    embed.addFields({
      name: 'Experience',
      value: expPoints === null ? `Level ${view.player.expLevel}` : `Level ${view.player.expLevel} • ${expPoints} XP`,
      inline: true,
    });
  }

  const rankedCurrent = formatRankedLine(view.player.rankedRankName, view.player.rankedElo);
  if (rankedCurrent !== null) {
    embed.addFields({ name: `${emoji.ranked} Ranked`, value: truncate(rankedCurrent, 1024) });
  }
  if (view.currentClub !== null) {
    embed.addFields({
      name: `${emoji.club} Club`,
      value: truncate(
        `${clubName(view.currentClub, config)} (#${cleanTag(view.currentClub.tag)})` +
          (view.currentClub.role === null ? '' : ` • ${view.currentClub.role}`),
        1024,
      ),
    });
  }

  const lastBattle = formatSyncTime(view.player.lastBattleAt);
  if (lastBattle !== null) {
    embed.addFields({
      name: `${emoji.online} Last Battle`,
      value: truncate(`${lastBattle}\nLive online status is not exposed by the Brawl Stars API`, 1024),
    });
  }

  const topBrawlers = view.brawlers.slice(0, 5);
  if (topBrawlers.length > 0) {
    embed.addFields({
      name: 'Top Brawlers',
      value: truncate(
        topBrawlers
          .map((brawler) => `• ${escapeMarkdown(brawler.name)} — 🏆${formatInteger(brawler.trophies) ?? 0}`)
          .join('\n'),
        1024,
      ),
    });
  }

  const profileBrawlerCount = view.stats?.brawlerCount ?? view.brawlers.length;
  embed.setFooter({
    text: truncate(
      `Use the buttons to switch sections • ${profileBrawlerCount} brawler${profileBrawlerCount === 1 ? '' : 's'} in profile`,
      2048,
    ),
  });
  return fitEmbedToDiscordLimits(embed);
}

/** Brawlers section for interactive `/me`; reuses the full roster presentation. */
export function buildMeBrawlersEmbed(
  view: PlayerBrawlersView,
  page: Page<PlayerBrawlerDetail>,
  config: PlayerEmbedConfig,
  portraitUrl: string | null = null,
): EmbedBuilder {
  const embed = buildPlayerBrawlersPageEmbed(view, page, 'trophies', 'all', config, portraitUrl);
  embed
    .setTitle(truncate(`${playerName(view, config)} — Brawler Overview`, 256))
    .setFooter({
      text: truncate(
        `Page ${page.page} / ${page.pageCount} • Showing ${page.start}–${page.end} of ${page.total} • Use /brawler name:BRAWLER for full details`,
        2048,
      ),
    });
  return fitEmbedToDiscordLimits(embed);
}

/** More section for interactive `/me`, built only from stored official data. */
export function buildMeMoreEmbed(
  view: PlayerHighlightsView,
  config: PlayerEmbedConfig,
  iconUrl: string | null = null,
): EmbedBuilder {
  const history = view.history;
  const battles = view.battles;
  const clubs = view.clubs;
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(`${playerName(history, config)} — More`, 256))
    .setDescription(
      truncate(
        `Stored history from this server's registered clubs • Period: ${PERIOD_LABELS[battles.period]}`,
        2048,
      ),
    );

  const change = history.change?.trophies;
  embed.addFields({
    name: 'Trophy Change',
    value: change === null || change === undefined
      ? 'At least two stored snapshots are required.'
      : formatDelta(change),
    inline: true,
  });
  embed.addFields({
    name: 'Stored Results',
    value: `${battles.wins} wins • ${battles.losses} losses • ${battles.draws} draws`,
    inline: true,
  });
  const battleCount = battles.battles.length;
  embed.addFields({
    name: 'Stored Battles',
    value: `${battleCount} in the selected period`,
    inline: true,
  });

  if (battles.topModes.length > 0) {
    embed.addFields({
      name: 'Most Recorded Modes',
      value: truncate(
        battles.topModes.map((entry) => `• ${escapeMarkdown(entry.mode)} — ${entry.count}`).join('\n'),
        1024,
      ),
    });
  }
  if (battles.battles.length > 0) {
    embed.addFields({
      name: 'Recent Battles',
      value: truncate(
        battles.battles
          .slice(0, 3)
          .map((battle) => {
            const parts = [
              battle.mode === null ? null : escapeMarkdown(battle.mode),
              battle.brawlerName === null ? null : escapeMarkdown(battle.brawlerName),
              battleResultLabel(battle.result),
              formatAbsoluteTime(battle.battleTime) ?? battle.battleTime,
            ].filter((part): part is string => part !== null);
            return `• ${parts.join(' • ')}`;
          })
          .join('\n'),
        1024,
      ),
    });
  }

  const current = clubs.currentClub;
  embed.addFields({
    name: 'Club Record',
    value: truncate(
      [
        current === null
          ? 'No currently verified club membership is stored.'
          : `${clubName(current, config)} (#${cleanTag(current.tag)})` +
            (current.role === null ? '' : ` • ${current.role}`),
        `${clubs.memberships.length} stored membership record${clubs.memberships.length === 1 ? '' : 's'} • ${clubs.events.length} recorded transition${clubs.events.length === 1 ? '' : 's'}`,
      ].join('\n'),
      1024,
    ),
  });

  embed.setFooter({
    text: truncate(
      clubs.lastBattleAt === null
        ? 'No last battle timestamp is stored for this player.'
        : `Last observed battle: ${formatAbsoluteTime(clubs.lastBattleAt) ?? clubs.lastBattleAt}`,
      2048,
    ),
  });
  applyThumbnail(embed, iconUrl);
  return fitEmbedToDiscordLimits(embed);
}
