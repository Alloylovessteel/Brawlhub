import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type APIActionRowComponent,
  type APIStringSelectComponent,
} from 'discord.js';
import type { BotConfig } from '../../config';
import { formatClubLink, formatInteger, formatPlayerLink } from '../../discord/format';
import {
  CLUB_MEMBER_CAPACITY,
  clubEmojis,
  displayTag,
  fitEmbedToDiscordLimits,
  formatCompact,
  formatSyncTime,
} from '../embed';
import type { ClubSummary } from '../types';

/** Discord limits an embed to 25 fields and a select menu to 25 options. */
export const OVERVIEW_MAX_CLUBS = 25;
export const OVERVIEW_CUSTOM_ID_PREFIX = 'clubs:overview:';
const EMBED_COLOR = 0x5865_f2;
const CAVEAT =
  'Global/region rank and live online status are not exposed by the Brawl Stars API.';

export interface ClubOverviewEmbedInput {
  readonly summaries: readonly ClubSummary[];
  readonly guildLabel: string | null;
  readonly now: Date;
  readonly config: Pick<
    BotConfig,
    'emojis' | 'playerProfileUrlTemplate' | 'clubProfileUrlTemplate'
  >;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

export function buildClubOverviewCustomId(guildId: string): string {
  return `${OVERVIEW_CUSTOM_ID_PREFIX}${guildId}`;
}

/** Returns the guild ID only when the custom ID belongs to this overview family. */
export function parseClubOverviewCustomId(customId: string): string | null {
  if (!customId.startsWith(OVERVIEW_CUSTOM_ID_PREFIX)) return null;
  const guildId = customId.slice(OVERVIEW_CUSTOM_ID_PREFIX.length);
  return guildId.length > 0 ? guildId : null;
}

/** Sort by trophies so the strongest club appears first, mirroring the reference layout. */
export function sortOverviewSummaries(summaries: readonly ClubSummary[]): ClubSummary[] {
  return [...summaries].sort(
    (left, right) => (right.totalTrophies ?? -1) - (left.totalTrophies ?? -1),
  );
}

/** Build the single, compact, auto-updating club stats embed. */
export function buildClubOverviewEmbed(input: ClubOverviewEmbedInput): EmbedBuilder {
  const sorted = sortOverviewSummaries(input.summaries);
  const visible = sorted.slice(0, OVERVIEW_MAX_CLUBS);
  const emoji = clubEmojis(input.config);
  const label = input.guildLabel === null ? 'Club Stats' : `Overview from ${input.guildLabel}`;

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(`${label} | Club Stats`, 256))
    .setDescription('Stored official Brawl Stars data • refreshed automatically.')
    .setTimestamp(input.now);

  const postedAt = `<t:${Math.floor(input.now.getTime() / 1000)}:t>`;
  const showing = sorted.length > visible.length
    ? `Showing top ${visible.length} of ${sorted.length} clubs • `
    : '';
  embed.setFooter({
    text: truncate(
      `${showing}Updating every 30 minutes • Posted at ${postedAt} • ${CAVEAT}`,
      2048,
    ),
  });

  visible.forEach((summary) => {
    const leader = summary.leader;
    const trophyRange = summary.trophyRange;
    const rankedRange = summary.rankedRange;
    const mega = summary.megaPigEstimate;
    const active = summary.activeMembers24h;

    const lines = [
      leader === null
        ? `${emoji.crown} —`
        : `${emoji.crown} ${formatPlayerLink(leader.name, leader.tag, input.config.playerProfileUrlTemplate)}`,
      `${emoji.trophies}${formatInteger(summary.totalTrophies) ?? '—'}`,
    ];

    if (trophyRange !== null) {
      const low = formatCompact(trophyRange.low);
      const high = formatCompact(trophyRange.high);
      if (low !== null && high !== null) lines.push(`${emoji.trophyRange}${low}-${high}`);
    }

    if (rankedRange !== null) {
      lines.push(
        rankedRange.low === rankedRange.high
          ? `${emoji.rankFor(rankedRange.low)}${rankedRange.low}`
          : `${emoji.rankFor(rankedRange.low)}${rankedRange.low}-${emoji.rankFor(rankedRange.high)}${rankedRange.high}`,
      );
    }

    if (mega !== null && mega.sampleSize > 0) {
      lines.push(`${emoji.megaPig}${emoji.wins}${mega.wins}/${mega.matches} (est.)`);
    } else if (mega !== null) {
      lines.push(`${emoji.megaPig}No stored Mega Pig data`);
    }

    const required = formatInteger(summary.club.requiredTrophies);
    if (required !== null) lines.push(`${emoji.required}Req: ${required}`);

    const members = formatInteger(summary.memberCount) ?? '—';
    const memberLine = `${emoji.members}${members}/${CLUB_MEMBER_CAPACITY}`;
    lines.push(active === null ? memberLine : `${memberLine} • ${emoji.online}${active} active 24h`);

    const syncedAt = formatSyncTime(summary.latestSyncAt);
    if (syncedAt !== null) lines.push(`🕒Synced ${syncedAt}`);

    embed.addFields({
      name: truncate(
        `${formatClubLink(summary.club.name, summary.club.tag, input.config.clubProfileUrlTemplate)} • ${displayTag(summary.club.tag)}`,
        256,
      ),
      value: truncate(lines.join('\n'), 1024),
      inline: true,
    });
  });

