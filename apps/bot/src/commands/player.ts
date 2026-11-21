import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { findVerifiedPlayerForDiscordUser } from '../verification/index.js';
import {
  buildMeResponse,
  createMeSession,
  deleteMeSession,
  type MeSessionInput,
} from './me-components.js';
import { replyPlayerLookupFailure, respondWithPlayerChoices } from './player-utils';

export const meCommandData = new SlashCommandBuilder()
  .setName('me')
  .setDescription('Show an interactive Brawl Stars player overview')
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

  const guildId = interaction.guildId;
  const isDm = guildId === null;
  const session: MeSessionInput = {
    guildId: guildId ?? '',
    userId: interaction.user.id,
    tag,
    section: 'summary',
    page: 1,
  };
  const nonce = isDm ? 'dm' : createMeSession(session);
  const built = await buildMeResponse(session, nonce);

  if (built.kind === 'lookup-failure') {
    if (!isDm) deleteMeSession(nonce);
    await replyPlayerLookupFailure(interaction, built.failure);
    return;
  }

  await interaction.editReply({
    ...built.payload,
    // Components are guild-only: never expose actor-bound buttons in DMs.
    components: isDm ? [] : built.payload.components,
    allowedMentions: { parse: [] },
  });
}

export async function handleMeAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondWithPlayerChoices(interaction, 'tag');
}
