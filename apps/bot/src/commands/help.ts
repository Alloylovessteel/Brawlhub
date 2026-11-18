import {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import {
  buildPaginationRow,
  paginate,
  parsePaginationCustomId,
  type Page,
} from '../discord/pagination';
import { replyWithSafeError } from '../discord/errors';
import { HELP_CATEGORIES, type HelpCategory } from '../info/catalog';
import { buildHelpPageEmbed } from '../info/embed';

const COMMAND_NAME = 'help';
const CATEGORIES_PER_PAGE = 2;

interface PagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

export const helpCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Show the available BrawlHub commands');

function buildPage(pageNumber: number): PagePayload {
  const page: Page<HelpCategory> = paginate(HELP_CATEGORIES, pageNumber, CATEGORIES_PER_PAGE);
  const row = buildPaginationRow(COMMAND_NAME, page.page, page.pageCount);
  return {
    embeds: [buildHelpPageEmbed(page)],
    components: row === null ? [] : [row],
  };
}

export async function handleHelp(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await interaction.reply({
      ...buildPage(1),
      allowedMentions: { parse: [] },
    });
  } catch {
    await replyWithSafeError(interaction);
  }
}

export async function handleHelpComponent(interaction: ButtonInteraction): Promise<void> {
  const pageNumber = parsePaginationCustomId(interaction.customId, COMMAND_NAME);
  if (pageNumber === null) return;

  try {
    await interaction.deferUpdate();
    await interaction.editReply({
      ...buildPage(pageNumber),
      content: null,
      allowedMentions: { parse: [] },
    });
  } catch {
    await replyWithSafeError(interaction);
  }
}
