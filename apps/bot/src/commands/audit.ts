import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { buildAuditPageEmbed } from '../admin/embed';
import { replyAdminError } from '../admin/errors';
import { listAuditLogs, requireGlobalPermission } from '../admin/service';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';
import { paginate, buildPaginationRow, parsePaginationCustomId } from '../discord/pagination';

const COMMAND_NAME = 'audit';
const PAGE_SIZE = 5;
const AUDIT_LOG_LIMIT = 200;

export const auditCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('View the read-only BrawlHub audit log');

async function buildPage(pageNumber: number) {
  const view = await listAuditLogs(AUDIT_LOG_LIMIT);
  const page = paginate(view.entries, pageNumber, PAGE_SIZE);
  const row = buildPaginationRow(COMMAND_NAME, page.page, page.pageCount);
  return {
    embeds: [buildAuditPageEmbed(view, page)],
    components: row === null ? [] : [row],
  };
}

export async function handleAudit(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await requireGlobalPermission(interaction.user.id, 'audit:read', {
      guildId: interaction.guildId,
      memberPermissions: interaction.memberPermissions,
      memberRoleIds: getInteractionMemberRoleIds(interaction.member),
      isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
      discordUsername: interaction.user.username,
    });
    await interaction.editReply({
      ...(await buildPage(1)),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}

export async function handleAuditComponent(interaction: CommandComponentInteraction): Promise<void> {
  const pageNumber = parsePaginationCustomId(interaction.customId, COMMAND_NAME);
  if (pageNumber === null) return;

  try {
    await interaction.deferUpdate();
    await requireGlobalPermission(interaction.user.id, 'audit:read', {
      guildId: interaction.guildId,
      memberPermissions: interaction.memberPermissions,
      memberRoleIds: getInteractionMemberRoleIds(interaction.member),
      isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
      discordUsername: interaction.user.username,
    });
    await interaction.editReply({
      ...(await buildPage(pageNumber)),
      content: null,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}
