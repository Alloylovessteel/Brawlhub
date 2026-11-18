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
} from '../discord/pagination';
import { buildStaffListEmbed, buildStaffOverviewEmbed } from '../staff/embed';
import {
  canManageStaff,
  listStaff,
  resolveStaffActor,
  StaffServiceError,
} from '../staff/service';

const COMMAND_NAME = 'staff';
const LIST_PAGE_SIZE = 5;
const FORBIDDEN_MESSAGE = 'You do not have permission to view BrawlHub staff information.';

interface PagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

export const staffCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('View BrawlHub staff information')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('list')
      .setDescription('List registered BrawlHub staff (authorised staff only)'),
  );

async function buildListPage(pageNumber: number): Promise<PagePayload> {
  const view = await listStaff();
  const page = paginate(view.entries, pageNumber, LIST_PAGE_SIZE);
  const row = buildPaginationRow(COMMAND_NAME, page.page, page.pageCount);
  return {
    embeds: [buildStaffListEmbed(view, page)],
    components: row === null ? [] : [row],
  };
}

async function requireStaffManager(discordUserId: string): Promise<void> {
  const actor = await resolveStaffActor(discordUserId);
  if (!canManageStaff(actor)) {
    throw new StaffServiceError('forbidden', FORBIDDEN_MESSAGE);
  }
}

async function replyStaffError(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  error: unknown,
): Promise<void> {
  if (!(error instanceof StaffServiceError)) throw error;
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content: error.message, ephemeral: true });
    return;
  }
  await interaction.reply({ content: error.message, ephemeral: true });
}

export async function handleStaff(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);
  try {
    if (subcommand !== 'list') {
      await interaction.reply({
        embeds: [buildStaffOverviewEmbed()],
        allowedMentions: { parse: [] },
      });
      return;
    }

    await requireStaffManager(interaction.user.id);
    await interaction.reply({
      ...(await buildListPage(1)),
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyStaffError(interaction, error);
  }
}

export async function handleStaffComponent(interaction: ButtonInteraction): Promise<void> {
  const pageNumber = parsePaginationCustomId(interaction.customId, COMMAND_NAME);
  if (pageNumber === null) return;

  try {
    await interaction.deferUpdate();
    await requireStaffManager(interaction.user.id);
    await interaction.editReply({
      ...(await buildListPage(pageNumber)),
      content: null,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyStaffError(interaction, error);
  }
}
