import { createLogger } from '@brawlhub/logging';
import {
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { getBotConfig } from '../config';
import type { ApiIssue } from '../clubs/types';
import { buildClubEmbed } from '../clubs/embed';
import { filterRegisteredClubs, getRegisteredClubs, loadClubView } from '../clubs/service';

const logger = createLogger('bot');

export const clubCommandData = new SlashCommandBuilder()
  .setName('club')
  .setDescription('Show detailed information about a registered Brawl Stars club')
  .addStringOption((option) =>
    option
      .setName('tag')
      .setDescription('Registered club tag, for example 2UG9UGQJY')
      .setAutocomplete(true)
      .setRequired(false)
      .setMaxLength(11),
  );

const INVALID_TAG_MESSAGE =
  'That club tag is not valid. Brawl Stars tags use 3–10 characters from 0, 2, 8, 9, C, G, J, L, P, Q, R, U, V and Y.';

function apiNotice(issue: ApiIssue | null): string | undefined {
  if (issue === 'rate-limit') {
    return 'The Brawl Stars API is rate limited right now. Showing the latest synced data.';
  }
  if (issue !== null) {
    return 'Live Brawl Stars data is unavailable right now. Showing the latest synced data.';
  }
  return undefined;
}

/** Handle `/club` and `/club tag:<tag>` without registering unknown clubs. */
export async function handleClub(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const rawTag = interaction.options.getString('tag', false) ?? undefined;
  const config = getBotConfig();
  const now = new Date();
  const result = await loadClubView({
    tag: rawTag,
    guildId: interaction.guildId,
    now,
    seasonStartIso: config.seasonStartIso,
  });

  if (result.kind === 'invalid-tag') {
    await interaction.editReply({ content: INVALID_TAG_MESSAGE, allowedMentions: { parse: [] } });
    return;
  }

  if (result.kind === 'unregistered') {
    await interaction.editReply({
      content:
        `Club #${result.tag} is not registered with BrawlHub. ` +
        'An authorised user must register/link the club first.',
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (result.kind === 'no-default') {
    await interaction.editReply({
      content:
        'No default club is configured for this server and more than one club is registered. ' +
        'Use `/club tag:<tag>` to choose one.',
      allowedMentions: { parse: [] },
    });
    return;
  }

  const embed = buildClubEmbed(result.view, config, now);
  const content = apiNotice(result.view.apiIssue);
  await interaction.editReply({
    ...(content === undefined ? {} : { content }),
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

/** Suggest registered club names and tags for the `tag` option. */
export async function handleClubAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  try {
    const clubs = await getRegisteredClubs();
    const query = interaction.options.getFocused();
    const choices = filterRegisteredClubs(clubs, query).map((club) => ({
      name: `${club.name} (#${club.tag})`,
      value: club.tag,
    }));
    await interaction.respond(choices);
  } catch (error) {
    logger.warn('Club autocomplete could not read registered clubs', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await interaction.respond([]).catch(() => undefined);
  }
}
