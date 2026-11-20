import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { buildPlayerProfileEmbed } from '../players/embed';
import { loadPlayerProfile } from '../players/service';
import { resolvePlayerIconUrl } from '../metadata/assets.js';
import { getBotConfig } from '../config';
import { findVerifiedPlayerForDiscordUser } from '../verification/index.js';
import { replyPlayerLookupFailure, respondWithPlayerChoices } from './player-utils';

export const meCommandData = new SlashCommandBuilder()
  .setName('me')
  .setDescription('Show a Brawl Stars player profile')
  .addStringOption((option) =>
    option
      .setName('tag')
      .setDescription('Player tag, for example #PLAYERTAG. Leave blank to use your verified player.')
      .setAutocomplete(true)
      .setRequired(false)
      .setMaxLength(11),
  );

export async function handleMe(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  let tag = interaction.options.getString('tag')?.trim() ?? '';
  if (tag === '') {
    try {
      const verified = await findVerifiedPlayerForDiscordUser(interaction.user.id);
      if (verified === null) {
        await interaction.editReply({
          content:
            'You do not have a verified Brawl Stars player yet. Use `/member-verify start tag:YOURTAG` to link one, or pass `tag:` explicitly.',
          allowedMentions: { parse: [] },
        });
        return;
      }
      tag = verified.tag;
    } catch {
      await interaction.editReply({
        content: 'Could not read your verified player right now. Please try again or pass `tag:` explicitly.',
        allowedMentions: { parse: [] },
      });
      return;
    }
  }

  const result = await loadPlayerProfile({
    tag,
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
