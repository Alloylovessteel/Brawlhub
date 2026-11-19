import {
  previewClubRegistration,
  registerClubs,
  type ClubRegistrationPreview,
} from '@brawlhub/sync';
import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import {
  buildClubRegisteredEmbed,
  buildClubRegistrationPreviewEmbed,
} from '../admin/embed';
import { AdminServiceError, recordAdminAudit, requireGlobalPermission } from '../admin/service';
import { getInteractionMemberRoleIds } from '../discord/permissions.js';
import type { AdminActor } from '../admin/types';
import { isIgnorableInteractionError, type RepliableInteraction } from '../discord/errors.js';
import {
  buildConfirmationRow,
  parseConfirmationCustomId,
} from '../discord/confirmation-components';
import { ConfirmationError, ConfirmationStore } from '../discord/confirmations';

const COMMAND_NAME = 'register-club';
const FORBIDDEN_MESSAGE = 'You do not have permission to register BrawlHub clubs.';
const API_FAILURE_MESSAGE =
  'The official Brawl Stars API could not validate that club. Nothing was registered.';
const CANCELLED_MESSAGE = 'Club registration cancelled. Nothing was registered.';

interface PendingRegistration {
  readonly actor: AdminActor;
  readonly tag: string;
  readonly preview: ClubRegistrationPreview;
}

const pendingRegistrations = new ConfirmationStore<PendingRegistration>();

/** Reset the ephemeral confirmation store (used by tests). */
export function clearPendingClubRegistrations(): void {
  pendingRegistrations.clear();
}

export const registerClubCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Register a Brawl Stars club after official API validation')
  .addStringOption((option) =>
    option
      .setName('tag')
      .setDescription('Brawl Stars club tag, for example #ABCD1234')
      .setRequired(true)
      .setMaxLength(20),
  );

async function replyRegistrationError(
  interaction: RepliableInteraction,
  error: unknown,
): Promise<void> {
  if (isIgnorableInteractionError(error)) return;
  try {
    if (error instanceof AdminServiceError || error instanceof ConfirmationError) {
      const message =
        error instanceof AdminServiceError && error.code === 'forbidden'
          ? FORBIDDEN_MESSAGE
          : error.message;
      if (interaction.deferred) {
        await interaction.editReply({ content: message, embeds: [], components: [] });
      } else if (interaction.replied) {
        await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    const reason = error instanceof Error ? error.message.trim() : '';
    const fallback =
      reason.length > 0 && reason !== API_FAILURE_MESSAGE
        ? `The official Brawl Stars API could not validate that club: ${reason} Nothing was registered.`
            .replace(/\s+/g, ' ')
            .slice(0, 1500)
        : API_FAILURE_MESSAGE;
    if (interaction.deferred) {
      await interaction.editReply({ content: fallback, embeds: [], components: [] });
    } else if (interaction.replied) {
      await interaction.followUp({ content: fallback, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: fallback, flags: MessageFlags.Ephemeral });
    }
  } catch (replyError) {
    if (isIgnorableInteractionError(replyError)) return;
    throw replyError;
  }
}

export async function handleRegisterClub(interaction: ChatInputCommandInteraction): Promise<void> {
  const inGuild = interaction.guildId !== null;
  try {
    if (inGuild) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({
        content: 'Clubs can only be registered from within a Discord server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const actor = await requireGlobalPermission(interaction.user.id, 'clubs:write', {
      guildId: interaction.guildId,
      memberPermissions: interaction.memberPermissions,
      memberRoleIds: getInteractionMemberRoleIds(interaction.member),
      isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
      discordUsername: interaction.user.username,
    });
    const rawTag = interaction.options.getString('tag', true);
    const preview = await previewClubRegistration(rawTag, interaction.guildId!);

    const nonce = pendingRegistrations.create(interaction.user.id, {
      actor,
      tag: preview.tag,
      preview,
    });
    await interaction.editReply({
      embeds: [buildClubRegistrationPreviewEmbed(preview)],
      components: [buildConfirmationRow(COMMAND_NAME, nonce)],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyRegistrationError(interaction, error);
  }
}

export async function handleRegisterClubComponent(interaction: CommandComponentInteraction): Promise<void> {
  const action = parseConfirmationCustomId(interaction.customId, COMMAND_NAME);
  if (action === null) return;

  try {
    await interaction.deferUpdate();
    const pending = pendingRegistrations.take(action.nonce, interaction.user.id);

    if (action.kind === 'cancel') {
      await interaction.editReply({ content: CANCELLED_MESSAGE, embeds: [], components: [] });
      return;
    }

    await requireGlobalPermission(interaction.user.id, 'clubs:write', {
      guildId: interaction.guildId,
      memberPermissions: interaction.memberPermissions,
      memberRoleIds: getInteractionMemberRoleIds(interaction.member),
      isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
      discordUsername: interaction.user.username,
    });
    const result = await registerClubs([pending.tag], pending.preview.guildId);
    if (result.registered !== 1) {
      const reason = result.rejected[0]?.reason ?? API_FAILURE_MESSAGE;
      const duplicate = reason.toLowerCase().includes('already registered');
      await interaction.editReply({
        content: duplicate
          ? `Club #${pending.tag} is already registered with BrawlHub.`
          : API_FAILURE_MESSAGE,
        embeds: [],
        components: [],
      });
      return;
    }

    let warning: string | undefined;
    try {
      await recordAdminAudit({
        actor: pending.actor,
        action: 'club.registered',
        targetType: 'club',
        targetId: pending.tag,
        details: { clubTag: pending.tag, clubName: pending.preview.name },
      });
    } catch {
      warning = 'Club registered, but audit logging failed. Please notify an administrator.';
    }
    await interaction.editReply({
      ...(warning === undefined ? {} : { content: warning }),
      embeds: [buildClubRegisteredEmbed(pending.preview)],
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyRegistrationError(interaction, error);
  }
}
