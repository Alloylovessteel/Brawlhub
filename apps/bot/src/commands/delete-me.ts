import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { ConfirmationStore } from '../discord/confirmations.js';
import {
  buildConfirmationRow,
  parseConfirmationCustomId,
} from '../discord/confirmation-components.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { deleteUserDataForDiscordUser } from '../verification/index.js';

const COMMAND_NAME = 'delete-me';
const pending = new ConfirmationStore<{ readonly discordUserId: string }>();

export const deleteMeCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Permanently delete your BrawlHub identity data');

export async function handleDeleteMe(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: 64 });
  const nonce = pending.create(interaction.user.id, { discordUserId: interaction.user.id });
  await interaction.editReply({
    content: [
      'This will permanently delete your BrawlHub profile, Discord identity link and every verified account link.',
      'Public Brawl Stars player statistics synced by BrawlHub are **not** deleted because they are game data, not your personal data.',
      'This action cannot be undone.',
    ].join('\n\n'),
    components: [buildConfirmationRow(COMMAND_NAME, nonce)],
    allowedMentions: { parse: [] },
  });
}

export async function handleDeleteMeComponent(interaction: CommandComponentInteraction): Promise<void> {
  const action = parseConfirmationCustomId(interaction.customId, COMMAND_NAME);
  if (action === null) return;
  await interaction.deferUpdate();
  const payload = pending.take(action.nonce, interaction.user.id);
  if (action.kind === 'cancel') {
    await interaction.editReply({ content: 'Cancelled.', components: [], embeds: [] });
    return;
  }
  const result = await deleteUserDataForDiscordUser(payload.discordUserId);
  const message =
    result.kind === 'ok'
      ? 'Your BrawlHub identity data has been deleted.'
      : result.kind === 'not-found'
        ? 'You did not have any stored BrawlHub identity data.'
        : 'Could not delete your data right now. Please try again later.';
  await interaction.editReply({ content: message, components: [], embeds: [] });
}
