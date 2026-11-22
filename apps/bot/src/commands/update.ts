import { mdList, mdSection } from '../discord/embed-format';
import { EMBED_COLORS } from '../discord/embed-style';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { replyAdminError } from '../admin/errors.js';
import { requireGlobalPermission } from '../admin/service.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { replyExpiredComponent } from '../discord/errors.js';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';
import { refreshGuildRankedRoles } from '../ranked-roles/service.js';

const EMBED_COLOR = EMBED_COLORS.neutral;
const SUCCESS_COLOR = EMBED_COLORS.success;

export const updateCommandData = new SlashCommandBuilder()
  .setName('update')
  .setDescription('Refresh all ranked roles in this server from verified accounts');

type PermissionInteraction = Pick<
  ChatInputCommandInteraction,
  'guildId' | 'memberPermissions' | 'member' | 'guild' | 'user'
>;

function permissionContext(interaction: PermissionInteraction) {
  return {
    guildId: interaction.guildId,
    memberPermissions: interaction.memberPermissions,
    memberRoleIds: getInteractionMemberRoleIds(interaction.member),
    isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
    discordUsername: interaction.user.username,
  };
}

export async function handleUpdate(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (interaction.guild === null || interaction.guildId === null) {
    await interaction.editReply({ content: 'This command can only be used in a Discord server.' });
    return;
  }

  try {
    await requireGlobalPermission(interaction.user.id, 'clubs:write', permissionContext(interaction));
    const button = new ButtonBuilder()
      .setCustomId(`update:run:${interaction.guildId}`)
      .setLabel('Refresh ranked roles')
      .setStyle(ButtonStyle.Primary);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setTitle('Refresh ranked roles?')
          .setDescription(
            mdSection(
              'What this does',
              mdList([
                'This updates ranked roles for verified main accounts in this server using stored official Brawl Stars data.',
                'It does not create channels or run a sync.',
              ]),
            ),
          ),
      ],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}

export async function handleUpdateComponent(interaction: CommandComponentInteraction): Promise<void> {
  const [, action, embeddedGuildId] = interaction.customId.split(':');
  if (action !== 'run') return;
  if (interaction.guild === null || interaction.guildId !== embeddedGuildId) {
    await replyExpiredComponent(
      interaction,
      'That refresh button belongs to another server. Run `/update` here.',
    );
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const actor = await requireGlobalPermission(
      interaction.user.id,
      'clubs:write',
      permissionContext(interaction),
    );
    const result = await refreshGuildRankedRoles(interaction.guild, actor);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(SUCCESS_COLOR)
          .setTitle('Ranked roles refreshed')
          .addFields(
            { name: 'Verified mains', value: String(result.planned), inline: true },
            { name: 'Members updated', value: String(result.processed), inline: true },
            { name: 'Not in server', value: String(result.membersNotFound), inline: true },
            { name: 'Stale roles cleared', value: String(result.cleanedMembers), inline: true },
          ),
      ],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}
