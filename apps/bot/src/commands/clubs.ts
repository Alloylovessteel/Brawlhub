import { createLogger } from '@brawlhub/logging';
import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { getBotConfig } from '../config';
import { buildClubsPageEmbed, paginateClubs } from '../clubs/embed';
import { loadClubSummaries } from '../clubs/service';
import { OVERVIEW_MAX_SELECTIONS, parseClubOverviewCustomId } from '../clubs/overview/embed';
import { buildClubDetailsReply, type ClubDetailsReply } from './club';
import { replyWithSafeError } from '../discord/errors';
import {
  buildPaginationRow,
  isPaginationButton,
  parsePaginationCustomId,
} from '../discord/pagination';

const logger = createLogger('bot');
const CLUBS_PAGE_SIZE = 5;
const COMMAND_NAME = 'clubs';

export const clubsCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('List all clubs registered with BrawlHub');

async function buildPage(guildId: string | null, pageNumber: number) {
  const summaries = await loadClubSummaries(guildId);
  const page = paginateClubs(summaries, pageNumber, CLUBS_PAGE_SIZE);
  const embed = buildClubsPageEmbed(summaries, page, getBotConfig());
  const row = buildPaginationRow(COMMAND_NAME, page.page, page.pageCount);
  return { embeds: [embed], components: row === null ? [] : [row] };
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

/** Handle Previous/Next buttons and the overview select menu. */
export async function handleClubsComponent(interaction: CommandComponentInteraction): Promise<void> {
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
