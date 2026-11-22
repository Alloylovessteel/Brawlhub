import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { respondToAutocomplete } from '../discord/errors.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { buildClubArchivedEmbed, buildClubArchivePreviewEmbed } from '../admin/embed';
import { replyAdminError } from '../admin/errors';
import { requireGlobalPermission } from '../admin/service';
import type { AdminActor } from '../admin/types';
import { archiveGuildClub } from '../clubs/archival';
import { filterRegisteredClubs, getRegisteredClubs } from '../clubs/service';
import {
  buildConfirmationRow,
  parseConfirmationCustomId,
} from '../discord/confirmation-components';
import { ConfirmationError, ConfirmationStore } from '../discord/confirmations';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';

const COMMAND_NAME = 'remove-club';
const CANCELLED_MESSAGE = 'Club archival cancelled. Nothing was changed.';

interface PendingArchive {
  readonly actor: AdminActor;
  readonly clubId: string;
  readonly clubName: string;
  readonly clubTag: string;
}

const pendingArchives = new ConfirmationStore<PendingArchive>();

/** Reset the ephemeral confirmation store (used by tests). */
export function clearPendingClubArchives(): void {
  pendingArchives.clear();
}

export const removeClubCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Archive a registered club without deleting its history')
  .addStringOption((option) =>
    option
      .setName('club')
      .setDescription('Registered club to archive (tag or selection)')
      .setAutocomplete(true)
      .setRequired(true),
  );

async function permissionContext(
  interaction: ChatInputCommandInteraction | AutocompleteInteraction,
) {
  return requireGlobalPermission(interaction.user.id, 'clubs:write', {
    guildId: interaction.guildId,
    memberPermissions: interaction.memberPermissions,
    memberRoleIds: getInteractionMemberRoleIds(interaction.member),
    isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
    discordUsername: interaction.user.username,
  });
}

export async function handleRemoveClub(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId;
    if (guildId === null) {
      await interaction.editReply({ content: 'This command can only be used in a server.' });
      return;
    }
    const actor = await permissionContext(interaction);
    const raw = interaction.options.getString('club', true);
    const clubs = await getRegisteredClubs(guildId);
    const candidate = clubs.find((club) => club.id === raw)
      ?? clubs.find((club) => club.tag.toUpperCase() === raw.replace(/^#/, '').trim().toUpperCase());

    if (candidate === undefined) {
      await interaction.editReply({
        content: 'That club is not registered in this server. Nothing was changed.',
      });
      return;
    }

    const nonce = pendingArchives.create(interaction.user.id, {
      actor,
      clubId: candidate.id,
      clubName: candidate.name,
      clubTag: candidate.tag,
    });
    await interaction.editReply({
      embeds: [buildClubArchivePreviewEmbed(candidate.name, candidate.tag)],
      components: [buildConfirmationRow(COMMAND_NAME, nonce)],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}

export async function handleRemoveClubComponent(interaction: CommandComponentInteraction): Promise<void> {
  try {
    await interaction.deferUpdate();
    const action = parseConfirmationCustomId(interaction.customId, COMMAND_NAME);
    if (action === null) return;
    const guildId = interaction.guildId;
    if (guildId === null) return;

    const pending = pendingArchives.take(action.nonce, interaction.user.id);
    if (action.kind === 'cancel') {
      await interaction.editReply({ content: CANCELLED_MESSAGE, embeds: [], components: [] });
      return;
    }

    const result = await archiveGuildClub({
      clubId: pending.clubId,
      guildId,
      actor: pending.actor,
      clubTag: pending.clubTag,
      clubName: pending.clubName,
    });

    const content =
      result.kind === 'not-found'
        ? 'That club is no longer registered in this server. Nothing was changed.'
        : result.kind === 'already-archived'
          ? 'That club has already been archived.'
          : null;
    await interaction.editReply({
      ...(content === null ? {} : { content, embeds: [], components: [] }),
      ...(content === null
        ? {
            embeds: [buildClubArchivedEmbed(pending.clubName, pending.clubTag)],
            components: [],
          }
        : {}),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    if (error instanceof ConfirmationError) {
      await interaction.editReply({
        content: error.message,
        embeds: [],
        components: [],
      }).catch(() => undefined);
      return;
    }
    await replyAdminError(interaction, error);
  }
}

export async function handleRemoveClubAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'club') {
    await respondToAutocomplete(interaction, []);
    return;
  }
  try {
    await permissionContext(interaction);
    const clubs = await getRegisteredClubs(interaction.guildId);
    const choices = filterRegisteredClubs(clubs, String(focused.value)).map((club) => ({
      name: `${club.name} (#${club.tag})`,
      value: club.id,
    }));
    await respondToAutocomplete(interaction, choices);
  } catch {
    await respondToAutocomplete(interaction, [], { swallowUnexpectedErrors: true });
  }
}
