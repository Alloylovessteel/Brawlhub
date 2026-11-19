import { ChannelType, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import {
  filterRegisteredClubs,
  getRegisteredClubs,
} from '../clubs/service';
import {
  buildSettingsUpdatedEmbed,
  buildSettingsViewEmbed,
} from '../admin/embed';
import { replyAdminError } from '../admin/errors';
import {
  AdminServiceError,
  loadGuildSettings,
  requireGlobalPermission,
  updateGuildSettings,
} from '../admin/service';
import type { AdminActor, GuildSettingsField } from '../admin/types';
import {
  buildConfirmationRow,
  parseConfirmationCustomId,
} from '../discord/confirmation-components';
import { ConfirmationStore } from '../discord/confirmations';

const COMMAND_NAME = 'settings';
const FORBIDDEN_MESSAGE = 'You do not have permission to manage BrawlHub guild settings.';
const NO_GUILD_MESSAGE = 'Guild settings can only be managed from within a Discord server.';

interface PendingSettingsChange {
  readonly actor: AdminActor;
  readonly guildId: string;
  readonly field: GuildSettingsField;
  readonly value: string | null;
  readonly label: string;
}

const pendingChanges = new ConfirmationStore<PendingSettingsChange>();

/** Reset the ephemeral confirmation store (used by tests). */
export function clearPendingSettingsChanges(): void {
  pendingChanges.clear();
}

export const settingsCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('View and manage settings for this Discord server')
  .addSubcommand((subcommand) =>
    subcommand.setName('view').setDescription('Show the current guild settings'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('set-primary-club')
      .setDescription('Set the guild default club')
      .addStringOption((option) =>
        option
          .setName('club')
          .setDescription('Registered club to use as the default')
          .setAutocomplete(true)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('clear-primary-club').setDescription('Clear the guild default club'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('set-announcement-channel')
      .setDescription('Set the guild announcement channel')
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Text channel used for BrawlHub announcements')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('clear-announcement-channel')
      .setDescription('Clear the guild announcement channel'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('set-verified-role')
      .setDescription('Set the guild verified-member role')
      .addRoleOption((option) =>
        option
          .setName('role')
          .setDescription('Role assigned to verified BrawlHub members')
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('clear-verified-role').setDescription('Clear the guild verified-member role'),
  );

const FIELD_LABELS: Readonly<Record<GuildSettingsField, string>> = {
  primaryClubId: 'Primary club',
  announcementChannelId: 'Announcement channel',
  verifiedRoleId: 'Verified role',
};

function requireGuildId(interaction: { guildId: string | null }): string {
  if (interaction.guildId === null) {
    throw new AdminServiceError('invalid_guild', NO_GUILD_MESSAGE);
  }
  return interaction.guildId;
}

function currentValue(
  settings: Awaited<ReturnType<typeof loadGuildSettings>>,
  field: GuildSettingsField,
): string | null {
  if (field === 'primaryClubId') return settings.primaryClubId;
  if (field === 'announcementChannelId') return settings.announcementChannelId;
  return settings.verifiedRoleId;
}

function displayValue(field: GuildSettingsField, value: string | null): string {
  if (value === null) return 'Not configured';
  if (field === 'announcementChannelId') return `<#${value}>`;
  if (field === 'verifiedRoleId') return `<@&${value}>`;
  return `\`${value}\``;
}

async function startChange(
  interaction: ChatInputCommandInteraction,
  field: GuildSettingsField,
  value: string | null,
): Promise<void> {
  const guildId = requireGuildId(interaction);
  const actor = await requireGlobalPermission(interaction.user.id, 'clubs:write');
  const settings = await loadGuildSettings(guildId);

  const nonce = pendingChanges.create(interaction.user.id, {
    actor,
    guildId,
    field,
    value,
    label: FIELD_LABELS[field],
  });

  const confirmation = new EmbedBuilder()
    .setColor(0x5865_f2)
    .setTitle('Confirm guild settings change')
    .addFields(
      { name: 'Guild', value: `\`${guildId}\`` },
      { name: 'Setting', value: FIELD_LABELS[field] },
      { name: 'New value', value: displayValue(field, value) },
      { name: 'Current value', value: displayValue(field, currentValue(settings, field)) },
    );

  await interaction.reply({
    embeds: [confirmation],
    components: [buildConfirmationRow(COMMAND_NAME, nonce)],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

export async function handleSettings(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const subcommand = interaction.options.getSubcommand(false);
    if (subcommand === 'view') {
      const guildId = requireGuildId(interaction);
      await requireGlobalPermission(interaction.user.id, 'clubs:write');
      const settings = await loadGuildSettings(guildId);
      await interaction.reply({
        embeds: [buildSettingsViewEmbed(settings)],
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'set-primary-club') {
      await startChange(interaction, 'primaryClubId', interaction.options.getString('club', true));
      return;
    }
    if (subcommand === 'clear-primary-club') {
      await startChange(interaction, 'primaryClubId', null);
      return;
    }
    if (subcommand === 'set-announcement-channel') {
      await startChange(interaction, 'announcementChannelId', interaction.options.getChannel('channel', true).id);
      return;
    }
    if (subcommand === 'clear-announcement-channel') {
      await startChange(interaction, 'announcementChannelId', null);
      return;
    }
    if (subcommand === 'set-verified-role') {
      await startChange(interaction, 'verifiedRoleId', interaction.options.getRole('role', true).id);
      return;
    }
    if (subcommand === 'clear-verified-role') {
      await startChange(interaction, 'verifiedRoleId', null);
      return;
    }

    await interaction.reply({ content: 'Choose a settings subcommand.', ephemeral: true });
  } catch (error) {
    if (error instanceof AdminServiceError && error.code === 'forbidden') {
      await interaction.reply({ content: FORBIDDEN_MESSAGE, ephemeral: true });
      return;
    }
    await replyAdminError(interaction, error);
  }
}

export async function handleSettingsAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'club') {
    await interaction.respond([]);
    return;
  }
  try {
    if (interaction.guildId === null) {
      await interaction.respond([]);
      return;
    }
    await requireGlobalPermission(interaction.user.id, 'clubs:write');
    const clubs = await getRegisteredClubs(interaction.guildId);
    const choices = filterRegisteredClubs(clubs, String(focused.value)).map((club) => ({
      name: `${club.name} (#${club.tag})`,
      value: club.id,
    }));
    await interaction.respond(choices);
  } catch {
    await interaction.respond([]).catch(() => undefined);
  }
}

export async function handleSettingsComponent(interaction: ButtonInteraction): Promise<void> {
  const action = parseConfirmationCustomId(interaction.customId, COMMAND_NAME);
  if (action === null) return;

  try {
    await interaction.deferUpdate();
    const pending = pendingChanges.take(action.nonce, interaction.user.id);

    if (action.kind === 'cancel') {
      await interaction.editReply({ content: 'Guild settings change cancelled.', embeds: [], components: [] });
      return;
    }

    await requireGlobalPermission(interaction.user.id, 'clubs:write');
    const freshSettings = await loadGuildSettings(pending.guildId);
    const changedFields =
      currentValue(freshSettings, pending.field) === pending.value ? [] : [pending.field];

    const updated = await updateGuildSettings({
      actor: pending.actor,
      guildId: pending.guildId,
      field: pending.field,
      value: pending.value,
    });

    await interaction.editReply({
      embeds: [buildSettingsUpdatedEmbed(updated, changedFields)],
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}
