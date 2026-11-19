import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import type { Role } from '@brawlhub/shared';
import { filterRegisteredClubs, getRegisteredClubs } from '../clubs/service';
import {
  buildRoleMappingsEmbed,
  buildSettingsUpdatedEmbed,
  buildSettingsViewEmbed,
} from '../admin/embed';
import { replyAdminError } from '../admin/errors';
import {
  AdminServiceError,
  clearGuildRoleMapping,
  listGuildRoleMappings,
  loadGuildSettings,
  requireGlobalPermission,
  setGuildRoleMapping,
  updateGuildSettings,
} from '../admin/service';
import type { AdminActor, GuildSettingsField } from '../admin/types';
import {
  buildConfirmationRow,
  parseConfirmationCustomId,
} from '../discord/confirmation-components';
import { ConfirmationStore } from '../discord/confirmations';
import { isIgnorableInteractionError } from '../discord/errors.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';

const COMMAND_NAME = 'settings';
const FORBIDDEN_MESSAGE = 'You do not have permission to manage BrawlHub guild settings.';
const NO_GUILD_MESSAGE = 'Guild settings can only be managed from within a Discord server.';
const SETUP_TTL_MS = 10 * 60 * 1000;

interface PendingSettingsChange {
  readonly actor: AdminActor;
  readonly guildId: string;
  readonly field: GuildSettingsField;
  readonly value: string | null;
  readonly label: string;
}

const pendingChanges = new ConfirmationStore<PendingSettingsChange>();

type SetupStep =
  | { kind: 'root' }
  | { kind: 'role_mappings' }
  | { kind: 'role_add_pick_discord' }
  | { kind: 'role_add_pick_brawlhub'; discordRoleId: string }
  | { kind: 'role_remove_pick' }
  | { kind: 'primary_club' }
  | { kind: 'announcement_channel' }
  | { kind: 'verified_role' };

interface SetupSession {
  readonly userId: string;
  readonly guildId: string;
  step: SetupStep;
  expiresAt: number;
}

const setupSessions = new Map<string, SetupSession>();

/** Reset ephemeral stores (used by tests). */
export function clearPendingSettingsChanges(): void {
  pendingChanges.clear();
  setupSessions.clear();
}

function createSetupSession(userId: string, guildId: string): string {
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  setupSessions.set(nonce, {
    userId,
    guildId,
    step: { kind: 'root' },
    expiresAt: Date.now() + SETUP_TTL_MS,
  });
  return nonce;
}

function getSetupSession(nonce: string, userId: string): SetupSession | null {
  const session = setupSessions.get(nonce);
  if (session === undefined) return null;
  if (session.expiresAt <= Date.now() || session.userId !== userId) {
    setupSessions.delete(nonce);
    return null;
  }
  session.expiresAt = Date.now() + SETUP_TTL_MS;
  return session;
}

