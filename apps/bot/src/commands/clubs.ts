import { createLogger } from '@brawlhub/logging';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { buildClubsPageEmbed, paginateClubs } from '../clubs/embed';
import { loadClubSummaries } from '../clubs/service';
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
  const embed = buildClubsPageEmbed(summaries, page);
  const row = buildPaginationRow(COMMAND_NAME, page.page, page.pageCount);
  return { embeds: [embed], components: row === null ? [] : [row] };
}

/** Handle `/clubs` with a paginated list of registered clubs. */
export async function handleClubs(interaction: ChatInputCommandInteraction): Promise<void> {
  const page = await buildPage(interaction.guildId, 1);
  await interaction.reply({ ...page, allowedMentions: { parse: [] } });
}

/** Handle Previous/Next buttons for `/clubs`. */
export async function handleClubsComponent(interaction: CommandComponentInteraction): Promise<void> {
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
