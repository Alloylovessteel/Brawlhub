import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { buildPlayerProfileEmbed } from '../players/embed';
import { loadPlayerProfile } from '../players/service';
import { resolvePlayerIconUrl } from '../metadata/assets.js';
import { getBotConfig } from '../config';
import { replyPlayerLookupFailure, respondWithPlayerChoices } from './player-utils';

export const meCommandData = new SlashCommandBuilder()
  .setName('me')
  .setDescription('Show a Brawl Stars player profile')
  .addStringOption((option) =>
    option
      .setName('tag')
      .setDescription('Player tag, for example #PLAYERTAG')
      .setAutocomplete(true)
      .setRequired(true)
      .setMaxLength(11),
  );

export async function handleMe(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const result = await loadPlayerProfile({
    tag: interaction.options.getString('tag', true),
    guildId: interaction.guildId,
  });

  if (result.kind !== 'ok') {
    await replyPlayerLookupFailure(interaction, result);
    return;
  }

  const iconUrl = await resolvePlayerIconUrl(result.value.player.iconId);
  await interaction.editReply({
    embeds: [buildPlayerProfileEmbed(result.value, getBotConfig(), iconUrl)],
    allowedMentions: { parse: [] },
  });
}

export async function handleMeAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondWithPlayerChoices(interaction, 'tag');
}
