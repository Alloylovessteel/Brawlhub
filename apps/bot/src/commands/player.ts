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
import { handleMeLive, handleMeLiveStop } from './me-live.js';
import { handleMeChart } from './me-chart.js';
import { meTagErrorMessage, resolveMeTag } from './me-utils.js';
import { CHART_OPTIONS, isChartOption, type ChartOption } from '../images/chart-render.js';
import {
  PLAYER_PERIOD_CHOICES,
  replyPlayerLookupFailure,
  respondWithPlayerChoices,
} from './player-utils';

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

const CHART_CHOICES: ReadonlyArray<{ readonly name: string; readonly value: ChartOption }> =
  CHART_OPTIONS.map((option) => ({
    name: option.replaceAll('_', ' ').replace(/^./, (character) => character.toUpperCase()),
    value: option,
  }));

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
  )
  .addSubcommand((subcommand) =>
    addTagOption(
      subcommand
        .setName('live')
        .setDescription('Opt in to live battle updates for a player in this channel'),
    ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('live-stop')
      .setDescription('Stop your live battle updates in this channel'),
  )
  .addSubcommand((subcommand) => {
    subcommand.setName('chart').setDescription('Post a stored-data chart as a PNG');
    subcommand.addStringOption((option) => {
      option
        .setName('option')
        .setDescription('Which stored-data chart to render')
        .setRequired(true);
      for (const choice of CHART_CHOICES) option.addChoices(choice);
      return option;
    });
    addTagOption(subcommand);
    subcommand.addStringOption((option) => {
      option.setName('period').setDescription('Stored history window').setRequired(false);
      for (const choice of PLAYER_PERIOD_CHOICES) option.addChoices(choice);
      return option;
    });
    return subcommand;
  });

/** Dispatch all `/me` subcommands without registering a 19th anchor. */
export async function handleMe(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);

  if (subcommand === 'image') {
    await handleMeImage(interaction);
    return;
  }
  if (subcommand === 'live') {
    await handleMeLive(interaction);
    return;
  }
  if (subcommand === 'live-stop') {
    await handleMeLiveStop(interaction);
    return;
  }
  if (subcommand === 'chart') {
    const rawOption = interaction.options.getString('option', true);
    const option = isChartOption(rawOption) ? rawOption : 'trophies';
    await handleMeChart(interaction, option);
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
