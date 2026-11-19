import { SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { buildClubRemovalUnavailableEmbed } from '../admin/embed';
import { replyAdminError } from '../admin/errors';
import { requireGlobalPermission } from '../admin/service';
import { filterRegisteredClubs, getRegisteredClubs } from '../clubs/service';

const COMMAND_NAME = 'remove-club';

/**
 * The current schema has no archival state. Direct deletion would cascade into
 * snapshots, memberships, user roles and guild settings, so this command is
 * intentionally kept in pendingCommands and never registered or dispatched.
 */
export const removeClubCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Archive a registered club (currently unavailable)')
  .addStringOption((option) =>
    option
      .setName('club')
      .setDescription('Registered club to archive (tag or selection)')
      .setAutocomplete(true)
      .setRequired(true),
  );

export async function handleRemoveClub(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await requireGlobalPermission(interaction.user.id, 'clubs:write');
    await interaction.reply({
      embeds: [buildClubRemovalUnavailableEmbed()],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyAdminError(interaction, error);
  }
}

export async function handleRemoveClubAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'club') {
    await interaction.respond([]);
    return;
  }
  try {
    await requireGlobalPermission(interaction.user.id, 'clubs:write');
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