export const settingsCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('View and manage settings for this Discord server')
  .addSubcommand((subcommand) =>
    subcommand.setName('view').setDescription('Show the current guild settings'),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('setup').setDescription('Open the interactive per-guild setup menu'),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('roles-view').setDescription('Show Discord role to BrawlHub role mappings'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('set-role-mapping')
      .setDescription('Map a Discord role to a BrawlHub role in this server')
      .addRoleOption((option) =>
        option.setName('discord_role').setDescription('Discord role to map').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('brawlhub_role')
          .setDescription('BrawlHub role/permission level to grant')
          .setRequired(true)
          .addChoices(
            { name: 'Owner (full access)', value: 'owner' },
            { name: 'Admin (manage, no audit/staff grant)', value: 'admin' },
            { name: 'Staff (verify, competitions, notify)', value: 'staff' },
            { name: 'Member (read-only)', value: 'member' },
          ),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('clear-role-mapping')
      .setDescription('Remove a Discord role to BrawlHub role mapping')
      .addRoleOption((option) =>
        option.setName('discord_role').setDescription('Discord role mapping to remove').setRequired(true),
      ),
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

function setupCustomId(nonce: string, action: string): string {
  return `${COMMAND_NAME}:setup:${nonce}:${action}`;
}

function parseSetupCustomId(customId: string): { nonce: string; action: string } | null {
  const parts = customId.split(':');
  if (parts.length < 4 || parts[0] !== COMMAND_NAME || parts[1] !== 'setup') return null;
  const nonce = parts[2];
  const action = parts.slice(3).join(':');
  if (!nonce || !action) return null;
  return { nonce, action };
}

async function permissionContext(interaction: ChatInputCommandInteraction | CommandComponentInteraction) {
  return {
    guildId: interaction.guildId,
    memberPermissions: interaction.memberPermissions,
    memberRoleIds: getInteractionMemberRoleIds(interaction.member),
    isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
    discordUsername: interaction.user.username,
  };
}

async function buildSetupRoot(nonce: string, guildId: string) {
  const [settings, mappings] = await Promise.all([loadGuildSettings(guildId), listGuildRoleMappings(guildId)]);
  const embed = new EmbedBuilder()
    .setColor(0x5865_f2)
    .setTitle('BrawlHub server setup')
    .setDescription(
      'Configure this Discord server’s BrawlHub integration. Role mappings control which Discord roles grant BrawlHub permissions in this server (per-guild, not shared).',
    )
    .addFields(
      {
        name: 'Primary club',
        value:
          settings.primaryClubTag === null
            ? 'Not configured'
            : `${settings.primaryClubName ?? 'Club'} (#${settings.primaryClubTag})`,
        inline: true,
      },
      {
        name: 'Announcement channel',
        value: settings.announcementChannelId ? `<#${settings.announcementChannelId}>` : 'Not configured',
        inline: true,
      },
      {
        name: 'Verified role',
        value: settings.verifiedRoleId ? `<@&${settings.verifiedRoleId}>` : 'Not configured',
        inline: true,
      },
      { name: 'Role mappings', value: mappings.length === 0 ? 'None configured' : `${mappings.length} configured`, inline: true },
    );

  const menu = new StringSelectMenuBuilder()
    .setCustomId(setupCustomId(nonce, 'menu'))
    .setPlaceholder('Choose what to configure…')
    .addOptions(
      { label: 'View current settings', value: 'view', description: 'Show settings and role mappings' },
      { label: 'Manage role mappings', value: 'role_mappings', description: 'Map Discord roles to BrawlHub roles' },
      { label: 'Set/clear primary club', value: 'primary_club', description: 'Default club for this server' },
      { label: 'Set/clear announcement channel', value: 'announcement_channel', description: 'Sync/notification channel' },
      { label: 'Set/clear verified role', value: 'verified_role', description: 'Role for verified members' },
      { label: 'Close', value: 'close', description: 'Close this setup menu' },
    );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    allowedMentions: { parse: [] as const },
  };
}

async function buildRoleMappingsView(nonce: string, guildId: string, notice?: string) {
  const mappings = await listGuildRoleMappings(guildId);
  const embed = buildRoleMappingsEmbed(guildId, mappings, notice);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(setupCustomId(nonce, 'roles_action'))
    .setPlaceholder('Manage role mappings…')
    .addOptions(
      { label: 'Add or update mapping', value: 'add', description: 'Map a Discord role to a BrawlHub role' },
      { label: 'Remove mapping', value: 'remove', description: 'Remove an existing mapping' },
      { label: 'Back to setup', value: 'back', description: 'Return to the setup menu' },
    );
  return {
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    allowedMentions: { parse: [] as const },
  };
}

async function buildPrimaryClubView(nonce: string, guildId: string) {
  const [settings, clubs] = await Promise.all([loadGuildSettings(guildId), getRegisteredClubs(guildId)]);
  const embed = new EmbedBuilder()
    .setColor(0x5865_f2)
    .setTitle('Primary club')
    .setDescription(
      `Current: ${settings.primaryClubTag ? `${settings.primaryClubName ?? 'Club'} (#${settings.primaryClubTag})` : 'Not configured'}. Choose a registered club below or clear it.`,
    );
  const options = clubs.slice(0, 24).map((club) => ({
    label: `${club.name} (#${club.tag})`.slice(0, 100),
    value: club.id,
    description: 'Set as this server’s default club'.slice(0, 100),
  }));
  options.push({ label: 'Clear primary club', value: '__clear__', description: 'Remove the default club setting' });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(setupCustomId(nonce, 'primary_club_select'))
    .setPlaceholder(options.length === 1 ? 'No registered clubs yet' : 'Select a primary club…')
    .addOptions(options);
  const back = new ButtonBuilder()
    .setCustomId(setupCustomId(nonce, 'back'))
    .setLabel('Back')
    .setStyle(ButtonStyle.Secondary);
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(back),
    ],
    allowedMentions: { parse: [] as const },
  };
}

function buildChannelPickView(nonce: string, title: string, description: string, action: string, clearAction: string) {
  const select = new ChannelSelectMenuBuilder()
    .setCustomId(setupCustomId(nonce, action))
    .setPlaceholder('Select a text channel…')
    .addChannelTypes(ChannelType.GuildText);
  const clear = new ButtonBuilder()
    .setCustomId(setupCustomId(nonce, clearAction))
    .setLabel('Clear')
    .setStyle(ButtonStyle.Danger);
  const back = new ButtonBuilder()
    .setCustomId(setupCustomId(nonce, 'back'))
    .setLabel('Back')
    .setStyle(ButtonStyle.Secondary);
  return {
    embeds: [new EmbedBuilder().setColor(0x5865_f2).setTitle(title).setDescription(description)],
    components: [
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(clear, back),
    ],
    allowedMentions: { parse: [] as const },
  };
}

function buildVerifiedRolePickView(nonce: string, settings: Awaited<ReturnType<typeof loadGuildSettings>>) {
  const select = new RoleSelectMenuBuilder()
    .setCustomId(setupCustomId(nonce, 'verified_role_select'))
    .setPlaceholder('Select the verified-member role…');
  const clear = new ButtonBuilder()
    .setCustomId(setupCustomId(nonce, 'verified_role_clear'))
    .setLabel('Clear')
    .setStyle(ButtonStyle.Danger);
  const back = new ButtonBuilder()
    .setCustomId(setupCustomId(nonce, 'back'))
    .setLabel('Back')
    .setStyle(ButtonStyle.Secondary);
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865_f2)
        .setTitle('Verified role')
        .setDescription(
          `Current: ${settings.verifiedRoleId ? `<@&${settings.verifiedRoleId}>` : 'Not configured'}. Choose a Discord role to assign to verified BrawlHub members, or clear it.`,
        ),
    ],
    components: [
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(clear, back),
    ],
    allowedMentions: { parse: [] as const },
  };
}

