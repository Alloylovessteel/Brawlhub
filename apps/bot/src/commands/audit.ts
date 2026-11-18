import {
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { buildAuditPageEmbed } from '../admin/embed';
import { replyAdminError } from '../admin/errors';
import { listAuditLogs, requireGlobalPermission } from '../admin/service';
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
    await requireGlobalPermission(interaction.user.id, 'audit:read');
    await interaction.reply({
      ...(await buildPage(1)),
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}

export async function handleAuditComponent(interaction: ButtonInteraction): Promise<void> {
  const pageNumber = parsePaginationCustomId(interaction.customId, COMMAND_NAME);
  if (pageNumber === null) return;

  try {
    await interaction.deferUpdate();
    await requireGlobalPermission(interaction.user.id, 'audit:read');
    await interaction.editReply({
      ...(await buildPage(pageNumber)),
      content: null,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}
