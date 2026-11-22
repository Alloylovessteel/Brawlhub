import { mdCode, mdList, mdParagraphs, mdSection } from '../discord/embed-format';
import { EMBED_COLORS } from '../discord/embed-style';
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
import { setupGuildAutoRoles } from '../role-automation/service.js';
import { ROLE_KINDS } from '../role-automation/tiers.js';

const EMBED_COLOR = EMBED_COLORS.success;

export const autoCommandData = new SlashCommandBuilder()
  .setName('auto')
  .setDescription('Set up BrawlHub automation for this server')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('setup')
      .setDescription(
        'Auto roles: Verify, Trophy, Solo Win, Duo Win, 3vs3 Win, Brawler, Level, Ranked League, Club, Fame',
      )
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
    const roleSummary = await setupGuildAutoRoles(interaction.guild, actor, channelId);
    const kinds = ROLE_KINDS.map((entry) => entry.label).join(', ');

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setTitle('Automation setup complete')
          .setDescription(
            mdSection(
              'Summary',
              mdList([
                `Managed roles were created or reused for ${roleSummary.kinds.length} kinds: ${kinds}.`,
                `${roleSummary.configuredRoles} tier configurations were written to the managed-role ledger.`,
                'The verification message was posted once and will be edited on future setup runs.',
              ]),
            ),
          )
          .addFields(
            {
              name: 'Verification message',
              value: `<#${state.verificationChannelId}> / ${mdCode(state.verificationMessageId ?? 'unknown')}`,
            },
            {
              name: 'Supported role kinds',
              value: kinds,
            },
            {
              name: 'Auto roles',
              value: `${roleSummary.configuredRoles} tiers configured; ${roleSummary.managedRoles} managed roles (${roleSummary.createdRoles} created, ${roleSummary.reusedRoles} reused).`,
              inline: true,
            },
            {
              name: 'Channels',
              value: mdParagraphs(
                'No channels were created.',
                `Configure report and overview channels with ${mdCode('/settings')}.`,
              ),
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
  if (interaction.guildId !== embeddedGuildId) {
    await interaction.reply({
      content: 'This verification guide belongs to a different server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const message = buildVerificationMessage(interaction.guildId ?? embeddedGuildId ?? '');
  await interaction.editReply({
    embeds: [...message.embeds],
    allowedMentions: { parse: [] },
  });
}
