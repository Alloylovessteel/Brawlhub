import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { replyAdminError } from '../admin/errors.js';
import { recordAdminAudit, requireGlobalPermission } from '../admin/service.js';
import type { AdminActor } from '../admin/types.js';
import { ConfirmationStore } from '../discord/confirmations.js';
import {
  buildConfirmationRow,
  parseConfirmationCustomId,
} from '../discord/confirmation-components.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';
import {
  linkPlayerManually,
  listGuildVerifiedLinks,
  revokeAllLinksForDiscordUser,
  revokeVerification,
  type RegisteredLinkView,
} from '../verification/index.js';

const EMBED_COLOR = 0x5865_f2;

export const tagCommandData = new SlashCommandBuilder()
  .setName('tag')
  .setDescription('Manage staff-forced Brawl Stars account links')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('set')
      .setDescription('Link a Discord user to a Brawl Stars player (fully verified)')
      .addUserOption((option) =>
        option.setName('user').setDescription('The Discord user').setRequired(true),
      )
      .addStringOption((option) =>
        option.setName('tag').setDescription('Brawl Stars player tag').setRequired(true),
      )
      .addStringOption((option) =>
        option.setName('reason').setDescription('Optional staff reason').setRequired(false),
      ),
  );

export const registerListCommandData = new SlashCommandBuilder()
  .setName('register-list')
  .setDescription('List verified account links for players in this server’s clubs');

export const findCommandData = new SlashCommandBuilder()
  .setName('find')
  .setDescription('Find a verified account link in this server')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('user')
      .setDescription('Find links for a Discord user')
      .addUserOption((option) =>
        option.setName('user').setDescription('Discord user').setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('tag')
      .setDescription('Find links for a Brawl Stars player tag')
      .addStringOption((option) =>
        option.setName('tag').setDescription('Player tag').setRequired(true),
      ),
  );

export const unverifyOneCommandData = new SlashCommandBuilder()
  .setName('unverify-one')
  .setDescription('Revoke one verified account link')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('user')
      .setDescription('Revoke a link by Discord user and tag')
      .addUserOption((option) =>
        option.setName('user').setDescription('Discord user').setRequired(true),
      )
      .addStringOption((option) =>
        option.setName('tag').setDescription('Player tag').setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('tag')
      .setDescription('Revoke the link for a player tag')
      .addStringOption((option) =>
        option.setName('tag').setDescription('Player tag').setRequired(true),
      ),
  );

export const unverifyAllCommandData = new SlashCommandBuilder()
  .setName('unverify-all')
  .setDescription('Revoke every verified account link for a Discord user')
  .addUserOption((option) =>
    option.setName('user').setDescription('Discord user').setRequired(true),
  );

interface PendingUnverify {
  readonly actor: AdminActor;
  readonly guildId: string | null;
  readonly verificationId: string;
  readonly discordUserId: string;
  readonly tag: string;
}

interface PendingUnverifyAll {
  readonly actor: AdminActor;
  readonly guildId: string | null;
  readonly discordUserId: string;
}

const pendingOne = new ConfirmationStore<PendingUnverify>();
const pendingAll = new ConfirmationStore<PendingUnverifyAll>();

function permissionContext(interaction: ChatInputCommandInteraction | CommandComponentInteraction) {
  return {
    guildId: interaction.guildId,
    memberPermissions: interaction.memberPermissions,
    memberRoleIds: getInteractionMemberRoleIds(interaction.member),
    isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
    discordUsername: interaction.user.username,
  };
}

function linksEmbed(links: RegisteredLinkView[], title: string): EmbedBuilder {
  const lines = links.slice(0, 25).map((link) => {
    const label = link.isMain ? 'MAIN' : 'Alt';
    const source = link.method === 'manual_staff' ? 'staff-linked' : 'icon-verified';
    return `• <@${link.discordUserId}> — ${link.name ?? 'Unknown'} (#${link.tag}) [${label}, ${source}]`;
  });
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(title)
    .setDescription(lines.length > 0 ? lines.join('\n') : 'No matching verified account links in this server.')
    .setFooter({ text: `${links.length} link(s) shown${links.length > 25 ? ' (first 25)' : ''}` });
}

