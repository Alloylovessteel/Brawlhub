import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { buildPlayerProfileEmbed } from '../players/embed';
import { loadPlayerProfile } from '../players/service';
import { getBotConfig } from '../config';
import { replyPlayerLookupFailure, respondWithPlayerChoices } from './player-utils';

export const playerCommandData = new SlashCommandBuilder()
  .setName('player')
  .setDescription('Show a Brawl Stars player profile')
  .addStringOption((option) =>
    option
      .setName('tag')
      .setDescription('Player tag, for example #PLAYERTAG')
      .setAutocomplete(true)
      .setRequired(true)
      .setMaxLength(11),
  );

export async function handlePlayer(interaction: ChatInputCommandInteraction): Promise<void> {
  const result = await loadPlayerProfile({
    tag: interaction.options.getString('tag', true),
    guildId: interaction.guildId,
  });

  if (result.kind !== 'ok') {
    await replyPlayerLookupFailure(interaction, result);
    return;
  }

  await interaction.reply({
    embeds: [buildPlayerProfileEmbed(result.value, getBotConfig())],
    allowedMentions: { parse: [] },
  });
}

export async function handlePlayerAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondWithPlayerChoices(interaction, 'tag');
}
