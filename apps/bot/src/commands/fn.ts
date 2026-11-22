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
import {
  loadGuildRankedRoleState,
  RANKED_TIERS,
  refreshMemberRankedRole,
  saveGuildRankedRoleMapping,
  type RankedTier,
} from '../ranked-roles/service.js';

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

export async function handleFn(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = await requireGuild(interaction);
  if (guildId === null) return;
  const subcommand = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: subcommand === 'list' ? undefined : MessageFlags.Ephemeral });

  try {
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
          content: 'No verified main account was found for you in this server. Verify with `/members accounts verify` first.',
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
  if (interaction.guild === null || interaction.guildId !== embeddedGuildId) return;

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
