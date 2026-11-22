import { EmbedBuilder } from 'discord.js';
import { getBotConfig } from '../../config';
import { clubEmojis, fitEmbedToDiscordLimits } from '../embed';
import { cleanTag } from '../../discord/format';
import { CLUB_LOG_PERIOD_LABELS } from './page-view';
import type { ClubLogConfig, ClubLogEvent } from './types';

const EMBED_COLOR = 0x5865_f2;
const MAX_FIELDS = 25;
const STORED_HISTORY_NOTE = 'From stored BrawlHub sync history • not live';

const KIND_LABELS: Readonly<Record<ClubLogEvent['kind'], string>> = {
  membership: 'Membership',
  role: 'Role change',
  capacity: 'Capacity',
};

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function discordTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return 'unknown time';
  return `<t:${Math.floor(milliseconds / 1000)}:f>`;
}

/** Summary of this guild's configured club log subscriptions. */
export function buildClubLogsConfigEmbed(input: {
  readonly guildId: string;
  readonly logs: readonly ClubLogConfig[];
  readonly notice?: string | null;
}): EmbedBuilder {
  const emojis = clubEmojis(getBotConfig());
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`${emojis.members} Club change logs`)
    .setDescription(
      input.logs.length === 0
        ? `No club logs are configured for this server (\`${input.guildId}\`).`
        : `Club logs configured for this server (\`${input.guildId}\`):`,
    );

  if (input.notice !== undefined && input.notice !== null && input.notice.trim() !== '') {
    embed.addFields({ name: 'Update', value: truncate(input.notice, 1024) });
  }

  const shown = input.logs.length > MAX_FIELDS ? MAX_FIELDS - 1 : MAX_FIELDS;
  for (const log of input.logs.slice(0, shown)) {
    const periodLabels = (log.periods.length > 0 ? log.periods : (['today'] as const))
      .map((period) => CLUB_LOG_PERIOD_LABELS[period])
      .join(', ');
    embed.addFields({
      name: truncate(`${log.clubName} (#${cleanTag(log.clubTag)})`, 256),
      value: truncate(`<#${log.channelId}> • ${periodLabels}`, 1024),
    });
  }
  if (input.logs.length > MAX_FIELDS) {
    embed.addFields({
      name: 'Additional logs',
      value: `${input.logs.length - shown} more log(s) are configured in this server.`,
    });
  }

  embed.setFooter({ text: STORED_HISTORY_NOTE });
  return fitEmbedToDiscordLimits(embed);
}

/** Factual change log embed built only from stored sync-history events. */
export function buildClubLogEventEmbed(input: {
  readonly log: ClubLogConfig;
  readonly events: readonly ClubLogEvent[];
  readonly now: Date;
}): EmbedBuilder {
  const emojis = clubEmojis(getBotConfig());
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`#${cleanTag(input.log.clubTag)} club log`)
    .setDescription(
      `${emojis.sync} ${input.log.clubName} — ${input.events.length} stored change(s) since this log was configured.`,
    )
    .setTimestamp(input.now)
    .setFooter({ text: STORED_HISTORY_NOTE });

  if (input.events.length === 0) {
    embed.addFields({ name: 'Changes', value: 'No new stored changes.' });
    return fitEmbedToDiscordLimits(embed);
  }

  for (const event of input.events.slice(0, MAX_FIELDS)) {
    const timestamp = discordTimestamp(event.detectedAt);
    embed.addFields({
      name: truncate(`${KIND_LABELS[event.kind]} • ${timestamp}`, 256),
      value: truncate(`${event.description}\n${timestamp}`, 1024),
    });
  }
  return fitEmbedToDiscordLimits(embed);
}
