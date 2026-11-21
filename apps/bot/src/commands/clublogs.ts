import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { replyAdminError } from '../admin/errors';
import { AdminServiceError, requireGlobalPermission } from '../admin/service';
import { filterRegisteredClubs, getRegisteredClubs } from '../clubs/service';
import { buildClubLogsConfigEmbed } from '../clubs/logs/embed';
import { addClubLog, loadClubLogs, removeClubLog } from '../clubs/logs/service';
import { isIgnorableInteractionError } from '../discord/errors.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';

const COMMAND_NAME = 'clublogs';
const FORBIDDEN_MESSAGE = 'You do not have permission to manage club logs in this server.';
const NO_GUILD_MESSAGE = 'Club logs can only be managed from within a Discord server.';

const commandBuilder = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Configure club change logs for this server');

// Keep the exported type as SlashCommandBuilder; discord.js narrows the return
// type of addSubcommand() but the builder instance itself is unchanged.
commandBuilder.addSubcommand((subcommand) =>
  subcommand
    .setName('add')
    .setDescription('Send a registered club’s changes to a text channel')
    .addStringOption((option) =>
      option
        .setName('club')
        .setDescription('Registered club to log')
        .setAutocomplete(true)
        .setRequired(true),
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Text channel that receives the club log')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    ),
);
commandBuilder.addSubcommand((subcommand) =>
  subcommand
    .setName('remove')
    .setDescription('Stop logging a registered club in this server')
    .addStringOption((option) =>
      option
        .setName('club')
        .setDescription('Registered club to stop logging')
        .setAutocomplete(true)
        .setRequired(true),
    ),
);
commandBuilder.addSubcommand((subcommand) =>
  subcommand.setName('list').setDescription('Show this server’s club log configuration'),
);

export const clubLogsCommandData: SlashCommandBuilder = commandBuilder;

function requireGuildId(interaction: { guildId: string | null }): string {
  if (interaction.guildId === null || interaction.guildId.trim() === '') {
    throw new AdminServiceError('invalid_guild', NO_GUILD_MESSAGE);
  }
  return interaction.guildId;
}

async function permissionContext(
  interaction: ChatInputCommandInteraction | CommandComponentInteraction,
) {
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

export async function handleClubLogs(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const guildId = requireGuildId(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const actor = await requireGlobalPermission(
      interaction.user.id,
      'clubs:write',
      await permissionContext(interaction),
    );
    const subcommand = interaction.options.getSubcommand(false);

    if (subcommand === 'add') {
      const clubId = interaction.options.getString('club', true);
      const channel = interaction.options.getChannel('channel', true);
      const logs = await addClubLog({ actor, guildId, clubId, channelId: channel.id });
      await interaction.editReply({
        embeds: [
          buildClubLogsConfigEmbed({
            guildId,
            logs,
            notice: `Club log configured for <#${channel.id}>.`,
          }),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'remove') {
      const clubId = interaction.options.getString('club', true);
      const logs = await removeClubLog({ actor, guildId, clubId });
      await interaction.editReply({
        embeds: [buildClubLogsConfigEmbed({ guildId, logs, notice: 'Club log removed.' })],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'list') {
      const logs = await loadClubLogs(guildId);
      await interaction.editReply({
        embeds: [buildClubLogsConfigEmbed({ guildId, logs })],
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.editReply({
      content: 'Choose `/clubs logs add`, `/clubs logs remove`, or `/clubs logs list`.',
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

export async function handleClubLogsAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'club') {
    await interaction.respond([]);
    return;
  }
  try {
    const guildId = requireGuildId(interaction);
    await requireGlobalPermission(interaction.user.id, 'clubs:write', {
      guildId,
      memberPermissions: interaction.memberPermissions,
      memberRoleIds: getInteractionMemberRoleIds(interaction.member),
      isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
      discordUsername: interaction.user.username,
    });
    const clubs = await getRegisteredClubs(guildId);
    const choices = filterRegisteredClubs(clubs, String(focused.value)).map((club) => ({
      name: `${club.name} (#${club.tag})`,
      value: club.id,
    }));
    await interaction.respond(choices);
  } catch {
    await interaction.respond([]).catch(() => undefined);
  }
}

/** This command uses no message components; the router still requires the hook. */
export async function handleClubLogsComponent(
  _interaction: CommandComponentInteraction,
): Promise<void> {
  void _interaction;
}
