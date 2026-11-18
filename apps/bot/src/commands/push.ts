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
  buildPushCreatedEmbed,
  buildPushEndedEmbed,
  buildPushJoinedEmbed,
  buildPushLeaderboardEmbed,
  buildPushListEmbed,
  buildPushSubmittedEmbed,
} from '../push/embed';
import {
  canManagePushCompetition,
  createPushCompetition,
  endPushCompetition,
  joinPushCompetition,
  listPushCompetitions,
  listVerifiedPlayers,
  loadPushCompetition,
  loadPushLeaderboard,
  loadPushPlayer,
  PushServiceError,
  resolvePushActor,
  submitPushResult,
} from '../push/service';
import type { PushLeaderboardView } from '../push/types';

const logger = createLogger('bot');
const COMMAND_NAME = 'push';
const LEADERBOARD_PAGE_SIZE = 10;
const LIST_PAGE_SIZE = 5;

type PushPageState =
  | { readonly kind: 'leaderboard'; readonly competitionId: string }
  | { readonly kind: 'list' };

interface PagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

export const pushCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Create, join and follow Brawl Stars push competitions')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('create')
      .setDescription('Create a push competition (authorised staff only)')
      .addStringOption((option) =>
        option.setName('name').setDescription('Competition name').setRequired(true).setMaxLength(100),
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

function encodeState(state: PushPageState): string {
  return state.kind === 'list' ? 'list' : `leaderboard|${state.competitionId}`;
}

function decodeState(raw: string): PushPageState | null {
  if (raw === 'list') return { kind: 'list' };
  const [kind, competitionId] = raw.split('|');
  if (kind === 'leaderboard' && competitionId !== undefined && competitionId.length > 0) {
    return { kind: 'leaderboard', competitionId };
  }
  return null;
}

function paginationFor(state: PushPageState, page: Page<unknown>): ActionRowBuilder<ButtonBuilder>[] {
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

async function replyPushError(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  error: unknown,
): Promise<void> {
  if (error instanceof PushServiceError) {
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
  pageNumber: number,
): Promise<{ view: PushLeaderboardView; payload: PagePayload }> {
  const view = await loadPushLeaderboard(competitionId);
  const page = paginate(view.rows, pageNumber, LEADERBOARD_PAGE_SIZE);
  const state: PushPageState = { kind: 'leaderboard', competitionId };
  return {
    view,
    payload: {
      embeds: [buildPushLeaderboardEmbed(view, page, getBotConfig())],
      components: paginationFor(state, page),
    },
  };
}

async function loadListPage(pageNumber: number): Promise<PagePayload> {
  const competitions = await listPushCompetitions();
  const page = paginate(competitions, pageNumber, LIST_PAGE_SIZE);
  return {
    embeds: [buildPushListEmbed(competitions, page)],
    components: paginationFor({ kind: 'list' }, page),
  };
}

async function requirePlayer(playerId: string): Promise<PlayerIdentity> {
  const player = await loadPushPlayer(playerId);
  if (player === null) {
    throw new PushServiceError('invalid_selection', 'That Brawl Stars account could not be found.');
  }
  return player;
}

export async function handlePush(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);
  try {
    if (subcommand === 'create') {
      const competition = await createPushCompetition({
        discordUserId: interaction.user.id,
        name: optionString(interaction, 'name'),
        description: optionString(interaction, 'description') || null,
        start: optionString(interaction, 'start'),
        end: optionString(interaction, 'end'),
        clubId: optionString(interaction, 'club') || null,
        goal: optionInteger(interaction, 'goal'),
      });
      await interaction.reply({
        embeds: [buildPushCreatedEmbed(competition)],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'join') {
      const competitionId = optionString(interaction, 'competition');
      const playerId = optionString(interaction, 'account');
      const result = await joinPushCompetition({
        discordUserId: interaction.user.id,
        competitionId,
        playerId,
      });
      const [competition, player] = await Promise.all([
        loadPushCompetition(competitionId),
        requirePlayer(playerId),
      ]);
      if (competition === null) {
        throw new PushServiceError('not_found', 'That competition could not be found.');
      }
      await interaction.reply({
        embeds: [buildPushJoinedEmbed(competition, player, result, getBotConfig())],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'submit') {
      const competitionId = optionString(interaction, 'competition');
      const playerId = optionString(interaction, 'account');
      const trophies = optionInteger(interaction, 'trophies');
      if (trophies === null) {
        throw new PushServiceError('invalid_trophies', 'Enter a trophy count of 0 or more.');
      }
      const result = await submitPushResult({
        discordUserId: interaction.user.id,
        competitionId,
        playerId,
        trophies,
      });
      const [competition, player] = await Promise.all([
        loadPushCompetition(competitionId),
        requirePlayer(playerId),
      ]);
      if (competition === null) {
        throw new PushServiceError('not_found', 'That competition could not be found.');
      }
      await interaction.reply({
        embeds: [buildPushSubmittedEmbed(competition, player, result, getBotConfig())],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'leaderboard') {
      const { payload } = await loadLeaderboardPage(optionString(interaction, 'competition'), 1);
      await interaction.reply({ ...payload, allowedMentions: { parse: [] } });
      return;
    }

    if (subcommand === 'end') {
      const competition = await endPushCompetition({
        discordUserId: interaction.user.id,
        competitionId: optionString(interaction, 'competition'),
      });
      await interaction.reply({
        embeds: [buildPushEndedEmbed(competition, interaction.user.id)],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'list') {
      await interaction.reply({ ...(await loadListPage(1)), allowedMentions: { parse: [] } });
      return;
    }

    await interaction.reply({ content: 'Choose a push subcommand.', ephemeral: true });
  } catch (error) {
    try {
      await replyPushError(interaction, error);
    } catch (unexpected) {
      const { token } = getBotConfig();
      logger.error('Push command failed', {
        subcommand: subcommand ?? 'unknown',
        error: safeErrorMessage(unexpected, token === undefined ? [] : [token]),
      });
      await replyWithSafeError(interaction);
    }
  }
}

export async function handlePushComponent(interaction: ButtonInteraction): Promise<void> {
  if (!isPaginationButtonWithState(interaction, COMMAND_NAME)) return;
  const parsed = parsePaginationCustomIdWithState(interaction.customId, COMMAND_NAME);
  if (parsed === null) return;
  const state = decodeState(parsed.state);
  if (state === null) return;

  try {
    await interaction.deferUpdate();
    const payload =
      state.kind === 'list'
        ? await loadListPage(parsed.page)
        : (await loadLeaderboardPage(state.competitionId, parsed.page)).payload;
    await interaction.editReply({ ...payload, content: null, allowedMentions: { parse: [] } });
  } catch (error) {
    try {
      await replyPushError(interaction, error);
    } catch (unexpected) {
      const { token } = getBotConfig();
      logger.error('Push pagination failed', {
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
  let competitions = await listPushCompetitions();

  const subcommand = interaction.options.getSubcommand(false);
  if (subcommand === 'end') {
    const actor = await resolvePushActor(interaction.user.id);
    competitions = competitions.filter((competition) =>
      canManagePushCompetition(actor, competition.clubId),
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
  const actor = await resolvePushActor(interaction.user.id);
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
): Promise<{ name: string; value: string }[]> {
  const clubs = await getRegisteredClubs();
  return filterRegisteredClubs(clubs, focusedValue).slice(0, 25).map((club) => ({
    name: `${club.name} (#${club.tag})`,
    value: club.id,
  }));
}

export async function handlePushAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  try {
    const focused = interaction.options.getFocused(true);
    const choices =
      focused.name === 'club'
        ? await clubChoices(focused.value)
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
