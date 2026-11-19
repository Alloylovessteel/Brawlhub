import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { getBotConfig } from '../config';
import { buildCompareEmbed } from '../clubs/embed';
import { loadCompareView } from '../clubs/service';
import { replyClubLookupFailure, respondWithClubChoices } from './club-utils';

export const clubCompareCommandData = new SlashCommandBuilder()
  .setName('club-compare')
  .setDescription('Compare two registered clubs using stored data')
  .addStringOption((option) =>
    option
      .setName('first')
      .setDescription('First registered club tag')
      .setAutocomplete(true)
      .setRequired(true)
      .setMaxLength(11),
  )
  .addStringOption((option) =>
    option
      .setName('second')
      .setDescription('Second registered club tag')
      .setAutocomplete(true)
      .setRequired(true)
      .setMaxLength(11),
  );

export async function handleClubCompare(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const firstTag = interaction.options.getString('first', true);
  const secondTag = interaction.options.getString('second', true);
  const result = await loadCompareView({
    firstTag,
    secondTag,
    guildId: interaction.guildId,
    seasonStartIso: getBotConfig().seasonStartIso,
  });

  if (result.kind !== 'ok') {
    await replyClubLookupFailure(interaction, result);
    return;
  }

  await interaction.editReply({
    embeds: [buildCompareEmbed(result.value, getBotConfig())],
    allowedMentions: { parse: [] },
  });
}

export async function handleClubCompareAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondWithClubChoices(interaction);
}
