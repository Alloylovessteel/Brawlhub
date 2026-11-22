import { mdCode, mdLabelLines, mdParagraphs, mdSection } from '../discord/embed-format';
import { EMBED_COLORS } from '../discord/embed-style';
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
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Role } from '@brawlhub/shared';
import { createLogger } from '@brawlhub/logging';
import { refreshOverviewNow } from '../clubs/overview/service';
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

const logger = createLogger('bot');
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
      .setName('set-overview-channel')
      .setDescription('Set the channel for the auto-updating club stats overview')
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Text channel that receives the club overview')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('clear-overview-channel')
      .setDescription('Stop posting the club overview in this server'),
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
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('set-report-channel')
      .setDescription('Set a channel for one of the scheduled club reports')
      .addStringOption((option) =>
        option
          .setName('report_type')
          .setDescription('Which scheduled report to configure')
          .setRequired(true)
          .addChoices(
            { name: 'Daily', value: 'daily' },
            { name: 'Weekly', value: 'weekly' },
            { name: 'Monthly', value: 'monthly' },
          ),
      )
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Text channel that receives this report')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('clear-report-channel')
      .setDescription('Send one scheduled report back to the overview channel')
      .addStringOption((option) =>
        option
          .setName('report_type')
          .setDescription('Which scheduled report to reset')
          .setRequired(true)
          .addChoices(
            { name: 'Daily', value: 'daily' },
            { name: 'Weekly', value: 'weekly' },
            { name: 'Monthly', value: 'monthly' },
          ),
      ),
  );

const FIELD_LABELS: Readonly<Record<GuildSettingsField, string>> = {
  announcementChannelId: 'Announcement channel',
  verifiedRoleId: 'Verified role',
  overviewChannelId: 'Overview channel',
  reportDailyChannelId: 'Daily report channel',
  reportWeeklyChannelId: 'Weekly report channel',
  reportMonthlyChannelId: 'Monthly report channel',
};

const REPORT_TYPE_FIELDS: Readonly<Record<string, GuildSettingsField>> = {
  daily: 'reportDailyChannelId',
  weekly: 'reportWeeklyChannelId',
  monthly: 'reportMonthlyChannelId',
};

function reportField(reportType: string): GuildSettingsField {
  const field = REPORT_TYPE_FIELDS[reportType];
  if (field === undefined) {
    throw new AdminServiceError('invalid_channel', 'Choose daily, weekly, or monthly.');
  }
  return field;
}

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
  if (field === 'announcementChannelId') return settings.announcementChannelId;
  if (field === 'overviewChannelId') return settings.overviewChannelId;
  if (field === 'reportDailyChannelId') return settings.reportDailyChannelId;
  if (field === 'reportWeeklyChannelId') return settings.reportWeeklyChannelId;
  if (field === 'reportMonthlyChannelId') return settings.reportMonthlyChannelId;
  return settings.verifiedRoleId;
}