async function startChange(
  interaction: ChatInputCommandInteraction,
  field: GuildSettingsField,
  value: string | null,
): Promise<void> {
  const guildId = requireGuildId(interaction);
  const actor = await requireGlobalPermission(interaction.user.id, 'clubs:write', await permissionContext(interaction));
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
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

export async function handleSettings(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const subcommand = interaction.options.getSubcommand(false);
    if (subcommand === 'view') {
      const guildId = requireGuildId(interaction);
      await requireGlobalPermission(interaction.user.id, 'clubs:write', await permissionContext(interaction));
      const [settings, mappings] = await Promise.all([loadGuildSettings(guildId), listGuildRoleMappings(guildId)]);
      await interaction.reply({
        embeds: [buildSettingsViewEmbed(settings, mappings)],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'setup') {
      const guildId = requireGuildId(interaction);
      await requireGlobalPermission(interaction.user.id, 'clubs:write', await permissionContext(interaction));
      const nonce = createSetupSession(interaction.user.id, guildId);
      await interaction.reply({
        ...(await buildSetupRoot(nonce, guildId)),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'roles-view') {
      const guildId = requireGuildId(interaction);
      await requireGlobalPermission(interaction.user.id, 'clubs:write', await permissionContext(interaction));
      const mappings = await listGuildRoleMappings(guildId);
      await interaction.reply({
        embeds: [buildRoleMappingsEmbed(guildId, mappings)],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'set-role-mapping') {
      const guildId = requireGuildId(interaction);
      const actor = await requireGlobalPermission(interaction.user.id, 'clubs:write', await permissionContext(interaction));
      const discordRole = interaction.options.getRole('discord_role', true);
      const brawlhubRole = interaction.options.getString('brawlhub_role', true) as Role;
      const mappings = await setGuildRoleMapping({
        actor,
        guildId,
        discordRoleId: discordRole.id,
        brawlhubRole,
      });
      await interaction.reply({
        embeds: [buildRoleMappingsEmbed(guildId, mappings, `Mapped <@&${discordRole.id}> to **${brawlhubRole}**.`)],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'clear-role-mapping') {
      const guildId = requireGuildId(interaction);
      const actor = await requireGlobalPermission(interaction.user.id, 'clubs:write', await permissionContext(interaction));
      const discordRole = interaction.options.getRole('discord_role', true);
      const mappings = await clearGuildRoleMapping({ actor, guildId, discordRoleId: discordRole.id });
      await interaction.reply({
        embeds: [buildRoleMappingsEmbed(guildId, mappings, `Removed mapping for <@&${discordRole.id}>.`)],
        flags: MessageFlags.Ephemeral,
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

    await interaction.reply({ content: 'Choose a settings subcommand.', flags: MessageFlags.Ephemeral });
  } catch (error) {
    if (error instanceof AdminServiceError && error.code === 'forbidden') {
      try {
        await interaction.reply({ content: FORBIDDEN_MESSAGE, flags: MessageFlags.Ephemeral });
      } catch (replyError) {
        if (!isIgnorableInteractionError(replyError)) throw replyError;
      }
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
    await requireGlobalPermission(interaction.user.id, 'clubs:write', {
      guildId: interaction.guildId,
      memberPermissions: interaction.memberPermissions,
      memberRoleIds: getInteractionMemberRoleIds(interaction.member),
      isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
      discordUsername: interaction.user.username,
    });
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

async function handleSettingsConfirmation(interaction: CommandComponentInteraction): Promise<boolean> {
  const action = parseConfirmationCustomId(interaction.customId, COMMAND_NAME);
  if (action === null) return false;

  await interaction.deferUpdate();
  const pending = pendingChanges.take(action.nonce, interaction.user.id);

  if (action.kind === 'cancel') {
    await interaction.editReply({ content: 'Guild settings change cancelled.', embeds: [], components: [] });
    return true;
  }

  await requireGlobalPermission(interaction.user.id, 'clubs:write', await permissionContext(interaction));
  const freshSettings = await loadGuildSettings(pending.guildId);
  const changedFields = currentValue(freshSettings, pending.field) === pending.value ? [] : [pending.field];

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
  return true;
}

async function handleSetupInteraction(interaction: CommandComponentInteraction): Promise<boolean> {
  const parsed = parseSetupCustomId(interaction.customId);
  if (parsed === null) return false;

  const session = getSetupSession(parsed.nonce, interaction.user.id);
  if (session === null) {
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: 'This setup session has expired. Run `/settings setup` again.', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: 'This setup session has expired. Run `/settings setup` again.', flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      if (!isIgnorableInteractionError(error)) throw error;
    }
    return true;
  }

  await interaction.deferUpdate();
  const actor = await requireGlobalPermission(interaction.user.id, 'clubs:write', await permissionContext(interaction));
  const guildId = session.guildId;

  const { action } = parsed;
  if (action === 'back') {
    session.step = { kind: 'root' };
    await interaction.editReply(await buildSetupRoot(parsed.nonce, guildId));
    return true;
  }

  if (action === 'menu' && interaction.isStringSelectMenu()) {
    const choice = interaction.values[0];
    if (choice === 'close') {
      setupSessions.delete(parsed.nonce);
      await interaction.editReply({ content: 'Setup menu closed.', embeds: [], components: [] });
      return true;
    }
    if (choice === 'view') {
      const [settings, mappings] = await Promise.all([loadGuildSettings(guildId), listGuildRoleMappings(guildId)]);
      const back = new ButtonBuilder().setCustomId(setupCustomId(parsed.nonce, 'back')).setLabel('Back').setStyle(ButtonStyle.Secondary);
      await interaction.editReply({
        embeds: [buildSettingsViewEmbed(settings, mappings)],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(back)],
        allowedMentions: { parse: [] },
      });
      return true;
    }
    if (choice === 'role_mappings') {
      session.step = { kind: 'role_mappings' };
      await interaction.editReply(await buildRoleMappingsView(parsed.nonce, guildId));
      return true;
    }
    if (choice === 'primary_club') {
      session.step = { kind: 'primary_club' };
      await interaction.editReply(await buildPrimaryClubView(parsed.nonce, guildId));
      return true;
    }
    if (choice === 'announcement_channel') {
      session.step = { kind: 'announcement_channel' };
      const settings = await loadGuildSettings(guildId);
      await interaction.editReply(
        buildChannelPickView(
          parsed.nonce,
          'Announcement channel',
          `Current: ${settings.announcementChannelId ? `<#${settings.announcementChannelId}>` : 'Not configured'}. Select a text channel for BrawlHub announcements, or clear it.`,
          'announcement_select',
          'announcement_clear',
        ),
      );
      return true;
    }
    if (choice === 'verified_role') {
      session.step = { kind: 'verified_role' };
      const settings = await loadGuildSettings(guildId);
      await interaction.editReply(buildVerifiedRolePickView(parsed.nonce, settings));
      return true;
    }
  }

  if (action === 'roles_action' && interaction.isStringSelectMenu()) {
    const choice = interaction.values[0];
    if (choice === 'back') {
      session.step = { kind: 'root' };
      await interaction.editReply(await buildSetupRoot(parsed.nonce, guildId));
      return true;
    }
    if (choice === 'add') {
      session.step = { kind: 'role_add_pick_discord' };
      const select = new RoleSelectMenuBuilder()
        .setCustomId(setupCustomId(parsed.nonce, 'role_add_discord'))
        .setPlaceholder('Select the Discord role to map…');
      const back = new ButtonBuilder().setCustomId(setupCustomId(parsed.nonce, 'roles_back')).setLabel('Back').setStyle(ButtonStyle.Secondary);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x5865_f2).setTitle('Add/update role mapping').setDescription('Select the Discord role (e.g. Club Leaders) you want to grant BrawlHub permissions to in this server.')],
        components: [
          new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select),
          new ActionRowBuilder<ButtonBuilder>().addComponents(back),
        ],
      });
      return true;
    }
    if (choice === 'remove') {
      const mappings = await listGuildRoleMappings(guildId);
      if (mappings.length === 0) {
        session.step = { kind: 'role_mappings' };
        await interaction.editReply(await buildRoleMappingsView(parsed.nonce, guildId, 'No mappings to remove.'));
        return true;
      }
      session.step = { kind: 'role_remove_pick' };
      const options = mappings.slice(0, 25).map((m) => ({
        label: `${m.brawlhubRole}`.slice(0, 100),
        value: m.discordRoleId,
        description: `Remove mapping for role ID ${m.discordRoleId}`.slice(0, 100),
      }));
      const select = new StringSelectMenuBuilder()
        .setCustomId(setupCustomId(parsed.nonce, 'role_remove_select'))
        .setPlaceholder('Select a mapping to remove…')
        .addOptions(options);
      const back = new ButtonBuilder().setCustomId(setupCustomId(parsed.nonce, 'roles_back')).setLabel('Back').setStyle(ButtonStyle.Secondary);
      await interaction.editReply({
        embeds: [buildRoleMappingsEmbed(guildId, mappings, 'Select the Discord role mapping to remove.')],
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
          new ActionRowBuilder<ButtonBuilder>().addComponents(back),
        ],
      });
      return true;
    }
  }

  if (action === 'roles_back') {
    session.step = { kind: 'role_mappings' };
    await interaction.editReply(await buildRoleMappingsView(parsed.nonce, guildId));
    return true;
  }

  if (action === 'role_add_discord' && interaction.isRoleSelectMenu()) {
    const discordRoleId = interaction.values[0];
    if (!discordRoleId) return true;
    session.step = { kind: 'role_add_pick_brawlhub', discordRoleId };
    const select = new StringSelectMenuBuilder()
      .setCustomId(setupCustomId(parsed.nonce, 'role_add_brawlhub'))
      .setPlaceholder('Choose the BrawlHub role to grant…')
      .addOptions(
        { label: 'Owner (full access)', value: 'owner', description: 'Full BrawlHub permissions in this server' },
        { label: 'Admin', value: 'admin', description: 'Manage clubs/sync/settings (no audit/staff grant)' },
        { label: 'Staff', value: 'staff', description: 'Verify members, competitions, notifications' },
        { label: 'Member', value: 'member', description: 'Read-only BrawlHub access' },
      );
    const back = new ButtonBuilder().setCustomId(setupCustomId(parsed.nonce, 'roles_back')).setLabel('Back').setStyle(ButtonStyle.Secondary);
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x5865_f2).setTitle('Choose BrawlHub role').setDescription(`Selected Discord role: <@&${discordRoleId}>. Choose which BrawlHub role/permission level it should grant in this server.`)],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
        new ActionRowBuilder<ButtonBuilder>().addComponents(back),
      ],
    });
    return true;
  }

  if (action === 'role_add_brawlhub' && interaction.isStringSelectMenu() && session.step.kind === 'role_add_pick_brawlhub') {
    const brawlhubRole = interaction.values[0] as Role;
    const discordRoleId = session.step.discordRoleId;
    const mappings = await setGuildRoleMapping({ actor, guildId, discordRoleId, brawlhubRole });
    session.step = { kind: 'role_mappings' };
    await interaction.editReply(await buildRoleMappingsView(parsed.nonce, guildId, `Mapped <@&${discordRoleId}> to **${brawlhubRole}**.`));
    return true;
  }

  if (action === 'role_remove_select' && interaction.isStringSelectMenu()) {
    const discordRoleId = interaction.values[0];
    if (!discordRoleId) return true;
    const mappings = await clearGuildRoleMapping({ actor, guildId, discordRoleId });
    session.step = { kind: 'role_mappings' };
    await interaction.editReply(await buildRoleMappingsView(parsed.nonce, guildId, `Removed mapping for <@&${discordRoleId}>.`));
    return true;
  }

  if (action === 'primary_club_select' && interaction.isStringSelectMenu()) {
    const selected = interaction.values[0];
    const value = selected === undefined || selected === '__clear__' ? null : selected;
    const updated = await updateGuildSettings({
      actor,
      guildId,
      field: 'primaryClubId',
      value,
    });
    session.step = { kind: 'root' };
    const embed = buildSettingsUpdatedEmbed(updated, ['primaryClubId']);
    const back = new ButtonBuilder().setCustomId(setupCustomId(parsed.nonce, 'back')).setLabel('Back to setup').setStyle(ButtonStyle.Secondary);
    await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(back)], allowedMentions: { parse: [] } });
    return true;
  }

  if (action === 'announcement_select' && interaction.isChannelSelectMenu()) {
    const channelId = interaction.values[0];
    if (!channelId) return true;
    const updated = await updateGuildSettings({ actor, guildId, field: 'announcementChannelId', value: channelId });
    const back = new ButtonBuilder().setCustomId(setupCustomId(parsed.nonce, 'back')).setLabel('Back to setup').setStyle(ButtonStyle.Secondary);
    await interaction.editReply({ embeds: [buildSettingsUpdatedEmbed(updated, ['announcementChannelId'])], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(back)], allowedMentions: { parse: [] } });
    return true;
  }
  if (action === 'announcement_clear' && interaction.isButton()) {
    const updated = await updateGuildSettings({ actor, guildId, field: 'announcementChannelId', value: null });
    const back = new ButtonBuilder().setCustomId(setupCustomId(parsed.nonce, 'back')).setLabel('Back to setup').setStyle(ButtonStyle.Secondary);
    await interaction.editReply({ embeds: [buildSettingsUpdatedEmbed(updated, ['announcementChannelId'])], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(back)], allowedMentions: { parse: [] } });
    return true;
  }

  if (action === 'verified_role_select' && interaction.isRoleSelectMenu()) {
    const roleId = interaction.values[0];
    if (!roleId) return true;
    const updated = await updateGuildSettings({ actor, guildId, field: 'verifiedRoleId', value: roleId });
    const back = new ButtonBuilder().setCustomId(setupCustomId(parsed.nonce, 'back')).setLabel('Back to setup').setStyle(ButtonStyle.Secondary);
    await interaction.editReply({ embeds: [buildSettingsUpdatedEmbed(updated, ['verifiedRoleId'])], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(back)], allowedMentions: { parse: [] } });
    return true;
  }
  if (action === 'verified_role_clear' && interaction.isButton()) {
    const updated = await updateGuildSettings({ actor, guildId, field: 'verifiedRoleId', value: null });
    const back = new ButtonBuilder().setCustomId(setupCustomId(parsed.nonce, 'back')).setLabel('Back to setup').setStyle(ButtonStyle.Secondary);
    await interaction.editReply({ embeds: [buildSettingsUpdatedEmbed(updated, ['verifiedRoleId'])], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(back)], allowedMentions: { parse: [] } });
    return true;
  }

  // Fallback: unknown action, return to root
  session.step = { kind: 'root' };
  await interaction.editReply(await buildSetupRoot(parsed.nonce, guildId));
  return true;
}

export async function handleSettingsComponent(interaction: CommandComponentInteraction): Promise<void> {
  try {
    if (await handleSettingsConfirmation(interaction)) return;
    if (await handleSetupInteraction(interaction)) return;
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}
