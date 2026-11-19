import {
  previewClubRegistration,
  registerClubs,
  type ClubRegistrationPreview,
} from '@brawlhub/sync';
import {
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import {
  buildClubRegisteredEmbed,
  buildClubRegistrationPreviewEmbed,
} from '../admin/embed';
import { AdminServiceError, recordAdminAudit, requireGlobalPermission } from '../admin/service';
import type { AdminActor } from '../admin/types';
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
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  error: unknown,
): Promise<void> {
  if (error instanceof AdminServiceError || error instanceof ConfirmationError) {
    const message =
      error instanceof AdminServiceError && error.code === 'forbidden'
        ? FORBIDDEN_MESSAGE
        : error.message;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: message, ephemeral: true });
    } else {
      await interaction.reply({ content: message, ephemeral: true });
    }
    return;
  }
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content: API_FAILURE_MESSAGE, ephemeral: true });
  } else {
    await interaction.reply({ content: API_FAILURE_MESSAGE, ephemeral: true });
  }
}

export async function handleRegisterClub(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const actor = await requireGlobalPermission(interaction.user.id, 'clubs:write');
    const rawTag = interaction.options.getString('tag', true);
    const preview = await previewClubRegistration(rawTag);

    const nonce = pendingRegistrations.create(interaction.user.id, {
      actor,
      tag: preview.tag,
      preview,
    });
    await interaction.reply({
      embeds: [buildClubRegistrationPreviewEmbed(preview)],
      components: [buildConfirmationRow(COMMAND_NAME, nonce)],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyRegistrationError(interaction, error);
  }
}

export async function handleRegisterClubComponent(interaction: ButtonInteraction): Promise<void> {
  const action = parseConfirmationCustomId(interaction.customId, COMMAND_NAME);
  if (action === null) return;

  try {
    await interaction.deferUpdate();
    const pending = pendingRegistrations.take(action.nonce, interaction.user.id);

    if (action.kind === 'cancel') {
      await interaction.editReply({ content: CANCELLED_MESSAGE, embeds: [], components: [] });
      return;
    }

    await requireGlobalPermission(interaction.user.id, 'clubs:write');
    const result = await registerClubs([pending.tag]);
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