function displayValue(field: GuildSettingsField, value: string | null): string {
  if (value === null) {
    return field.startsWith('report') ? 'Overview channel (fallback)' : 'Not configured';
  }
  if (
    field === 'announcementChannelId' ||
    field === 'overviewChannelId' ||
    field.startsWith('report')
  ) {
    return `<#${value}>`;
  }
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
    .setColor(EMBED_COLORS.neutral)
    .setTitle('BrawlHub server setup')
    .setDescription(
      mdSection(
        'Overview',
        mdParagraphs(
          'Configure this Discord server’s BrawlHub integration.',
          'Role mappings control which Discord roles grant BrawlHub permissions in this server (per-guild, not shared).',
        ),
      ),
    )
    .addFields(
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
    embeds: [new EmbedBuilder().setColor(EMBED_COLORS.neutral).setTitle(title).setDescription(description)],
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
        .setColor(EMBED_COLORS.neutral)
        .setTitle('Verified role')
        .setDescription(
          mdParagraphs(
            mdLabelLines([
              `Current: ${settings.verifiedRoleId ? `<@&${settings.verifiedRoleId}>` : 'Not configured'}.`,
            ]),
            'Choose a Discord role to assign to verified BrawlHub members, or clear it.',
          ),
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
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
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
    .setColor(EMBED_COLORS.warning)
    .setTitle('Confirm guild settings change')
    .addFields(
      { name: 'Guild', value: `\`${guildId}\`` },
      { name: 'Setting', value: FIELD_LABELS[field] },
      { name: 'New value', value: displayValue(field, value) },
      { name: 'Current value', value: displayValue(field, currentValue(settings, field)) },
    );

  await interaction.editReply({
    embeds: [confirmation],
    components: [buildConfirmationRow(COMMAND_NAME, nonce)],
    allowedMentions: { parse: [] },
  });
}

export async function handleSettings(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const subcommand = interaction.options.getSubcommand(false);
    if (subcommand === 'view') {
      const guildId = requireGuildId(interaction);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await requireGlobalPermission(interaction.user.id, 'clubs:write', await permissionContext(interaction));
      const [settings, mappings] = await Promise.all([loadGuildSettings(guildId), listGuildRoleMappings(guildId)]);
      await interaction.editReply({
        embeds: [buildSettingsViewEmbed(settings, mappings)],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'setup') {
      const guildId = requireGuildId(interaction);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await requireGlobalPermission(interaction.user.id, 'clubs:write', await permissionContext(interaction));
      const nonce = createSetupSession(interaction.user.id, guildId);
      await interaction.editReply({
        ...(await buildSetupRoot(nonce, guildId)),
      });
      return;
    }

    if (subcommand === 'roles-view') {
      const guildId = requireGuildId(interaction);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await requireGlobalPermission(interaction.user.id, 'clubs:write', await permissionContext(interaction));
      const mappings = await listGuildRoleMappings(guildId);
      await interaction.editReply({
        embeds: [buildRoleMappingsEmbed(guildId, mappings)],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'set-role-mapping') {
      const guildId = requireGuildId(interaction);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const actor = await requireGlobalPermission(interaction.user.id, 'clubs:write', await permissionContext(interaction));
      const discordRole = interaction.options.getRole('discord_role', true);
      const brawlhubRole = interaction.options.getString('brawlhub_role', true) as Role;
      const mappings = await setGuildRoleMapping({
        actor,
        guildId,
        discordRoleId: discordRole.id,
        brawlhubRole,
      });
      await interaction.editReply({
        embeds: [buildRoleMappingsEmbed(guildId, mappings, `Mapped <@&${discordRole.id}> to **${brawlhubRole}**.`)],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'clear-role-mapping') {
      const guildId = requireGuildId(interaction);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const actor = await requireGlobalPermission(interaction.user.id, 'clubs:write', await permissionContext(interaction));
      const discordRole = interaction.options.getRole('discord_role', true);
      const mappings = await clearGuildRoleMapping({ actor, guildId, discordRoleId: discordRole.id });
      await interaction.editReply({
        embeds: [buildRoleMappingsEmbed(guildId, mappings, `Removed mapping for <@&${discordRole.id}>.`)],
        allowedMentions: { parse: [] },
      });
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
    if (subcommand === 'set-overview-channel') {
      await startChange(interaction, 'overviewChannelId', interaction.options.getChannel('channel', true).id);
      return;
    }
    if (subcommand === 'clear-overview-channel') {
      await startChange(interaction, 'overviewChannelId', null);
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
    if (subcommand === 'set-report-channel') {
      await startChange(
        interaction,
        reportField(interaction.options.getString('report_type', true)),
        interaction.options.getChannel('channel', true).id,
      );
      return;
    }
    if (subcommand === 'clear-report-channel') {
      await startChange(
        interaction,
        reportField(interaction.options.getString('report_type', true)),
        null,
      );
      return;
    }

    await interaction.reply({ content: 'Choose a settings subcommand.', flags: MessageFlags.Ephemeral });
  } catch (error) {
    if (error instanceof AdminServiceError && error.code === 'forbidden') {
      const message = FORBIDDEN_MESSAGE;
      try {
        if (interaction.deferred) {
          await interaction.editReply({ content: message, embeds: [], components: [] });
        } else if (interaction.replied) {
          await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
      } catch (replyError) {
        if (!isIgnorableInteractionError(replyError)) throw replyError;
      }
      return;
    }
    await replyAdminError(interaction, error);
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

  let overviewNotice: string | undefined;
  if (pending.field === 'overviewChannelId' && updated.overviewChannelId !== null) {
    try {
      const outcome = await refreshOverviewNow(updated.guildId, {
        label: interaction.guild?.name ?? null,
        iconUrl: interaction.guild?.iconURL() ?? null,
      });
      overviewNotice = outcome.posted
        ? `Club overview posted to <#${updated.overviewChannelId}>.`
        : 'Club overview could not be posted right now; it will retry on the next refresh.';
    } catch (error) {
      logger.warn('Could not post club overview immediately after configuration', {
        guildId: updated.guildId,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      overviewNotice = 'Club overview will be posted on the next refresh.';
    }
  }

  await interaction.editReply({
    ...(overviewNotice === undefined ? {} : { content: overviewNotice }),
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
    if (choice === 'announcement_channel') {
      session.step = { kind: 'announcement_channel' };
      const settings = await loadGuildSettings(guildId);
      await interaction.editReply(
        buildChannelPickView(
          parsed.nonce,
          'Announcement channel',
          mdParagraphs(
            mdLabelLines([
              `Current: ${settings.announcementChannelId ? `<#${settings.announcementChannelId}>` : 'Not configured'}.`,
            ]),
            'Select a text channel for BrawlHub announcements, or clear it.',
          ),
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
        embeds: [new EmbedBuilder().setColor(EMBED_COLORS.neutral).setTitle('Add/update role mapping').setDescription(`Select the Discord role (e.g. ${mdCode('Club Leaders')}) you want to grant BrawlHub permissions to in this server.`)],
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
      embeds: [new EmbedBuilder().setColor(EMBED_COLORS.neutral).setTitle('Choose BrawlHub role').setDescription(
        mdParagraphs(
          mdLabelLines([`Selected Discord role: <@&${discordRoleId}>.`]),
          'Choose which BrawlHub role/permission level it should grant in this server.',
        ),
      )],
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
