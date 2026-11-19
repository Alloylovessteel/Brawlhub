import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { getBotConfig } from '../config';
import { buildPlayerCompareEmbed } from '../players/embed';
import { loadPlayerCompare } from '../players/service';
import type { HistoryPeriod } from '../clubs/types';
import {
  DEFAULT_PLAYER_PERIOD,
  isPlayerHistoryPeriod,
  PLAYER_PERIOD_CHOICES,
  replyPlayerLookupFailure,
  respondWithPlayerChoices,
} from './player-utils';

export const playerCompareCommandData = new SlashCommandBuilder()
  .setName('player-compare')
  .setDescription('Compare two Brawl Stars players using stored data')
  .addStringOption((option) =>
    option
      .setName('first')
      .setDescription('First player tag')
      .setAutocomplete(true)
      .setRequired(true)
      .setMaxLength(11),
  )
  .addStringOption((option) =>
    option
      .setName('second')
      .setDescription('Second player tag')
      .setAutocomplete(true)
      .setRequired(true)
      .setMaxLength(11),
  )
  .addStringOption((option) => {
    option
      .setName('period')
      .setDescription('History period used for progression')
      .setRequired(false);
    for (const choice of PLAYER_PERIOD_CHOICES) {
      option.addChoices({ name: choice.name, value: choice.value });
    }
    return option;
  });

export async function handlePlayerCompare(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const rawPeriod = interaction.options.getString('period', false);
  const period: HistoryPeriod = rawPeriod !== null && isPlayerHistoryPeriod(rawPeriod)
    ? rawPeriod
    : DEFAULT_PLAYER_PERIOD;
  const result = await loadPlayerCompare({
    firstTag: interaction.options.getString('first', true),
    secondTag: interaction.options.getString('second', true),
    period,
    guildId: interaction.guildId,
    seasonStartIso: getBotConfig().seasonStartIso,
  });

  if (result.kind !== 'ok') {
    await replyPlayerLookupFailure(interaction, result);
    return;
  }

  await interaction.editReply({
    embeds: [buildPlayerCompareEmbed(result.value, getBotConfig())],
    allowedMentions: { parse: [] },
  });
}

export async function handlePlayerCompareAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondWithPlayerChoices(interaction);
}
