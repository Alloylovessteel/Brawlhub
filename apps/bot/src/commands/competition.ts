import { createLogger } from '@brawlhub/logging';
import {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { getBotConfig } from '../config';
import { filterRegisteredClubs, getRegisteredClubs } from '../clubs/service';
import {
  logAutocompleteError,
  replyWithSafeError,
  safeErrorMessage,
} from '../discord/errors';
import {
  buildPaginationRowWithState,
  isPaginationButtonWithState,
  paginate,
  parsePaginationCustomIdWithState,
  type Page,
} from '../discord/pagination';
import type { PlayerIdentity } from '../players/types';
import {
  buildCompetitionCreatedEmbed,
  buildCompetitionEndedEmbed,
  buildCompetitionJoinedEmbed,
  buildCompetitionLeaderboardEmbed,
  buildCompetitionListEmbed,
  buildCompetitionSubmittedEmbed,
} from '../competition/embed';
import {
  canManageCompetition,
  createCompetition,
  endCompetition,
  joinCompetition,
  listCompetitions,
  listVerifiedPlayers,
  loadCompetitionRecord,
  loadCompetitionLeaderboard,
  loadCompetitionPlayer,
  CompetitionServiceError,
  resolveCompetitionActor,
  submitCompetitionResult,
} from '../competition/service';
import type { CompetitionLeaderboardView } from '../competition/types';

const logger = createLogger('bot');
const COMMAND_NAME = 'competition';
const LEADERBOARD_PAGE_SIZE = 10;
const LIST_PAGE_SIZE = 5;

type CompetitionPageState =
  | { readonly kind: 'leaderboard'; readonly competitionId: string }
  | { readonly kind: 'list' };

interface PagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

export const competitionCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Create, join and follow Brawl Stars competitions')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('create')
      .setDescription('Create a competition (authorised staff only)')
      .addStringOption((option) =>
        option.setName('name').setDescription('Competition name').setRequired(true).setMaxLength(100),
      )
      .addStringOption((option) =>
        option
          .setName('start')
          .setDescription('Start date/time, e.g. 2026-11-25T18:00Z')
          .setRequired(true)
          .setMaxLength(40),
      )
      .addStringOption((option) =>
        option
          .setName('end')
          .setDescription('End date/time, e.g. 2026-11-26T21:00Z')
          .setRequired(true)
          .setMaxLength(40),
      )
      .addStringOption((option) =>
        option
          .setName('description')
          .setDescription('Rules shown on the competition')
          .setRequired(false)
          .setMaxLength(1000),
      )
      .addStringOption((option) =>
        option
          .setName('club')
          .setDescription('Optional registered club restriction')
          .setAutocomplete(true)
          .setRequired(false),
      )
      .addIntegerOption((option) =>
        option
          .setName('goal')
          .setDescription('Optional trophy goal')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(2_147_483_647),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('join')
      .setDescription('Join an upcoming or active competition with one verified account')
      .addStringOption((option) =>
        option
          .setName('competition')
          .setDescription('Competition to join')
          .setAutocomplete(true)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('account')
          .setDescription('One of your verified Brawl Stars accounts')
          .setAutocomplete(true)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('submit')
      .setDescription('Record an unverified trophy result during the competition period')
      .addStringOption((option) =>
        option
          .setName('competition')
          .setDescription('Competition to submit to')
          .setAutocomplete(true)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('account')
          .setDescription('One of your verified Brawl Stars accounts')
          .setAutocomplete(true)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName('trophies')
          .setDescription('Current trophy count')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(2_147_483_647),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('leaderboard')
      .setDescription('Show the competition leaderboard')
      .addStringOption((option) =>
        option
          .setName('competition')
          .setDescription('Competition to display')
          .setAutocomplete(true)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('end')
      .setDescription('End a competition and preserve all history (authorised staff only)')
      .addStringOption((option) =>
        option
          .setName('competition')
          .setDescription('Competition to end')
          .setAutocomplete(true)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('list').setDescription('List upcoming, active and completed competitions'),
  );

function encodeState(state: CompetitionPageState): string {
  return state.kind === 'list' ? 'list' : `leaderboard|${state.competitionId}`;
}

function decodeState(raw: string): CompetitionPageState | null {
  if (raw === 'list') return { kind: 'list' };
  const [kind, competitionId] = raw.split('|');
  if (kind === 'leaderboard' && competitionId !== undefined && competitionId.length > 0) {
    return { kind: 'leaderboard', competitionId };
  }
  return null;
}

function paginationFor(state: CompetitionPageState, page: Page<unknown>): ActionRowBuilder<ButtonBuilder>[] {
  const row = buildPaginationRowWithState(
    COMMAND_NAME,
    page.page,
    page.pageCount,
    encodeState(state),
  );
  return row === null ? [] : [row];
}

function optionString(interaction: ChatInputCommandInteraction, name: string): string {
  return interaction.options.getString(name, false) ?? '';
}

function optionInteger(interaction: ChatInputCommandInteraction, name: string): number | null {
  return interaction.options.getInteger(name, false);
}

async function replyCompetitionError(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  error: unknown,
): Promise<void> {
  if (error instanceof CompetitionServiceError) {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: error.message, ephemeral: true });
    } else {
      await interaction.reply({ content: error.message, ephemeral: true });
    }
    return;
  }
  throw error;
}

async function loadLeaderboardPage(
  competitionId: string,
  guildId: string | null,
  pageNumber: number,
): Promise<{ view: CompetitionLeaderboardView; payload: PagePayload }> {
  const view = await loadCompetitionLeaderboard(competitionId, { guildId });
  const page = paginate(view.rows, pageNumber, LEADERBOARD_PAGE_SIZE);
  const state: CompetitionPageState = { kind: 'leaderboard', competitionId };
  return {
    view,
    payload: {
      embeds: [buildCompetitionLeaderboardEmbed(view, page, getBotConfig())],
      components: paginationFor(state, page),
    },
  };
}

async function loadListPage(guildId: string | null, pageNumber: number): Promise<PagePayload> {
  const competitions = await listCompetitions({ guildId });
  const page = paginate(competitions, pageNumber, LIST_PAGE_SIZE);
  return {
    embeds: [buildCompetitionListEmbed(competitions, page)],
    components: paginationFor({ kind: 'list' }, page),
  };
}

async function requirePlayer(playerId: string): Promise<PlayerIdentity> {
  const player = await loadCompetitionPlayer(playerId);
  if (player === null) {
    throw new CompetitionServiceError('invalid_selection', 'That Brawl Stars account could not be found.');
  }
  return player;
}

export async function handleCompetition(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);
  try {
    if (subcommand === 'create') {
      const competition = await createCompetition({
        discordUserId: interaction.user.id,
        name: optionString(interaction, 'name'),
        description: optionString(interaction, 'description') || null,
        start: optionString(interaction, 'start'),
        end: optionString(interaction, 'end'),
        clubId: optionString(interaction, 'club') || null,
        goal: optionInteger(interaction, 'goal'),
      }, { guildId: interaction.guildId });
      await interaction.reply({
        embeds: [buildCompetitionCreatedEmbed(competition)],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'join') {
      const competitionId = optionString(interaction, 'competition');
      const playerId = optionString(interaction, 'account');
      const result = await joinCompetition({
        discordUserId: interaction.user.id,
        competitionId,
        playerId,
      }, { guildId: interaction.guildId });
      const [competition, player] = await Promise.all([
        loadCompetitionRecord(competitionId, { guildId: interaction.guildId }),
        requirePlayer(playerId),
      ]);
      if (competition === null) {
        throw new CompetitionServiceError('not_found', 'That competition could not be found.');
      }
      await interaction.reply({
        embeds: [buildCompetitionJoinedEmbed(competition, player, result, getBotConfig())],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'submit') {
      const competitionId = optionString(interaction, 'competition');
      const playerId = optionString(interaction, 'account');
      const trophies = optionInteger(interaction, 'trophies');
      if (trophies === null) {
        throw new CompetitionServiceError('invalid_trophies', 'Enter a trophy count of 0 or more.');
      }
      const result = await submitCompetitionResult({
        discordUserId: interaction.user.id,
        competitionId,
        playerId,
        trophies,
      }, { guildId: interaction.guildId });
      const [competition, player] = await Promise.all([
        loadCompetitionRecord(competitionId, { guildId: interaction.guildId }),
        requirePlayer(playerId),
      ]);
      if (competition === null) {
        throw new CompetitionServiceError('not_found', 'That competition could not be found.');
      }
      await interaction.reply({
        embeds: [buildCompetitionSubmittedEmbed(competition, player, result, getBotConfig())],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'leaderboard') {
      const { payload } = await loadLeaderboardPage(
        optionString(interaction, 'competition'),
        interaction.guildId,
        1,
      );
      await interaction.reply({ ...payload, allowedMentions: { parse: [] } });
      return;
    }

    if (subcommand === 'end') {
      const competition = await endCompetition({
        discordUserId: interaction.user.id,
        competitionId: optionString(interaction, 'competition'),
      }, { guildId: interaction.guildId });
      await interaction.reply({
        embeds: [buildCompetitionEndedEmbed(competition, interaction.user.id)],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'list') {
      await interaction.reply({ ...(await loadListPage(interaction.guildId, 1)), allowedMentions: { parse: [] } });
      return;
    }

    await interaction.reply({ content: 'Choose a competition subcommand.', ephemeral: true });
  } catch (error) {
    try {
      await replyCompetitionError(interaction, error);
    } catch (unexpected) {
      const { token } = getBotConfig();
      logger.error('Competition command failed', {
        subcommand: subcommand ?? 'unknown',
        error: safeErrorMessage(unexpected, token === undefined ? [] : [token]),
      });
      await replyWithSafeError(interaction);
    }
  }
}

export async function handleCompetitionComponent(interaction: ButtonInteraction): Promise<void> {
  if (!isPaginationButtonWithState(interaction, COMMAND_NAME)) return;
  const parsed = parsePaginationCustomIdWithState(interaction.customId, COMMAND_NAME);
  if (parsed === null) return;
  const state = decodeState(parsed.state);
  if (state === null) return;

  try {
    await interaction.deferUpdate();
    const payload =
      state.kind === 'list'
        ? await loadListPage(interaction.guildId, parsed.page)
        : (await loadLeaderboardPage(state.competitionId, interaction.guildId, parsed.page)).payload;
    await interaction.editReply({ ...payload, content: null, allowedMentions: { parse: [] } });
  } catch (error) {
    try {
      await replyCompetitionError(interaction, error);
    } catch (unexpected) {
      const { token } = getBotConfig();
      logger.error('Competition pagination failed', {
        error: safeErrorMessage(unexpected, token === undefined ? [] : [token]),
      });
      await replyWithSafeError(interaction);
    }
  }
}

async function competitionChoices(
  interaction: AutocompleteInteraction,
  focusedValue: string,
): Promise<{ name: string; value: string }[]> {
  const query = focusedValue.trim().toLowerCase();
  let competitions = await listCompetitions({ guildId: interaction.guildId });

  const subcommand = interaction.options.getSubcommand(false);
  if (subcommand === 'end') {
    const actor = await resolveCompetitionActor(interaction.user.id);
    competitions = competitions.filter((competition) =>
      canManageCompetition(actor, competition.clubId),
    );
  }

  return competitions
    .filter((competition) => {
      if (query.length === 0) return true;
      return (
        competition.name.toLowerCase().includes(query) ||
        (competition.club?.tag.toLowerCase().includes(query) ?? false)
      );
    })
    .slice(0, 25)
    .map((competition) => ({
      name: `${competition.name}${competition.club === null ? '' : ` (#${competition.club.tag})`}`,
      value: competition.id,
    }));
}

async function accountChoices(
  interaction: AutocompleteInteraction,
  focusedValue: string,
): Promise<{ name: string; value: string }[]> {
  const actor = await resolveCompetitionActor(interaction.user.id);
  const players = await listVerifiedPlayers(actor.profileId);
  const query = focusedValue.trim().toLowerCase();
  return players
    .filter(
      (player) =>
        query.length === 0 ||
        player.name.toLowerCase().includes(query) ||
        player.tag.toLowerCase().includes(query),
    )
    .slice(0, 25)
    .map((player) => ({
      name: `${player.name} (#${player.tag})`,
      value: player.id,
    }));
}

async function clubChoices(
  focusedValue: string,
  guildId: string | null,
): Promise<{ name: string; value: string }[]> {
  const clubs = await getRegisteredClubs(guildId);
  return filterRegisteredClubs(clubs, focusedValue).slice(0, 25).map((club) => ({
    name: `${club.name} (#${club.tag})`,
    value: club.id,
  }));
}

export async function handleCompetitionAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  try {
    const focused = interaction.options.getFocused(true);
    const choices =
      focused.name === 'club'
        ? await clubChoices(focused.value, interaction.guildId)
        : focused.name === 'competition'
          ? await competitionChoices(interaction, focused.value)
          : focused.name === 'account'
            ? await accountChoices(interaction, focused.value)
            : [];
    await interaction.respond(choices);
  } catch (error) {
    const { token } = getBotConfig();
    logAutocompleteError(logger, COMMAND_NAME, error, token === undefined ? [] : [token]);
    await interaction.respond([]).catch(() => undefined);
  }
}
