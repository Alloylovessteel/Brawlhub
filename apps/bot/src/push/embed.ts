import { EmbedBuilder } from 'discord.js';
import type { BotConfig } from '../config';
import { fitEmbedToDiscordLimits } from '../clubs/embed';
import { escapeMarkdown, formatInteger, formatPlayerLink } from '../discord/format';
import type { Page } from '../discord/pagination';
import type { PlayerIdentity } from '../players/types';
import { competitionStatus } from './calculate';
import type {
  PushCompetitionRecord,
  PushJoinResult,
  PushLeaderboardView,
  PushSubmitResult,
} from './types';

const EMBED_COLOR = 0x5865_f2;

type EmbedConfig = Pick<BotConfig, 'playerProfileUrlTemplate'>;

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function integer(value: number | null | undefined): string {
  return formatInteger(value ?? null) ?? '—';
}

function delta(value: number): string {
  const formatted = integer(value);
  return value > 0 ? `+${formatted}` : formatted;
}

/** Discord timestamp with a style, or a graceful placeholder for bad data. */
export function formatPushTimestamp(value: string | null | undefined, style: 'F' | 'R'): string {
  if (value === undefined || value === null) return '—';
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return '—';
  return `<t:${Math.floor(milliseconds / 1000)}:${style}>`;
}

function statusLabel(competition: PushCompetitionRecord, now: Date): string {
  const status = competitionStatus(competition, now);
  return status === 'upcoming' ? 'Upcoming' : status === 'active' ? 'Active' : 'Completed';
}

function periodLines(competition: PushCompetitionRecord): string {
  const start = formatPushTimestamp(competition.startsAt, 'F');
  const end = formatPushTimestamp(competition.endsAt, 'F');
  const relative = formatPushTimestamp(competition.endsAt, 'R');
  return `Start: ${start}\nEnd: ${end} (${relative})`;
}

function scopeLine(competition: PushCompetitionRecord): string {
  if (competition.club === null) return 'Club restriction: none';
  return `Club restriction: ${escapeMarkdown(competition.club.name)} (#${competition.club.tag})`;
}

function rulesValue(competition: PushCompetitionRecord): string {
  return truncate(
    competition.description ?? 'No additional rules were provided.',
    1024,
  );
}

function playerLabel(player: PlayerIdentity, config: EmbedConfig): string {
  return formatPlayerLink(player.name, player.tag, config.playerProfileUrlTemplate);
}

export function buildPushCreatedEmbed(
  competition: PushCompetitionRecord,
  now: Date = new Date(),
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(`Push created: ${competition.name}`, 256))
    .setTimestamp(now)
    .addFields(
      { name: 'Status', value: statusLabel(competition, now) },
      { name: 'Period', value: periodLines(competition) },
      { name: 'Scope', value: truncate(scopeLine(competition), 1024) },
      {
        name: 'Goal',
        value: competition.goal === null ? 'No trophy goal set' : `${integer(competition.goal)} trophies`,
      },
      { name: 'Rules', value: rulesValue(competition) },
    );

  embed.setFooter({
    text: 'The competition opens at its configured start time. Submissions are accepted only within the period.',
  });
  return fitEmbedToDiscordLimits(embed);
}

export function buildPushJoinedEmbed(
  competition: PushCompetitionRecord,
  player: PlayerIdentity,
  result: PushJoinResult,
  config: EmbedConfig,
  now: Date = new Date(),
): EmbedBuilder {
  const baseline =
    result.baselineTrophies === null
      ? 'Baseline unavailable — gain will not be calculated for this entry.'
      : `${integer(result.baselineTrophies)} trophies` +
        (result.baselineCapturedAt === null
          ? ''
          : ` (synced ${formatPushTimestamp(result.baselineCapturedAt, 'R')})`);

  return fitEmbedToDiscordLimits(
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(truncate(`Joined ${competition.name}`, 256))
      .setDescription(`Entered with ${playerLabel(player, config)}.`)
      .addFields(
        { name: 'Status', value: statusLabel(competition, now) },
        { name: 'Period', value: periodLines(competition) },
        { name: 'Starting baseline', value: truncate(baseline, 1024) },
      )
      .setTimestamp(now),
  );
}

