import { mdCode, mdLabelLines, mdParagraphs } from '../discord/embed-format';
import { EMBED_COLORS } from '../discord/embed-style';
import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { replyAdminError } from '../admin/errors.js';
import { requireGlobalPermission } from '../admin/service.js';
import {
  CLUB_ROLE_RANKS,
  clubRoleLabel,
  ensureClubRoles,
  loadGuildClubRoleState,
  refreshGuildClubRoles,
  refreshMemberClubRoles,
  saveGuildClubRoleMapping,
  type ClubRoleRank,
} from '../club-roles/service.js';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';

const EMBED_COLOR = EMBED_COLORS.neutral;
const SUCCESS_COLOR = EMBED_COLORS.success;
const NO_GUILD_MESSAGE = 'Club roles can only be managed from within a Discord server.';

const commandBuilder = new SlashCommandBuilder()
  .setName('club-roles')
  .setDescription('Configure automatic Discord roles from Brawl Stars club ranks');

commandBuilder.addSubcommand((subcommand) =>
  subcommand.setName('view').setDescription('Show this server’s club-rank role setup'),
);
commandBuilder.addSubcommand((subcommand) =>
  subcommand
    .setName('setup')
    .setDescription('Create or reuse the President, Vice President and Senior roles'),
);
commandBuilder.addSubcommand((subcommand) =>
  subcommand
    .setName('set')
    .setDescription('Map one club rank to an existing Discord role')
    .addStringOption((option) =>
      option
        .setName('rank')
        .setDescription('Brawl Stars club rank')
        .setRequired(true)
        .addChoices(...CLUB_ROLE_RANKS.map((rank) => ({ name: clubRoleLabel(rank), value: rank }))),
    )
    .addRoleOption((option) =>
      option.setName('role').setDescription('Discord role to use').setRequired(true),
    ),
);
commandBuilder.addSubcommand((subcommand) =>
  subcommand
    .setName('clear')
    .setDescription('Stop managing the Discord role for one club rank')
    .addStringOption((option) =>
      option
        .setName('rank')
        .setDescription('Brawl Stars club rank')
        .setRequired(true)
        .addChoices(...CLUB_ROLE_RANKS.map((rank) => ({ name: clubRoleLabel(rank), value: rank }))),
    ),
);
commandBuilder.addSubcommand((subcommand) =>
  subcommand
    .setName('refresh')
    .setDescription('Refresh every club-rank role in this server from stored data'),
);
commandBuilder.addSubcommand((subcommand) =>
  subcommand
    .setName('me')
    .setDescription('Refresh your own club-rank role from your verified main account'),
);

export const clubRolesCommandData: SlashCommandBuilder = commandBuilder;

function permissionContext(interaction: ChatInputCommandInteraction) {
  return {
    guildId: interaction.guildId,
    memberPermissions: interaction.memberPermissions,
    memberRoleIds: getInteractionMemberRoleIds(interaction.member),
    isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
    discordUsername: interaction.user.username,
  };
}

function parseRank(value: string): ClubRoleRank | null {
  return CLUB_ROLE_RANKS.find((rank) => rank === value) ?? null;
}

function roleLabel(roleId: string | undefined): string {
  return roleId === undefined ? 'Not configured' : `<@&${roleId}>`;
}

function viewEmbed(
  guildId: string,
  mapping: Awaited<ReturnType<typeof loadGuildClubRoleState>>['mapping'],
  notice?: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('Club-rank roles')
    .setDescription(
      notice ??
        mdParagraphs(
          'Roles come from stored official Brawl Stars club ranks for verified main accounts in this guild.',
          mdLabelLines([`Server ID: ${mdCode(guildId)}.`]),
        ),
    )
    .addFields(
      ...CLUB_ROLE_RANKS.map((rank) => ({
        name: clubRoleLabel(rank),
        value: roleLabel(mapping[rank]),
        inline: true,
      })),
      {
        name: 'Precedence',
        value: mdParagraphs(
          `${mdCode('President')} > ${mdCode('Vice President')} > ${mdCode('Senior')}.`,
          'Each member receives at most one managed club role.',
        ),
      },
      {
        name: 'Data source',
        value: mdParagraphs(
          `Stored ${mdCode('club_memberships.role')} from clubs registered to this Discord server.`,
          'No role is inferred from names or Discord profiles.',
        ),
      },
    );
}

function refreshFields(result: Awaited<ReturnType<typeof refreshGuildClubRoles>>) {
  return [
    { name: 'Verified mains', value: String(result.planned), inline: true },
    { name: 'Members updated', value: String(result.processed), inline: true },
    { name: 'Not in server', value: String(result.membersNotFound), inline: true },
    { name: 'Stale roles cleared', value: String(result.cleanedMembers), inline: true },
  ];
}

