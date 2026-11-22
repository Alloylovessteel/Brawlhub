import { mdBold, mdCode, mdKeyValue, mdKeyValueList, mdList, mdSection } from '../discord/embed-format';
import { EMBED_COLORS } from '../discord/embed-style';
import { EmbedBuilder } from 'discord.js';
import type { BotConfig } from '../config';
import { fitEmbedToDiscordLimits } from '../clubs/embed';
import { escapeMarkdown, formatInteger, formatPlayerLink } from '../discord/format';
import type { Page } from '../discord/pagination';
import type { PlayerIdentity } from '../players/types';
import { competitionStatus } from './calculate';
import type {
  CompetitionRecord,
  CompetitionJoinResult,
  CompetitionLeaderboardView,
  CompetitionSubmitResult,
} from './types';

const EMBED_COLOR = EMBED_COLORS.competition;

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
export function formatCompetitionTimestamp(value: string | null | undefined, style: 'F' | 'R'): string {
  if (value === undefined || value === null) return '—';
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return '—';
  return `<t:${Math.floor(milliseconds / 1000)}:${style}>`;
}

function statusLabel(competition: CompetitionRecord, now: Date): string {
  const status = competitionStatus(competition, now);
  return status === 'upcoming' ? 'Upcoming' : status === 'active' ? 'Active' : 'Completed';
}

function periodLines(competition: CompetitionRecord): string {
  const start = formatCompetitionTimestamp(competition.startsAt, 'F');
  const end = formatCompetitionTimestamp(competition.endsAt, 'F');
  const relative = formatCompetitionTimestamp(competition.endsAt, 'R');
  return mdKeyValueList([
    ['Start', start],
    ['End', `${end} (${relative})`],
  ]);
}

function scopeLine(competition: CompetitionRecord): string {
  if (competition.club === null) return mdKeyValue('Club restriction', 'none');
  return mdKeyValue(
    'Club restriction',
    `${escapeMarkdown(competition.club.name)} (${mdCode(`#${competition.club.tag}`)})`,
  );
}

function rulesValue(competition: CompetitionRecord): string {
  return truncate(mdList([competition.description ?? 'No additional rules were provided.']), 1024);
}

function playerLabel(player: PlayerIdentity, config: EmbedConfig): string {
  return formatPlayerLink(player.name, player.tag, config.playerProfileUrlTemplate);
}

export function buildCompetitionCreatedEmbed(
  competition: CompetitionRecord,
  now: Date = new Date(),
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(`Competition created: ${competition.name}`, 256))
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

export function buildCompetitionJoinedEmbed(
  competition: CompetitionRecord,
  player: PlayerIdentity,
  result: CompetitionJoinResult,
  config: EmbedConfig,
  now: Date = new Date(),
): EmbedBuilder {
  const baseline =
    result.baselineTrophies === null
      ? 'Baseline unavailable — gain will not be calculated for this entry.'
      : `${integer(result.baselineTrophies)} trophies` +
        (result.baselineCapturedAt === null
          ? ''
          : ` (synced ${formatCompetitionTimestamp(result.baselineCapturedAt, 'R')})`);

  return fitEmbedToDiscordLimits(
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(truncate(`Joined ${competition.name}`, 256))
      .setDescription(mdSection('Entry', `Entered with ${playerLabel(player, config)}.`))
      .addFields(
        { name: 'Status', value: statusLabel(competition, now) },
        { name: 'Period', value: periodLines(competition) },
        { name: 'Starting baseline', value: truncate(baseline, 1024) },
      )
      .setTimestamp(now),
  );
}

export function buildCompetitionSubmittedEmbed(
  competition: CompetitionRecord,
  player: PlayerIdentity,
  result: CompetitionSubmitResult,
  config: EmbedConfig,
  now: Date = new Date(),
): EmbedBuilder {
  return fitEmbedToDiscordLimits(
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(truncate(`Result recorded: ${competition.name}`, 256))
      .setDescription(mdSection('Submission', `Submitted by ${playerLabel(player, config)}.`))
      .addFields(
        { name: 'Trophies', value: integer(result.trophies) },
        { name: 'Recorded', value: formatCompetitionTimestamp(result.submittedAt, 'F') },
        {
          name: 'Verification',
          value: `${mdBold('Unverified user submission')} — not checked against the Brawl Stars API.`,
        },
      )
      .setTimestamp(now),
  );
}

export function buildCompetitionEndedEmbed(
  competition: CompetitionRecord,
  discordUserId: string,
  now: Date = new Date(),
): EmbedBuilder {
  return fitEmbedToDiscordLimits(
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(truncate(`Competition ended: ${competition.name}`, 256))
      .addFields(
        { name: 'Status', value: 'Completed' },
        { name: 'Period', value: periodLines(competition) },
        { name: 'Ended by', value: `<@${discordUserId}>` },
        { name: 'Ended at', value: formatCompetitionTimestamp(competition.endedAt ?? now.toISOString(), 'F') },
        { name: 'Entries preserved', value: `${integer(competition.entryCount)} entries and all submission history retained.` },
      )
      .setTimestamp(now),
  );
}

export function buildCompetitionLeaderboardEmbed(
  view: CompetitionLeaderboardView,
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
      row.latestSubmissionAt === null ? '—' : formatCompetitionTimestamp(row.latestSubmissionAt, 'R');
    return [
      `${mdCode(rank)} ${player}`,
      mdKeyValueList([
        ['Trophies', trophies],
        ['Gain', gain],
      ]),
      mdList([verification, submitted]),
    ].join('\n');
  });

  const description =
    lines.length === 0
      ? 'No one has joined this competition yet.'
      : lines.join('\n\n');

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(`Competition leaderboard: ${view.competition.name}`, 256))
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

export function buildCompetitionListEmbed(
  competitions: readonly CompetitionRecord[],
  page: Page<CompetitionRecord>,
  now: Date = new Date(),
): EmbedBuilder {
  const lines = page.items.map((competition) => {
    const status = statusLabel(competition, now);
    const club =
      competition.club === null
        ? 'Open to all clubs'
        : `${mdCode(`#${competition.club.tag}`)} ${escapeMarkdown(competition.club.name)}`;
    const period = `${formatCompetitionTimestamp(competition.startsAt, 'R')} → ${formatCompetitionTimestamp(competition.endsAt, 'R')}`;
    return [
      `${mdBold(escapeMarkdown(competition.name))} — ${status}`,
      mdList([club, period, `${integer(competition.entryCount)} entries`]),
    ].join('\n');
  });

  const description =
    lines.length === 0
      ? 'No competitions have been created yet.'
      : lines.join('\n\n');

  return fitEmbedToDiscordLimits(
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('Competitions')
      .setDescription(truncate(description, 4000))
      .addFields({
        name: 'Page',
        value: `${page.start}–${page.end} of ${page.total} (page ${page.page}/${page.pageCount})`,
      })
      .setTimestamp(now),
  );
}
