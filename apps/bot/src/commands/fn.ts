import { createLogger } from '@brawlhub/logging';
import { mdCode, mdLabelLines } from '../discord/embed-format';
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
import { getInteractionMemberRoleIds } from '../discord/permissions.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { replyExpiredComponent } from '../discord/errors.js';
import {
  loadGuildNicknameSettings,
  releaseManagedNicknamesAfterDisable,
  saveGuildNicknameSettings,
  syncMemberNickname,
} from '../nickname-sync/service.js';
import {
  loadGuildRankedRoleState,
  RANKED_TIERS,
  refreshMemberRankedRole,
  saveGuildRankedRoleMapping,
  type RankedTier,
} from '../ranked-roles/service.js';

const logger = createLogger('bot/fn');
const EMBED_COLOR = EMBED_COLORS.neutral;
const SUCCESS_COLOR = EMBED_COLORS.success;

export const fnCommandData = new SlashCommandBuilder()
  .setName('fn')
  .setDescription('View and manage BrawlHub ranked roles')
  .addSubcommand((subcommand) =>
    subcommand.setName('list').setDescription('Show this server’s ranked role setup'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('set')
      .setDescription('Set the Discord role for one official ranked tier')
      .addStringOption((option) =>
        option
          .setName('tier')
          .setDescription('Official ranked tier')
          .setRequired(true)
          .addChoices(...RANKED_TIERS.map((tier) => ({ name: tier, value: tier }))),
      )
      .addRoleOption((option) =>
        option.setName('role').setDescription('Discord role to use').setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('me')
      .setDescription('Refresh your ranked role from your verified main account'),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('nickname')
      .setDescription('Configure automatic verified-player nicknames')
      .addSubcommand((subcommand) =>
        subcommand.setName('view').setDescription('Show this server’s nickname sync settings'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('set')
          .setDescription('Set the club-tag prefix used in verified member nicknames')
          .addStringOption((option) =>
            option
              .setName('prefix')
              .setDescription('Prefix such as [TAG]; brackets are kept as typed')
              .setRequired(true)
              .setMaxLength(16),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('clear')
          .setDescription('Remove the prefix; nicknames become player names only'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('enable')
          .setDescription('Enable automatic nickname sync in this server'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('disable')
          .setDescription('Disable automatic nickname sync in this server'),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('me')
          .setDescription('Refresh your own nickname from your verified main account'),
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

async function requireGuild(interaction: ChatInputCommandInteraction): Promise<string | null> {
  if (interaction.guild === null || interaction.guildId === null) {
    await interaction.reply({
      content: 'This command can only be used in a Discord server.',
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return interaction.guildId;
}

function roleLabel(roleId: string | undefined): string {
  return roleId === undefined ? 'Not configured' : `<@&${roleId}>`;
}

async function handleNicknameSubcommand(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  subcommand: string,
): Promise<void> {
  if (subcommand === 'view') {
    const settings = await loadGuildNicknameSettings(guildId);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setTitle('Verified player nicknames')
          .setDescription(
            mdLabelLines([
              `Automatic sync: ${settings.enabled ? 'Enabled' : 'Disabled'}`,
              `Prefix: ${settings.prefix === null ? 'None (player name only)' : mdCode(settings.prefix)}`,
              `Format: ${mdCode(settings.prefix === null ? 'PlayerName' : `${settings.prefix} PlayerName`)}`,
            ]),
          )
          .addFields({
            name: 'How it works',
            value:
              'Verified members receive a server nickname built from their linked Brawl Stars player name and this guild’s custom prefix. Changes are applied automatically after verification, after sync, and during scheduled reconciliation.',
          }),
      ],
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (subcommand === 'me') {
    const result = await syncMemberNickname(interaction.guild!, interaction.user.id);
    if (result.kind === 'not-verified') {
      await interaction.editReply({
        content: 'No verified main account was found for you in this server. Verify with `/verify tag` first.',
      });
      return;
    }
    if (result.kind === 'disabled') {
      await interaction.editReply({ content: 'Automatic nickname sync is disabled in this server.' });
      return;
    }
    if (result.kind === 'not-member') {
      await interaction.editReply({ content: 'You are not a member of this server.' });
      return;
    }
    if (result.kind === 'failed') {
      await interaction.editReply({
        content: 'A nickname could not be changed. Check that BrawlHub has Manage Nicknames permission and a role above the target member.',
      });
      return;
    }
    await interaction.editReply({
      content:
        result.kind === 'unchanged'
          ? `Your nickname is already ${mdCode(result.nickname ?? '')}.`
          : result.kind === 'skipped-owner' || result.kind === 'skipped-bot'
            ? 'This member’s nickname is managed by Discord, not BrawlHub.'
            : `Your nickname is now ${mdCode(result.nickname ?? '')}.`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const actor = await requireGlobalPermission(
    interaction.user.id,
    'clubs:write',
    permissionContext(interaction),
  );

  if (subcommand === 'set') {
    const prefix = interaction.options.getString('prefix', true);
    const saved = await saveGuildNicknameSettings({
      guildId,
      actor,
      prefix,
      enabled: true,
    });
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(SUCCESS_COLOR)
          .setTitle('Nickname prefix updated')
          .addFields(
            {
              name: 'Prefix',
              value: saved.prefix === null ? 'None' : mdCode(saved.prefix),
              inline: true,
            },
            {
              name: 'Sync',
              value: saved.enabled ? 'Enabled' : 'Disabled',
              inline: true,
            },
            {
              name: 'Format',
              value: mdCode(
                saved.prefix === null ? 'PlayerName' : `${saved.prefix} PlayerName`,
              ),
            },
          ),
      ],
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (subcommand === 'clear') {
    const saved = await saveGuildNicknameSettings({ guildId, actor, prefix: null });
    await interaction.editReply({
      content: `Nickname prefix cleared. Verified members will use ${mdCode('PlayerName')} only.`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (subcommand === 'enable' || subcommand === 'disable') {
    const saved = await saveGuildNicknameSettings({
      guildId,
      actor,
      enabled: subcommand === 'enable',
    });
    await interaction.editReply({
      content: `Automatic nickname sync is now ${saved.enabled ? 'enabled' : 'disabled'} in this server.`,
      allowedMentions: { parse: [] },
    });
    if (!saved.enabled) {
      // Best-effort: restore/clear nicknames BrawlHub previously applied.
      try {
        const cleanup = await releaseManagedNicknamesAfterDisable(interaction.guild!);
        if (cleanup.cleanupIncomplete) {
          await interaction.followUp({
            content: 'ℹ️ Nickname cleanup could not read every managed nickname. Some BrawlHub nicknames may remain; an administrator can restore them manually.',
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
        }
      } catch (error) {
        // Cleanup must not turn a successful disable into an error, but the
        // administrator still needs to know that nicknames may remain.
        logger.warn('Managed nickname cleanup after disable threw', {
          guildId,
          error: error instanceof Error ? error.message : String(error),
        });
        await interaction.followUp({
          content: 'ℹ️ Nickname cleanup could not finish. Some BrawlHub nicknames may remain; an administrator can restore them manually.',
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }
    }
    return;
  }

  await interaction.editReply({ content: 'Use `/fn nickname view` to see the current nickname setup.' });
}

export async function handleFn(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = await requireGuild(interaction);
  if (guildId === null) return;
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();
  const isPublic = subcommand === 'list' || (group === 'nickname' && subcommand === 'view');
  await interaction.deferReply({ flags: isPublic ? undefined : MessageFlags.Ephemeral });

  try {
    if (group === 'nickname') {
      await handleNicknameSubcommand(interaction, guildId, subcommand);
      return;
    }

    const state = await loadGuildRankedRoleState(guildId);

    if (subcommand === 'set') {
      const actor = await requireGlobalPermission(
        interaction.user.id,
        'clubs:write',
        permissionContext(interaction),
      );
      const tier = interaction.options.getString('tier', true) as RankedTier;
      const role = interaction.options.getRole('role', true);
      if (!RANKED_TIERS.includes(tier)) {
        await interaction.editReply({ content: 'Choose one of the supported ranked tiers.' });
        return;
      }
      const saved = await saveGuildRankedRoleMapping({
        guildId,
        actor,
        mapping: { ...state.mapping, [tier]: role.id },
      });
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(SUCCESS_COLOR)
            .setTitle('Ranked role updated')
            .addFields(
              { name: 'Tier', value: mdCode(tier), inline: true },
              { name: 'Role', value: `<@&${role.id}>`, inline: true },
              {
                name: 'Configured roles',
                value: mdLabelLines(
                  RANKED_TIERS.map((name) => `${name}: ${roleLabel(saved.mapping[name])}`),
                ),
              },
            ),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'me') {
      const result = await refreshMemberRankedRole(interaction.guild!, interaction.user.id);
      if (result.kind === 'not-verified') {
        await interaction.editReply({
          content: 'No verified main account was found for you in this server. Verify with `/verify tag` first.',
        });
        return;
      }
      if (result.kind === 'not-member') {
        await interaction.editReply({ content: 'You are not a member of this server.' });
        return;
      }
      await interaction.editReply({
        content:
          result.tier === null
            ? 'Your verified main account has no stored official ranked rank, so ranked roles were cleared.'
            : `Your ranked role is now ${mdCode(result.tier)}.`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const components = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`fn:me:${guildId}`)
          .setLabel('Refresh my ranked role')
          .setStyle(ButtonStyle.Primary),
      ),
    ];
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setTitle('Ranked roles')
          .setDescription(
            'Roles are assigned from the verified main account using stored official Brawl Stars ranked data.',
          )
          .addFields(
            RANKED_TIERS.map((tier) => ({
              name: tier,
              value: roleLabel(state.mapping[tier]),
              inline: true,
            })),
          ),
      ],
      components,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}

export async function handleFnComponent(interaction: CommandComponentInteraction): Promise<void> {
  const [, action, embeddedGuildId] = interaction.customId.split(':');
  if (action !== 'me') return;
  if (interaction.guild === null || interaction.guildId !== embeddedGuildId) {
    await replyExpiredComponent(
      interaction,
      'That ranked-role button belongs to another server. Run `/fn list` here.',
    );
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const result = await refreshMemberRankedRole(interaction.guild, interaction.user.id);
    await interaction.editReply({
      content:
        result.kind === 'ok'
          ? result.tier === null
            ? 'Ranked roles cleared: no stored official rank on your verified main account.'
            : `Ranked role refreshed to ${mdCode(result.tier)}.`
          : result.kind === 'not-member'
            ? 'You are not a member of this server.'
            : 'No verified main account was found for you in this server.',
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}
