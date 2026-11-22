import { mdCode, mdList, mdSection } from '../discord/embed-format';
import { EMBED_COLORS } from '../discord/embed-style';
import { EmbedBuilder } from 'discord.js';
import { fitEmbedToDiscordLimits, formatAbsoluteTime } from '../clubs/embed';
import { paginate, type Page } from '../discord/pagination';
import { paginationFooter } from '../discord/ux.js';
import type { EventKind, EventSlotView, EventView } from './types';

const EMBED_COLOR = EMBED_COLORS.neutral;

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
  const embed = new EmbedBuilder()
    .setTitle(`${label} Events`)
    .setFooter({ text: paginationFooter(page, `${label} events`) });

  const slot = page.items[0];
  if (slot === undefined) {
    embed
      .setColor(EMBED_COLOR)
      .setDescription(
        view.apiIssue === 'unavailable'
          ? mdSection(
              'Unavailable',
              'The official Brawl Stars API could not be reached, so the live rotation is unavailable right now.',
            )
          : mdSection(
              'No events',
              `There are no ${view.kind} events in the official rotation at the moment.`,
            ),
      );
    return fitEmbedToDiscordLimits(embed);
  }

  embed.setColor(parseModeColor(slot.modeColor));
  embed.setDescription(mdSection('Source', 'Live rotation from the official Brawl Stars API.'));
  if (slot.mapImageUrl !== null) embed.setImage(slot.mapImageUrl);
  if (slot.modeImageUrl !== null) embed.setThumbnail(slot.modeImageUrl);

  embed.addFields(
    { name: 'Game Mode', value: slot.modeLabel, inline: true },
    { name: 'Map', value: slot.mapName ?? 'Unknown', inline: true },
    { name: 'Slot', value: mdCode(`#${slot.slotId}`), inline: true },
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
      value: mdList([
        'Map and game-mode images come from BrawlAPI.',
        'Popularity and win-rate statistics are not exposed by the official API, so they are not shown.',
      ]),
    },
  );

  return fitEmbedToDiscordLimits(embed);
}
