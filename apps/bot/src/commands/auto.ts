import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { replyAdminError } from '../admin/errors.js';
import { requireGlobalPermission } from '../admin/service.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';
import {
  buildVerificationMessage,
  setupGuildAutomation,
} from '../ranked-roles/service.js';

const EMBED_COLOR = 0x5865_f2;

export const autoCommandData = new SlashCommandBuilder()
  .setName('auto')
  .setDescription('Set up BrawlHub automation for this server')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('setup')
      .setDescription('Create/reuse ranked roles and post the verification guide')
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Text channel for the verification message (defaults to this channel)')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false),
      ),
  );

function permissionContext(interaction: ChatInputCommandInteraction) {
  return {
    guildId: interaction.guildId,
    memberPermissions: interaction.memberPermissions,
    memberRoleIds: getInteractionMemberRoleIds(interaction.member),
    isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
    discordUsername: interaction.user.username,
  };
}

export async function handleAuto(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (interaction.guild === null || interaction.guildId === null) {
    await interaction.editReply({ content: 'This command can only be used in a Discord server.' });
    return;
  }

  try {
    const actor = await requireGlobalPermission(
      interaction.user.id,
      'clubs:write',
      permissionContext(interaction),
    );
    const channelId = interaction.options.getChannel('channel')?.id ?? interaction.channelId;
    const state = await setupGuildAutomation(interaction.guild, actor, channelId);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setTitle('Automation setup complete')
          .setDescription(
            'Ranked roles and the verified role were created or reused. The verification message was posted once and will be edited on future setup runs.',
          )
          .addFields(
            {
              name: 'Verification message',
              value: `<#${state.verificationChannelId}> / ${state.verificationMessageId ?? 'unknown'}`,
            },
            {
              name: 'Ranked roles',
              value: `${Object.keys(state.mapping).length} of 8 tiers configured`,
              inline: true,
            },
            {
              name: 'Channels',
              value: 'No channels were created. Configure report and overview channels with `/settings`.',
            },
          ),
      ],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}

export async function handleAutoComponent(interaction: CommandComponentInteraction): Promise<void> {
  const [, action, embeddedGuildId] = interaction.customId.split(':');
  if (action !== 'guide') return;
  if (interaction.guildId !== embeddedGuildId) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const message = buildVerificationMessage(interaction.guildId ?? embeddedGuildId ?? '');
  await interaction.editReply({
    embeds: [...message.embeds],
    allowedMentions: { parse: [] },
  });
}
