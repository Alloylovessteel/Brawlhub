import { EmbedBuilder } from 'discord.js';
import { fitEmbedToDiscordLimits, formatAbsoluteTime } from '../clubs/embed';
import { paginate, type Page } from '../discord/pagination';
import type { EventKind, EventSlotView, EventView } from './types';

const EMBED_COLOR = 0x5865_f2;

function parseModeColor(value: string | null): number {
  if (value === null || !/^#[0-9a-f]{6}$/i.test(value)) return EMBED_COLOR;
  return Number.parseInt(value.slice(1), 16);
}

function kindLabel(kind: EventKind): string {
  return kind === 'active' ? 'Active' : 'Upcoming';
}

/** One official event per page, mirroring BrawlTools' detailed event view. */
export function paginateEvents(view: EventView, page: number, pageSize = 1): Page<EventSlotView> {
  return paginate(view.slots, page, pageSize);
}

export function buildEventPageEmbed(view: EventView, page: Page<EventSlotView>): EmbedBuilder {
  const label = kindLabel(view.kind);
  const footer =
    `${label} events • Page ${page.page} / ${page.pageCount} • ` +
    `Showing ${page.start}–${page.end} of ${page.total}`;
  const embed = new EmbedBuilder().setTitle(`${label} Events`).setFooter({ text: footer });

  const slot = page.items[0];
  if (slot === undefined) {
    embed
      .setColor(EMBED_COLOR)
      .setDescription(
        view.apiIssue === 'unavailable'
          ? 'The official Brawl Stars API could not be reached, so the live rotation is unavailable right now.'
          : `There are no ${view.kind} events in the official rotation at the moment.`,
      );
    return fitEmbedToDiscordLimits(embed);
  }

  embed.setColor(parseModeColor(slot.modeColor));
  embed.setDescription('Live rotation from the official Brawl Stars API.');
  if (slot.mapImageUrl !== null) embed.setImage(slot.mapImageUrl);
  if (slot.modeImageUrl !== null) embed.setThumbnail(slot.modeImageUrl);

  embed.addFields(
    { name: 'Game Mode', value: slot.modeLabel, inline: true },
    { name: 'Map', value: slot.mapName ?? 'Unknown', inline: true },
    { name: 'Slot', value: `#${slot.slotId}`, inline: true },
    {
      name: 'Starts',
      value: formatAbsoluteTime(slot.startAt) ?? slot.startAt,
      inline: true,
    },
    {
      name: 'Ends',
      value: formatAbsoluteTime(slot.endAt) ?? slot.endAt,
      inline: true,
    },
    {
      name: 'Data notes',
      value:
        'Map and game-mode images come from BrawlAPI. Popularity and win-rate statistics are not exposed by the official API, so they are not shown.',
    },
  );

  return fitEmbedToDiscordLimits(embed);
}