export function buildPushSubmittedEmbed(
  competition: PushCompetitionRecord,
  player: PlayerIdentity,
  result: PushSubmitResult,
  config: EmbedConfig,
  now: Date = new Date(),
): EmbedBuilder {
  return fitEmbedToDiscordLimits(
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(truncate(`Result recorded: ${competition.name}`, 256))
      .setDescription(`Submitted by ${playerLabel(player, config)}.`)
      .addFields(
        { name: 'Trophies', value: integer(result.trophies) },
        { name: 'Recorded', value: formatPushTimestamp(result.submittedAt, 'F') },
        {
          name: 'Verification',
          value: 'Unverified user submission — not checked against the Brawl Stars API.',
        },
      )
      .setTimestamp(now),
  );
}

export function buildPushEndedEmbed(
  competition: PushCompetitionRecord,
  discordUserId: string,
  now: Date = new Date(),
): EmbedBuilder {
  return fitEmbedToDiscordLimits(
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(truncate(`Push ended: ${competition.name}`, 256))
      .addFields(
        { name: 'Status', value: 'Completed' },
        { name: 'Period', value: periodLines(competition) },
        { name: 'Ended by', value: `<@${discordUserId}>` },
        { name: 'Ended at', value: formatPushTimestamp(competition.endedAt ?? now.toISOString(), 'F') },
        { name: 'Entries preserved', value: `${integer(competition.entryCount)} entries and all submission history retained.` },
      )
      .setTimestamp(now),
  );
}

export function buildPushLeaderboardEmbed(
  view: PushLeaderboardView,
  page: Page<(typeof view.rows)[number]>,
  config: EmbedConfig,
  now: Date = new Date(),
): EmbedBuilder {
  const lines = page.items.map((row) => {
    const rank = row.rank === null ? '—' : `#${row.rank}`;
    const player = playerLabel(row.entry.player, config);
    const trophies = row.trophies === null ? '—' : integer(row.trophies);
    const gain =
      row.gain === null
        ? row.trophies === null
          ? 'no accepted submission'
          : 'baseline unavailable'
        : delta(row.gain);
    const verification =
      row.verificationStatus === null
        ? 'no accepted submission'
        : row.verificationStatus === 'verified'
          ? 'verified API data'
          : 'unverified user submission';
    const submitted =
      row.latestSubmissionAt === null ? '—' : formatPushTimestamp(row.latestSubmissionAt, 'R');
    return `${rank} ${player}\nTrophies: ${trophies} • Gain: ${gain}\n${verification} • ${submitted}`;
  });

  const description =
    lines.length === 0
      ? 'No one has joined this competition yet.'
      : lines.join('\n\n');

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(`Push leaderboard: ${view.competition.name}`, 256))
    .setDescription(truncate(description, 4000))
    .addFields(
      { name: 'Status', value: statusLabel(view.competition, now) },
      { name: 'Period', value: periodLines(view.competition) },
      { name: 'Rules', value: rulesValue(view.competition) },
      { name: 'Entries', value: `${page.start}–${page.end} of ${page.total} (page ${page.page}/${page.pageCount})` },
    )
    .setTimestamp(new Date(view.generatedAt))
    .setFooter({ text: 'Ranked by trophy gain. Entries without a baseline are unranked.' });

  return fitEmbedToDiscordLimits(embed);
}

export function buildPushListEmbed(
  competitions: readonly PushCompetitionRecord[],
  page: Page<PushCompetitionRecord>,
  now: Date = new Date(),
): EmbedBuilder {
  const lines = page.items.map((competition) => {
    const status = statusLabel(competition, now);
    const club = competition.club === null ? 'Open to all clubs' : `#${competition.club.tag} ${escapeMarkdown(competition.club.name)}`;
    const period = `${formatPushTimestamp(competition.startsAt, 'R')} → ${formatPushTimestamp(competition.endsAt, 'R')}`;
    return `**${escapeMarkdown(competition.name)}** — ${status}\n${club} • ${period} • ${integer(competition.entryCount)} entries`;
  });

  const description =
    lines.length === 0
      ? 'No push competitions have been created yet.'
      : lines.join('\n\n');

  return fitEmbedToDiscordLimits(
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('Push competitions')
      .setDescription(truncate(description, 4000))
      .addFields({
        name: 'Page',
        value: `${page.start}–${page.end} of ${page.total} (page ${page.page}/${page.pageCount})`,
      })
      .setTimestamp(now),
  );
}
