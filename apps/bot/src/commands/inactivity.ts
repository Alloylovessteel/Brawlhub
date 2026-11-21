import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { replyAdminError } from '../admin/errors';
import { AdminServiceError, requireGlobalPermission } from '../admin/service';
import { isIgnorableInteractionError } from '../discord/errors.js';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';
import {
  buildInactivitySettingsEmbed,
  MAX_INACTIVITY_DAYS,
  MIN_INACTIVITY_DAYS,
  readInactivitySettings,
  updateInactivitySettings,
} from '../reports/inactivity.js';

const COMMAND_NAME = 'inactivity';
const FORBIDDEN_MESSAGE = 'You do not have permission to manage inactivity reports in this server.';
const NO_GUILD_MESSAGE = 'Inactivity reports can only be configured from within a Discord server.';

const commandBuilder = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Configure the scheduled club inactivity report for this server');

// Keep the exported type as SlashCommandBuilder; discord.js narrows the return
// type of addSubcommand() but the builder instance itself is unchanged.
commandBuilder.addSubcommand((subcommand) =>
  subcommand.setName('view').setDescription('Show this server’s inactivity report settings'),
);
commandBuilder.addSubcommand((subcommand) =>
  subcommand
    .setName('set')
    .setDescription('Enable a customizable inactivity alert threshold')
    .addIntegerOption((option) =>
      option
        .setName('days')
        .setDescription('Flag members with no stored battle for at least this many days')
        .setMinValue(MIN_INACTIVITY_DAYS)
        .setMaxValue(MAX_INACTIVITY_DAYS)
        .setRequired(true),
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Text channel for the report; defaults to the overview channel')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false),
    ),
);
commandBuilder.addSubcommand((subcommand) =>
  subcommand
    .setName('clear-channel')
    .setDescription('Send the inactivity report back to the overview channel fallback'),
);
commandBuilder.addSubcommand((subcommand) =>
  subcommand.setName('disable').setDescription('Stop posting the inactivity report in this server'),
);

export const inactivityCommandData: SlashCommandBuilder = commandBuilder;

function requireGuildId(interaction: ChatInputCommandInteraction): string {
  if (interaction.guildId === null || interaction.guildId.trim() === '') {
    throw new AdminServiceError('invalid_guild', NO_GUILD_MESSAGE);
  }
  return interaction.guildId;
}

async function permissionContext(interaction: ChatInputCommandInteraction) {
  return {
    guildId: interaction.guildId,
    memberPermissions: interaction.memberPermissions,
    memberRoleIds: getInteractionMemberRoleIds(interaction.member),
    isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
    discordUsername: interaction.user.username,
  };
}

async function replyForbidden(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (interaction.deferred) {
      await interaction.editReply({ content: FORBIDDEN_MESSAGE, embeds: [], components: [] });
    } else if (interaction.replied) {
      await interaction.followUp({ content: FORBIDDEN_MESSAGE, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: FORBIDDEN_MESSAGE, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    if (!isIgnorableInteractionError(error)) throw error;
  }
}

/** View or change the guild's scheduled inactivity digest. Never posts it immediately. */
export async function handleInactivity(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const guildId = requireGuildId(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const actor = await requireGlobalPermission(
      interaction.user.id,
      'clubs:write',
      await permissionContext(interaction),
    );
    const subcommand = interaction.options.getSubcommand(false);

    if (subcommand === 'view') {
      const settings = await readInactivitySettings(guildId);
      await interaction.editReply({
        embeds: [buildInactivitySettingsEmbed(guildId, settings)],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'set') {
      const days = interaction.options.getInteger('days', true);
      const channel = interaction.options.getChannel('channel', false);
      const current = await readInactivitySettings(guildId);
      const settings = await updateInactivitySettings({
        guildId,
        days,
        channelId: channel === null ? current.channelId : channel.id,
        actor,
      });
      await interaction.editReply({
        embeds: [
          buildInactivitySettingsEmbed(
            guildId,
            settings,
            `Inactivity alerts enabled for **${days}+ day(s)** without a stored battle.`,
          ),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'clear-channel') {
      const current = await readInactivitySettings(guildId);
      const settings = await updateInactivitySettings({
        guildId,
        days: current.days,
        channelId: null,
        actor,
      });
      await interaction.editReply({
        embeds: [
          buildInactivitySettingsEmbed(guildId, settings, 'Inactivity report channel cleared.'),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'disable') {
      const current = await readInactivitySettings(guildId);
      const settings = await updateInactivitySettings({
        guildId,
        days: null,
        channelId: current.channelId,
        actor,
      });
      await interaction.editReply({
        embeds: [buildInactivitySettingsEmbed(guildId, settings, 'Inactivity report disabled.')],
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.editReply({
      content: 'Choose `/inactivity view`, `/inactivity set`, `/inactivity clear-channel`, or `/inactivity disable`.',
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    if (error instanceof AdminServiceError && error.code === 'forbidden') {
      await replyForbidden(interaction);
      return;
    }
    await replyAdminError(interaction, error);
  }
}