export async function handleTag(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: 64 });
  try {
    const actor = await requireGlobalPermission(
      interaction.user.id,
      'members:verify',
      permissionContext(interaction),
    );
    const user = interaction.options.getUser('user', true);
    const tag = interaction.options.getString('tag', true);
    const reason = interaction.options.getString('reason');
    const result = await linkPlayerManually({
      actorProfileId: actor.profileId,
      actorDiscordUserId: interaction.user.id,
      discordUserId: user.id,
      tagInput: tag,
      reason,
    });
    if (result.kind !== 'ok') {
      const messages: Record<string, string> = {
        'invalid-tag': 'That player tag is not valid.',
        'invalid-user': 'That Discord user cannot be linked.',
        'player-not-found': 'No Brawl Stars player was found for that tag in the official API.',
        'api-unavailable': 'The official Brawl Stars API could not be reached right now.',
        'already-linked-self': 'That player is already linked to this Discord user.',
        'already-linked-other': 'That player is already linked to a different Discord user. Revoke it first.',
      };
      await interaction.editReply({
        content: messages[result.kind] ?? 'Could not link that account right now.',
        allowedMentions: { parse: [] },
      });
      return;
    }
    await recordAdminAudit({
      actor,
      action: 'member.verification.linked',
      targetType: 'player_verification',
      targetId: null,
      guildId: interaction.guildId,
      details: { discordUserId: user.id, tag: result.account.tag, method: 'manual_staff' },
    });
    await interaction.editReply({
      content: `<@${user.id}> is now fully verified for #${result.account.tag} (staff-linked${result.account.isMain ? ', main account' : ''}).`,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}

export async function handleRegisterList(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: 64 });
  try {
    await requireGlobalPermission(interaction.user.id, 'members:verify', permissionContext(interaction));
    const links = await listGuildVerifiedLinks(interaction.guildId ?? '');
    await interaction.editReply({
      embeds: [linksEmbed(links, 'Verified accounts in this server')],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}

export async function handleFind(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: 64 });
  try {
    await requireGlobalPermission(interaction.user.id, 'members:verify', permissionContext(interaction));
    const links = await listGuildVerifiedLinks(interaction.guildId ?? '');
    const subcommand = interaction.options.getSubcommand();
    const needle = subcommand === 'user'
      ? interaction.options.getUser('user', true).id
      : (interaction.options.getString('tag', true).replace(/^#/, '').toUpperCase());
    const matches = links.filter((link) =>
      subcommand === 'user' ? link.discordUserId === needle : link.tag === needle,
    );
    await interaction.editReply({
      embeds: [linksEmbed(matches, `Verified accounts matching ${subcommand === 'user' ? `<@${needle}>` : `#${needle}`}`)],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}

export async function handleUnverifyOne(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: 64 });
  try {
    const actor = await requireGlobalPermission(
      interaction.user.id,
      'members:verify',
      permissionContext(interaction),
    );
    const subcommand = interaction.options.getSubcommand();
    const user = subcommand === 'user' ? interaction.options.getUser('user', true) : null;
    const tag = interaction.options.getString('tag', true).replace(/^#/, '').toUpperCase();
    const links = await listGuildVerifiedLinks(interaction.guildId ?? '');
    const match = links.find((link) =>
      link.tag === tag && (user === null || link.discordUserId === user.id),
    );
    if (match === undefined) {
      await interaction.editReply({
        content: 'No matching verified account link was found in this server.',
        allowedMentions: { parse: [] },
      });
      return;
    }
    const nonce = pendingOne.create(interaction.user.id, {
      actor,
      guildId: interaction.guildId,
      verificationId: match.verificationId,
      discordUserId: match.discordUserId,
      tag: match.tag,
    });
    await interaction.editReply({
      content: `Revoke <@${match.discordUserId}>’s link to #${match.tag}? This cannot be undone.`,
      components: [buildConfirmationRow('unverify-one', nonce)],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}

export async function handleUnverifyOneComponent(interaction: CommandComponentInteraction): Promise<void> {
  const action = parseConfirmationCustomId(interaction.customId, 'unverify-one');
  if (action === null) return;
  await interaction.deferUpdate();
  try {
    const pending = pendingOne.take(action.nonce, interaction.user.id);
    await requireGlobalPermission(interaction.user.id, 'members:verify', permissionContext(interaction));
    if (action.kind === 'cancel') {
      await interaction.editReply({ content: 'Cancelled.', components: [], embeds: [] });
      return;
    }
    const result = await revokeVerification(pending.verificationId, pending.actor.profileId);
    if (result.kind !== 'ok') {
      await interaction.editReply({ content: 'That link is no longer active.', components: [], embeds: [] });
      return;
    }
    await recordAdminAudit({
      actor: pending.actor,
      action: 'member.verification.revoked',
      targetType: 'player_verification',
      targetId: pending.verificationId,
      guildId: pending.guildId,
      details: { discordUserId: pending.discordUserId, tag: pending.tag },
    });
    await interaction.editReply({
      content: `Revoked #${pending.tag} from <@${pending.discordUserId}>.${result.promoted ? ' Another account was promoted to main.' : ''}`,
      components: [],
      embeds: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}

export async function handleUnverifyAll(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: 64 });
  try {
    const actor = await requireGlobalPermission(
      interaction.user.id,
      'members:verify',
      permissionContext(interaction),
    );
    const user = interaction.options.getUser('user', true);
    const links = await listGuildVerifiedLinks(interaction.guildId ?? '');
    if (!links.some((link) => link.discordUserId === user.id)) {
      await interaction.editReply({
        content: 'No verified account links for that user were found in this server.',
        allowedMentions: { parse: [] },
      });
      return;
    }
    const nonce = pendingAll.create(interaction.user.id, {
      actor,
      guildId: interaction.guildId,
      discordUserId: user.id,
    });
    await interaction.editReply({
      content: `Revoke **all** verified account links for <@${user.id}>? This cannot be undone.`,
      components: [buildConfirmationRow('unverify-all', nonce)],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}

export async function handleUnverifyAllComponent(interaction: CommandComponentInteraction): Promise<void> {
  const action = parseConfirmationCustomId(interaction.customId, 'unverify-all');
  if (action === null) return;
  await interaction.deferUpdate();
  try {
    const pending = pendingAll.take(action.nonce, interaction.user.id);
    await requireGlobalPermission(interaction.user.id, 'members:verify', permissionContext(interaction));
    if (action.kind === 'cancel') {
      await interaction.editReply({ content: 'Cancelled.', components: [], embeds: [] });
      return;
    }
    const result = await revokeAllLinksForDiscordUser(pending.discordUserId, pending.actor.profileId);
    if (result.kind !== 'ok') {
      await interaction.editReply({ content: 'Those links are no longer active.', components: [], embeds: [] });
      return;
    }
    await recordAdminAudit({
      actor: pending.actor,
      action: 'member.verification.revoked_all',
      targetType: 'profile',
      targetId: pending.discordUserId,
      guildId: pending.guildId,
      details: { revoked: result.revoked },
    });
    await interaction.editReply({
      content: `Revoked ${result.revoked} link(s) from <@${pending.discordUserId}>.`,
      components: [],
      embeds: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}
