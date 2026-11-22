import {
  AttachmentBuilder,
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
import { buildClubLogPageImage } from '../clubs/logs/image';
import {
  CLUB_LOG_PERIOD_LABELS,
  isClubLogPeriod,
  loadClubLogView,
} from '../clubs/logs/page-view';
import {
  addClubLog,
  loadClubLogs,
  loadRecentClubLogEvents,
  removeClubLog,
} from '../clubs/logs/service';
import {
  isIgnorableInteractionError,
  respondToAutocomplete,
  respondWithLookupUnavailableChoice,
} from '../discord/errors.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';
import type { ClubLogPeriod } from '../clubs/types';

const COMMAND_NAME = 'clublogs';
const FORBIDDEN_MESSAGE = 'You do not have permission to manage club logs in this server.';
const NO_GUILD_MESSAGE = 'Club logs can only be managed from within a Discord server.';
const PERIOD_CHOICES = [
  { name: 'Daily (Today)', value: 'today' },
  { name: 'Weekly (This Week)', value: 'week' },
  { name: 'Season', value: 'season' },
] as const;

function safeText(value: string, maximum: number): string {
  const sanitized = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/<[@#&](?:!?\d+|everyone|here)>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const text = sanitized === '' ? 'Club' : sanitized;
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

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
    )
    .addStringOption((option) => {
      option.setName('period').setDescription('Trophy progression period (default: daily)').setRequired(false);
      for (const choice of PERIOD_CHOICES) option.addChoices(choice);
      return option;
    }),
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
    )
    .addStringOption((option) => {
      option.setName('period').setDescription('Remove only this period (default: all periods)').setRequired(false);
      for (const choice of PERIOD_CHOICES) option.addChoices(choice);
      return option;
    }),
);
commandBuilder.addSubcommand((subcommand) =>
  subcommand.setName('list').setDescription('Show this server’s club log configuration'),
);
commandBuilder.addSubcommand((subcommand) => {
  subcommand
    .setName('preview')
    .setDescription('Post a configured club log page image in this channel')
    .addStringOption((option) =>
      option
        .setName('club')
        .setDescription('Configured club log to preview')
        .setAutocomplete(true)
        .setRequired(true),
    )
    .addStringOption((option) => {
      option.setName('period').setDescription('Trophy progression period').setRequired(false);
      for (const choice of PERIOD_CHOICES) {
        option.addChoices(choice);
      }
      return option;
    });
  return subcommand;
});

export const clubLogsCommandData: SlashCommandBuilder = commandBuilder;

function requireGuildId(interaction: { guildId: string | null }): string {
  if (interaction.guildId === null || interaction.guildId.trim() === '') {
    throw new AdminServiceError('invalid_guild', NO_GUILD_MESSAGE);
  }
  return interaction.guildId;
}

function selectedPeriod(interaction: ChatInputCommandInteraction): ClubLogPeriod | null {
  const raw = interaction.options.getString('period', false);
  return raw !== null && isClubLogPeriod(raw) ? raw : null;
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
      const period = selectedPeriod(interaction) ?? 'today';
      const logs = await addClubLog({ actor, guildId, clubId, channelId: channel.id, period });
      await interaction.editReply({
        embeds: [
          buildClubLogsConfigEmbed({
            guildId,
            logs,
            notice: `Club log configured for <#${channel.id}> (${CLUB_LOG_PERIOD_LABELS[period]}).`,
          }),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'remove') {
      const clubId = interaction.options.getString('club', true);
      const period = selectedPeriod(interaction);
      const logs = await removeClubLog({ actor, guildId, clubId, period });
      await interaction.editReply({
        embeds: [
          buildClubLogsConfigEmbed({
            guildId,
            logs,
            notice:
              period === null
                ? 'Club logs removed.'
                : `${CLUB_LOG_PERIOD_LABELS[period]} club log removed.`,
          }),
        ],
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

    if (subcommand === 'preview') {
      const clubId = interaction.options.getString('club', true);
      const logs = await loadClubLogs(guildId);
      const log = logs.find((candidate) => candidate.clubId === clubId);
      if (log === undefined) {
        await interaction.editReply({
          content: 'That club log is not configured in this server.',
          embeds: [],
          components: [],
          allowedMentions: { parse: [] },
        });
        return;
      }

      const rawPeriod = interaction.options.getString('period', false);
      const period = rawPeriod !== null && isClubLogPeriod(rawPeriod) ? rawPeriod : 'today';
      const page = await loadClubLogView({ guildId, tag: log.clubTag, period });
      if (page.kind !== 'ok') {
        await interaction.editReply({
          content: 'Stored data for that club is not available in this server.',
          embeds: [],
          components: [],
          allowedMentions: { parse: [] },
        });
        return;
      }

      const groups = await loadRecentClubLogEvents(guildId, log.id);
      const image = await buildClubLogPageImage(page.value, groups[0]?.events ?? []);
      const filename = `club-log-preview-${log.clubTag.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'club'}.png`;
      await interaction.followUp({
        content: `${safeText(log.clubName, 60)} • Club Logs / Trophy Progression / ${CLUB_LOG_PERIOD_LABELS[period]}`,
        files: [new AttachmentBuilder(image, { name: filename })],
        allowedMentions: { parse: [] },
      });
      await interaction.editReply({
        content: 'Full club-log page preview posted publicly in this channel.',
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.editReply({
      content: 'Choose `/clubs clublogs add`, `/clubs clublogs remove`, `/clubs clublogs list`, or `/clubs clublogs preview`.',
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
    await respondToAutocomplete(interaction, []);
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
    await respondToAutocomplete(interaction, choices);
  } catch (error) {
    if (error instanceof AdminServiceError && error.code === 'forbidden') {
      await respondToAutocomplete(interaction, []);
      return;
    }
    await respondWithLookupUnavailableChoice(interaction);
  }
}

/** This command uses no message components; the router still requires the hook. */
export async function handleClubLogsComponent(
  _interaction: CommandComponentInteraction,
): Promise<void> {
  void _interaction;
}