  return fitEmbedToDiscordLimits(embed);
}

/** Aggregate figures for the tracked-club overview, from stored official data only. */
export function aggregateViewTags(summaries: readonly ClubSummary[]): {
  readonly clubs: number;
  readonly totalTrophies: number | null;
  readonly totalMembers: number | null;
  readonly averageTrophies: number | null;
  readonly averageRequiredTrophies: number | null;
  readonly averageActive24h: number | null;
  readonly averageMembers: number | null;
} {
  const average = (values: readonly number[]): number | null =>
    values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  const trophyValues = summaries.flatMap((s) => (s.totalTrophies === null ? [] : [s.totalTrophies]));
  const requiredValues = summaries.flatMap((s) =>
    s.club.requiredTrophies === null ? [] : [s.club.requiredTrophies],
  );
  const memberValues = summaries.flatMap((s) => (s.memberCount === null ? [] : [s.memberCount]));
  const activeValues = summaries.flatMap((s) =>
    s.activeMembers24h === null ? [] : [s.activeMembers24h],
  );
  return {
    clubs: summaries.length,
    totalTrophies: trophyValues.length === 0 ? null : trophyValues.reduce((sum, value) => sum + value, 0),
    totalMembers: memberValues.length === 0 ? null : memberValues.reduce((sum, value) => sum + value, 0),
    averageTrophies: average(trophyValues),
    averageRequiredTrophies: average(requiredValues),
    averageActive24h: average(activeValues),
    averageMembers: average(memberValues),
  };
}

export interface ViewTagsEmbedInput extends ClubOverviewEmbedInput {
  /** Full tracked list, including clubs beyond the auto-post's 25-club window. */
  readonly trackedSummaries: readonly ClubSummary[];
  readonly action: 'list' | 'added' | 'removed';
  readonly detail: string | null;
}

/** Reply embed for `/view tag add|remove|list`, built from stored official data. */
export function buildViewTagsEmbed(input: ViewTagsEmbedInput): EmbedBuilder {
  const emoji = clubEmojis(input.config);
  const totals = aggregateViewTags(input.trackedSummaries);
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate('Overview clubs • BrawlHub', 256))
    .setDescription(
      truncate(
        input.detail ??
          'Manage the clubs shown in this server’s auto-updating overview with `/view tag add|remove`.',
        2048,
      ),
    )
    .setTimestamp(input.now);

  embed.addFields({
    name: 'Tracked clubs',
    value: truncate(
      `${totals.clubs} / ${OVERVIEW_MAX_CLUBS} slots used`,
      1024,
    ),
    inline: true,
  });

  const trophies = formatInteger(totals.totalTrophies);
  if (trophies !== null) {
    embed.addFields({ name: 'Combined club trophies', value: trophies, inline: true });
  }
  const members = formatInteger(totals.totalMembers);
  if (members !== null) {
    embed.addFields({ name: 'Combined members', value: members, inline: true });
  }
  const averageTrophies = formatInteger(totals.averageTrophies);
  if (averageTrophies !== null) {
    embed.addFields({ name: 'Average club trophies', value: averageTrophies, inline: true });
  }
  const averageRequired = formatInteger(totals.averageRequiredTrophies);
  if (averageRequired !== null) {
    embed.addFields({ name: 'Average required trophies', value: averageRequired, inline: true });
  }
  const averageActive = formatInteger(totals.averageActive24h);
  if (averageActive !== null) {
    embed.addFields({
      name: 'Average active 24h',
      value: `${averageActive} (stored battle activity, not online status)`,
      inline: true,
    });
  }

  const lines = sortOverviewSummaries(input.trackedSummaries).map((summary) => {
    const club = summary.club;
    const clubTrophies = formatInteger(summary.totalTrophies) ?? '—';
    const clubMembers = formatInteger(summary.memberCount) ?? '—';
    return `${formatClubLink(club.name, club.tag, input.config.clubProfileUrlTemplate)} • ${displayTag(club.tag)} — ${emoji.trophies}${clubTrophies} • ${emoji.members}${clubMembers}`;
  });
  embed.addFields({
    name: 'Clubs in this overview',
    value: truncate(
      lines.length === 0
        ? 'No clubs selected yet. Registered clubs are shown until you choose a subset.'
        : lines.join('\n'),
      1024,
    ),
  });

  embed.setFooter({
    text: truncate(
      `${input.action === 'added' ? 'Added' : input.action === 'removed' ? 'Removed' : 'Updated'} • ${CAVEAT}`,
      2048,
    ),
  });

  return fitEmbedToDiscordLimits(embed);
}

/** The "Choose a Club" select menu attached below the overview embed. */
export function buildClubOverviewSelect(
  summaries: readonly ClubSummary[],
  guildId: string,
): APIActionRowComponent<APIStringSelectComponent> | null {
  const sorted = sortOverviewSummaries(summaries);
  if (sorted.length === 0) return null;

  const select = new StringSelectMenuBuilder()
    .setCustomId(buildClubOverviewCustomId(guildId))
    .setPlaceholder('Choose a Club (1-25)')
    .addOptions(
      sorted.slice(0, OVERVIEW_MAX_CLUBS).map((summary) => ({
        label: truncate(`${summary.club.name} (#${summary.club.tag})`, 100),
        value: summary.club.tag,
      })),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select).toJSON();
}
