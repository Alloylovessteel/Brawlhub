import {
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type SlashCommandSubcommandBuilder,
} from 'discord.js';
import {
  buildMeResponse,
  createMeSession,
  deleteMeSession,
  type MeSessionInput,
} from './me-components.js';
import { handleMeImage } from './me-image.js';
import { meTagErrorMessage, resolveMeTag } from './me-utils.js';
import { replyPlayerLookupFailure, respondWithPlayerChoices } from './player-utils';

function addTagOption(subcommand: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  subcommand.addStringOption((option) =>
    option
      .setName('tag')
      .setDescription('Player tag, for example #PLAYERTAG. Leave blank to use your verified player.')
      .setAutocomplete(true)
      .setRequired(false)
      .setMaxLength(11),
  );
  return subcommand;
}

export const meCommandData = new SlashCommandBuilder()
  .setName('me')
  .setDescription('Show your Brawl Stars player profile or post a player card')
  .addSubcommand((subcommand) =>
    addTagOption(
      subcommand
        .setName('profile')
        .setDescription('Show an interactive Brawl Stars player overview'),
    ),
  )
  .addSubcommand((subcommand) =>
    addTagOption(
      subcommand
        .setName('image')
        .setDescription('Post a Brawl Stars player profile card in this channel'),
    ),
  );

/** Dispatch `/me profile` and `/me image` without registering a 19th anchor. */
export async function handleMe(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);

  if (subcommand === 'image') {
    await handleMeImage(interaction);
    return;
  }
  if (subcommand !== null && subcommand !== 'profile') {
    await interaction.reply({
      content: 'Unknown `/me` subcommand.',
      flags: 64,
      allowedMentions: { parse: [] },
    });
    return;
  }

  await handleMeProfile(interaction);
}

async function handleMeProfile(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const resolved = await resolveMeTag(interaction, 'profile');
  if (resolved.kind !== 'ok') {
    await interaction.editReply({
      content: meTagErrorMessage(resolved, 'profile'),
      allowedMentions: { parse: [] },
    });
    return;
  }

  const guildId = interaction.guildId;
  const isDm = guildId === null;
  const session: MeSessionInput = {
    guildId: guildId ?? '',
    userId: interaction.user.id,
    tag: resolved.tag,
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
