import { mdCode, mdKeyValueList, mdParagraphs, mdSection } from '../discord/embed-format';
import { EMBED_COLORS } from '../discord/embed-style';
import { EmbedBuilder } from 'discord.js';
import { displayTag, fitEmbedToDiscordLimits } from '../clubs/embed';
import { escapeMarkdown } from '../discord/format';
import type { ReportType } from './period';
import type { ReportData } from './service';

const EMBED_COLOR = EMBED_COLORS.report;
const REPORT_LABELS: Readonly<Record<ReportType, string>> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};
const FOOTER = 'Stored BrawlHub sync history • fixed UTC boundaries • not live';
/** Discord allows 25 embed fields, one of which is the totals field. */
const MAX_CLUB_FIELDS = 24;

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function totalLine(data: ReportData): string {
  const totals = data.totals;
  return mdKeyValueList([
    ['Clubs', String(totals.clubs)],
    ['Joins', String(totals.joins)],
    ['Leaves', String(totals.leaves)],
    ['Transfers', String(totals.transfers)],
    ['Role changes', String(totals.roleChanges)],
    ['Capacity opens', String(totals.capacityOpens)],
    ['Capacity closes', String(totals.capacityCloses)],
  ]);
}

function clubValue(summary: ReportData['clubSummaries'][number]): string {
  return mdKeyValueList([
    ['Joins', String(summary.joins)],
    ['Leaves', String(summary.leaves)],
    ['Transfers', String(summary.transfers)],
    ['Role changes', String(summary.roleChanges)],
    ['Capacity opens', String(summary.capacityOpens)],
    ['closes', String(summary.capacityCloses)],
  ]);
}

/** Account for JSON field overhead as well as text length (Discord's 6,000-char cap). */
function fitReportEmbed(embed: EmbedBuilder): EmbedBuilder {
  fitEmbedToDiscordLimits(embed);
  const jsonLength = () => JSON.stringify(embed.toJSON()).length;
  const limits = [
    { name: 128, value: 256 },
    { name: 96, value: 128 },
    { name: 64, value: 64 },
  ] as const;

  for (const limit of limits) {
    if (jsonLength() <= 6000) break;
    embed.setFields(
      (embed.toJSON().fields ?? []).map((field) => ({
        ...field,
        name: truncate(field.name, limit.name),
        value: truncate(field.value, limit.value),
      })),
    );
  }

  while (jsonLength() > 6000) {
    const fields = embed.toJSON().fields ?? [];
    if (fields.length <= 1) break;
    embed.setFields(fields.slice(0, -1));
  }
  return embed;
}

/** Build a scheduled report embed using only stored sync-history aggregates. */
export function buildReportEmbed(input: {
  readonly data: ReportData;
  readonly guildLabel: string | null;
  readonly now: Date;
}): EmbedBuilder {
  const { data } = input;
  const label = input.guildLabel === null || input.guildLabel.trim() === ''
    ? 'unknown guild'
    : input.guildLabel;
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(
      truncate(
        `${REPORT_LABELS[data.period.type]} club report • ${escapeMarkdown(label)} period ${data.period.periodKey}`,
        256,
      ),
    )
    .setDescription(
      truncate(
        mdSection(
          'Stored events',
          mdParagraphs(
            mdKeyValueList([
              ['From', mdCode(data.period.start.toISOString())],
              ['To', mdCode(data.period.end.toISOString())],
            ]),
            'UTC, end exclusive',
          ),
        ),
        2048,
      ),
    )
    .setFooter({ text: FOOTER })
    .setTimestamp(input.now);

  embed.addFields({ name: 'Totals', value: truncate(totalLine(data), 1024), inline: false });
  for (const summary of data.clubSummaries.slice(0, MAX_CLUB_FIELDS)) {
    embed.addFields({
      name: truncate(`${displayTag(summary.tag)} ${escapeMarkdown(summary.name)}`, 256),
      value: truncate(clubValue(summary), 1024),
      inline: true,
    });
  }

  return fitReportEmbed(embed);
}
