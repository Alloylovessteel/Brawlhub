import {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { AdminServiceError, requireGlobalPermission } from '../admin/service';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';
import {
  buildPaginationRow,
  paginate,
  parsePaginationCustomId,
} from '../discord/pagination';
import { buildStaffListEmbed, buildStaffOverviewEmbed } from '../staff/embed';
import { listStaff, StaffServiceError } from '../staff/service';

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

async function buildListPage(guildId: string | null, pageNumber: number): Promise<PagePayload> {
  const view = await listStaff({ guildId });
  const page = paginate(view.entries, pageNumber, LIST_PAGE_SIZE);
  const row = buildPaginationRow(COMMAND_NAME, page.page, page.pageCount);
  return {
    embeds: [buildStaffListEmbed(view, page)],
    components: row === null ? [] : [row],
  };
}

type StaffInteraction = ChatInputCommandInteraction | CommandComponentInteraction;

function permissionContext(interaction: StaffInteraction) {
  return {
    guildId: interaction.guildId,
    memberPermissions: interaction.memberPermissions,
    memberRoleIds: getInteractionMemberRoleIds(interaction.member),
    isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
    discordUsername: interaction.user.username,
  };
}

async function requireStaffManager(interaction: StaffInteraction): Promise<void> {
  try {
    await requireGlobalPermission(interaction.user.id, 'staff:manage', permissionContext(interaction));
  } catch (error) {
    if (error instanceof AdminServiceError && error.code === 'forbidden') {
      throw new StaffServiceError('forbidden', FORBIDDEN_MESSAGE);
    }
    throw error;
  }
}

async function replyStaffError(interaction: StaffInteraction, error: unknown): Promise<void> {
  if (!(error instanceof StaffServiceError)) throw error;
  const payload = { content: error.message, flags: 64 } as const;
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
    return;
  }
  await interaction.reply(payload);
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

    await requireStaffManager(interaction);
    await interaction.reply({
      ...(await buildListPage(interaction.guildId, 1)),
      flags: 64,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyStaffError(interaction, error);
  }
}

export async function handleStaffComponent(interaction: CommandComponentInteraction): Promise<void> {
  const pageNumber = parsePaginationCustomId(interaction.customId, COMMAND_NAME);
  if (pageNumber === null) return;

  try {
    await interaction.deferUpdate();
    await requireStaffManager(interaction);
    await interaction.editReply({
      ...(await buildListPage(interaction.guildId, pageNumber)),
      content: null,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyStaffError(interaction, error);
  }
}