/** View or manage per-guild club-rank role assignments. */
export async function handleClubRoles(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.guild === null || interaction.guildId === null) {
    await interaction.reply({
      content: NO_GUILD_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = interaction.guildId;
  const subcommand = interaction.options.getSubcommand(false) ?? 'view';
  if (subcommand === 'view') await interaction.deferReply();
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const state = await loadGuildClubRoleState(guildId);

    if (subcommand === 'view') {
      await interaction.editReply({
        embeds: [viewEmbed(guildId, state.mapping)],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'me') {
      const result = await refreshMemberClubRoles(interaction.guild, interaction.user.id);
      const message =
        result.kind === 'not-configured'
          ? 'Club-rank roles are not configured in this server yet.'
          : result.kind === 'not-verified'
            ? 'No verified main account with a role in this server’s clubs was found for you. Verify with `/members verify` first.'
            : result.kind === 'not-member'
              ? 'You are not a member of this server.'
              : result.rank === null
                ? 'Your verified main accounts have no President, Vice President or Senior role in this server’s clubs, so club roles were cleared.'
                : `Your club role is now ${mdCode(clubRoleLabel(result.rank))}.`;
      await interaction.editReply({ content: message, allowedMentions: { parse: [] } });
      return;
    }

    const actor = await requireGlobalPermission(
      interaction.user.id,
      'clubs:write',
      permissionContext(interaction),
    );

    if (subcommand === 'setup') {
      const mapping = await ensureClubRoles(interaction.guild, state.mapping);
      const saved = await saveGuildClubRoleMapping({
        guildId,
        mapping,
        actor,
        action: 'guild.club_roles.setup',
      });
      const refreshed = await refreshGuildClubRoles(interaction.guild, { actor: null });
      await interaction.editReply({
        embeds: [
          viewEmbed(guildId, saved.mapping, 'Club-rank roles are set up and were refreshed.'),
          new EmbedBuilder()
            .setColor(SUCCESS_COLOR)
            .setTitle('Initial refresh')
            .addFields(...refreshFields(refreshed)),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'set') {
      const rank = parseRank(interaction.options.getString('rank', true));
      const role = interaction.options.getRole('role', true);
      if (rank === null) {
        await interaction.editReply({ content: 'Choose a supported club rank.' });
        return;
      }
      if (role.managed) {
        await interaction.editReply({ content: 'Integration-managed Discord roles cannot be used.' });
        return;
      }
      const saved = await saveGuildClubRoleMapping({
        guildId,
        mapping: { ...state.mapping, [rank]: role.id },
        actor,
      });
      const refreshed = await refreshGuildClubRoles(interaction.guild, { actor: null });
      await interaction.editReply({
        embeds: [
          viewEmbed(
            guildId,
            saved.mapping,
            `${mdCode(clubRoleLabel(rank))} now maps to <@&${role.id}>, and roles were refreshed.`,
          ),
          new EmbedBuilder()
            .setColor(SUCCESS_COLOR)
            .setTitle('Role refresh')
            .addFields(...refreshFields(refreshed)),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'clear') {
      const rank = parseRank(interaction.options.getString('rank', true));
      if (rank === null) {
        await interaction.editReply({ content: 'Choose a supported club rank.' });
        return;
      }
      const mapping = { ...state.mapping };
      delete mapping[rank];
      const saved = await saveGuildClubRoleMapping({ guildId, mapping, actor });
      const refreshed = await refreshGuildClubRoles(interaction.guild, { actor: null });
      await interaction.editReply({
        embeds: [
          viewEmbed(
            guildId,
            saved.mapping,
            `${mdCode(clubRoleLabel(rank))} is no longer managed by BrawlHub.`,
          ),
          new EmbedBuilder()
            .setColor(SUCCESS_COLOR)
            .setTitle('Role refresh')
            .addFields(...refreshFields(refreshed)),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'refresh') {
      const result = await refreshGuildClubRoles(interaction.guild, { actor });
      if (!result.configured) {
        await interaction.editReply({
          content: 'No club-rank roles are configured. Run `/club-roles setup` first.',
        });
        return;
      }
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(SUCCESS_COLOR)
            .setTitle('Club roles refreshed')
            .addFields(...refreshFields(result)),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.editReply({
      content: `Choose ${mdCode('/club-roles view')}, ${mdCode('setup')}, ${mdCode('set')}, ${mdCode('clear')}, ${mdCode('refresh')} or ${mdCode('me')}.`,
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}
