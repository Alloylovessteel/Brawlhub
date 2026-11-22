import { createLogger } from '@brawlhub/logging';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { getBotConfig } from '../config';
import { buildClubsPageEmbed, paginateClubs } from '../clubs/embed';
import type { ClubSummary } from '../clubs/types';
import { loadClubSummaries } from '../clubs/service';
import { OVERVIEW_MAX_SELECTIONS, parseClubOverviewCustomId } from '../clubs/overview/embed';
import { cleanTag } from '../discord/format';
import {
  buildClubDetailsReply,
  buildClubMenuReply,
  parseClubChartCustomId,
  type ClubDetailsReply,
} from './club';
import { mapClubLookupFailureMessage } from './club-utils';
import { replyWithSafeError } from '../discord/errors';
import { chartFailureMessage, loadOrRenderChart } from '../images/chart-service.js';
import {
  buildPaginationRow,
  isPaginationButton,
  parsePaginationCustomId,
} from '../discord/pagination';

const logger = createLogger('bot');
const CLUBS_PAGE_SIZE = 5;
const COMMAND_NAME = 'clubs';
const CLUB_OPEN_PREFIX = 'clubs:open:';

/** New in-message action; original `clubs:page:` IDs stay byte-for-byte unchanged. */
function parseClubOpenCustomId(customId: string): string | null {
  if (!customId.startsWith(CLUB_OPEN_PREFIX)) return null;
  const tag = cleanTag(customId.slice(CLUB_OPEN_PREFIX.length));
  return tag === '' ? null : tag;
}

function buildClubOpenRow(page: { readonly items: readonly ClubSummary[] }): ActionRowBuilder<ButtonBuilder> | null {
  if (page.items.length === 0) return null;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    page.items.map((summary) =>
      new ButtonBuilder()
        .setCustomId(`${CLUB_OPEN_PREFIX}${cleanTag(summary.club.tag)}`)
        .setLabel(`Details · #${cleanTag(summary.club.tag)}`)
        .setStyle(ButtonStyle.Secondary),
    ),
  );
}

export const clubsCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('List all clubs registered with BrawlHub');

async function buildPage(guildId: string | null, pageNumber: number) {
  const summaries = await loadClubSummaries(guildId);
  const page = paginateClubs(summaries, pageNumber, CLUBS_PAGE_SIZE);
  const embed = buildClubsPageEmbed(summaries, page, getBotConfig());
  const paginationRow = buildPaginationRow(COMMAND_NAME, page.page, page.pageCount);
  const openRow = buildClubOpenRow(page);
  return {
    embeds: [embed],
    components: [
      ...(paginationRow === null ? [] : [paginationRow]),
      ...(openRow === null ? [] : [openRow]),
    ],
  };
}

/** Handle `/clubs` with a paginated list of registered clubs. */
export async function handleClubs(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await interaction.deferReply();
    const page = await buildPage(interaction.guildId, 1);
    await interaction.editReply({ ...page, allowedMentions: { parse: [] } });
  } catch (error) {
    logger.error('Clubs command failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}

/** Handle the multi-club select on the auto-posted overview message. */
async function handleOverviewSelect(
  interaction: StringSelectMenuInteraction,
  guildId: string,
): Promise<void> {
  // The custom ID carries the owning guild; never let a cross-guild message read another guild's data.
  if (interaction.guildId !== guildId) return;
  const tags = [...new Set(interaction.values)].slice(0, OVERVIEW_MAX_SELECTIONS);
  if (tags.length === 0) return;

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const config = getBotConfig();
    const now = new Date();
    const replies: ClubDetailsReply[] = [];
    for (const tag of tags) {
      replies.push(await buildClubDetailsReply(tag, guildId, config, now));
    }
    const contents = [
      ...new Set(
        replies
          .map((reply) => reply.content)
          .filter((content): content is string => content !== undefined && content.length > 0),
      ),
    ];
    await interaction.editReply({
      ...(contents.length === 0 ? {} : { content: contents.join('\n') }),
      embeds: replies.flatMap((reply) => reply.embeds).slice(0, OVERVIEW_MAX_SELECTIONS),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.error('Club overview selection failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}

/** Post a public, stored-data club chart from the second-row Chart button. */
export async function handleClubChart(
  interaction: CommandComponentInteraction,
  tag: string,
): Promise<void> {
  try {
    await interaction.deferReply();
    if (interaction.guildId === null) {
      await interaction.editReply({
        content: 'Club charts are only available in a server.',
        allowedMentions: { parse: [] },
      });
      return;
    }
    const result = await loadOrRenderChart({
      guildId: interaction.guildId,
      kind: 'club',
      tag,
      option: 'trophies',
      period: '90d',
    });
    if (result.kind === 'failure') {
      await interaction.editReply({
        content: chartFailureMessage(result.failure),
        allowedMentions: { parse: [] },
      });
      return;
    }
    await interaction.editReply({
      content: `Stored trophy history for club \`#${tag}\``,
      files: [new AttachmentBuilder(result.image.png, { name: result.image.fileName })],
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.error('Club chart button failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}

/** Handle Previous/Next buttons, Chart and the overview select menu. */
export async function handleClubsComponent(interaction: CommandComponentInteraction): Promise<void> {
  const chartTag = parseClubChartCustomId(interaction.customId);
  if (chartTag !== null) {
    await handleClubChart(interaction, chartTag);
    return;
  }

  const overviewGuildId = parseClubOverviewCustomId(interaction.customId);
  if (overviewGuildId !== null) {
    // Guard the type check so lightweight button mocks in tests do not need the full interaction API.
    const isSelect =
      typeof interaction.isStringSelectMenu === 'function' && interaction.isStringSelectMenu();
    if (isSelect) {
      await handleOverviewSelect(interaction as StringSelectMenuInteraction, overviewGuildId);
    }
    return;
  }

  const openTag = parseClubOpenCustomId(interaction.customId);
  if (openTag !== null) {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const reply = await buildClubMenuReply(
        openTag,
        interaction.guildId,
        getBotConfig(),
        new Date(),
      );
      if (reply.failure !== undefined) {
        await interaction.editReply({
          content: mapClubLookupFailureMessage(reply.failure),
          embeds: [],
          components: [],
          allowedMentions: { parse: [] },
        });
        return;
      }
      await interaction.editReply({
        ...(reply.content === undefined ? {} : { content: reply.content }),
        embeds: reply.embeds,
        components: reply.components,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      logger.error('Club list detail button failed', {
        error: error instanceof Error ? error.message : 'unknown error',
      });
      await replyWithSafeError(interaction);
    }
    return;
  }

  if (!isPaginationButton(interaction, COMMAND_NAME)) return;
  const requestedPage = parsePaginationCustomId(interaction.customId, COMMAND_NAME);
  if (requestedPage === null) return;

  try {
    await interaction.deferUpdate();
    const page = await buildPage(interaction.guildId, requestedPage);
    await interaction.editReply({ ...page, content: null, allowedMentions: { parse: [] } });
  } catch (error) {
    logger.error('Clubs pagination failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}
