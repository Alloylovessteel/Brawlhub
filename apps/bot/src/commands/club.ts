import { createLogger } from '@brawlhub/logging';
import {
  ActionRowBuilder,
  ButtonBuilder,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
} from 'discord.js';
import { getBotConfig, type BotConfig } from '../config';
import {
  buildClubEmbed,
  buildClubMemberDetailsPageEmbed,
  buildClubMembersPageEmbed,
  buildClubPreviousMembersEmbed,
  buildClubStaffEmbed,
} from '../clubs/embed';
import {
  loadClubMemberDetails,
  loadClubPreviousMembers,
  loadClubView,
  loadSyncedClub,
} from '../clubs/service';
import type {
  ApiIssue,
  ClubLookupFailure,
  ClubMemberFilter,
  ClubMemberSort,
} from '../clubs/types';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import {
  buildPaginationRowWithState,
  isPaginationButtonWithState,
  paginate,
  parsePaginationCustomIdWithState,
} from '../discord/pagination';
import { replyWithSafeError } from '../discord/errors';
import { resolveClubBadgeUrl } from '../metadata/assets.js';
import {
  DEFAULT_PAGINATION_STATE,
  mapClubLookupFailureMessage,
  paginationStateForTag,
  readClubChooserSelection,
  replyWithClubChooserIfNeeded,
  respondWithClubChoices,
  tagFromPaginationState,
} from './club-utils';

const logger = createLogger('bot');
const COMMAND_NAME = 'club';
const PAGE_SIZE = 10;

type ClubSection = 'overview' | 'staff' | 'members' | 'details' | 'previous';

const SECTION_CHOICES: ReadonlyArray<{ readonly name: string; readonly value: ClubSection }> = [
  { name: 'Overview (live when available)', value: 'overview' },
  { name: 'Staff', value: 'staff' },
  { name: 'Members', value: 'members' },
  { name: 'Member Details', value: 'details' },
  { name: 'Previous Members', value: 'previous' },
];

const SORT_CHOICES: ReadonlyArray<{ readonly name: string; readonly value: ClubMemberSort }> = [
  { name: 'Current trophies', value: 'trophies' },
  { name: 'Highest trophies', value: 'highest' },
  { name: 'Last match', value: 'last-match' },
  { name: 'Joined club', value: 'joined' },
  { name: 'Name', value: 'name' },
];

const FILTER_CHOICES: ReadonlyArray<{ readonly name: string; readonly value: ClubMemberFilter }> = [
  { name: 'Ranked', value: 'ranked' },
  { name: 'Ranked all-time', value: 'ranked-all-time' },
  { name: 'Daily push', value: 'daily-push' },
  { name: 'Weekly push', value: 'weekly-push' },
  { name: 'Season push', value: 'season-push' },
  { name: 'Joined club', value: 'joined-club' },
  { name: 'Solo wins', value: 'solo-wins' },
  { name: 'Duo wins', value: 'duo-wins' },
  { name: '3vs3', value: 'three-vs-three' },
];

export const clubCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Show detailed information about a registered Brawl Stars club')
  .addStringOption((option) =>
    option
      .setName('tag')
      .setDescription('Registered club tag, for example #ABCD1234')
      .setAutocomplete(true)
      .setRequired(false)
      .setMaxLength(11),
  )
  .addStringOption((option) => {
    option.setName('section').setDescription('Which club section to show').setRequired(false);
    for (const choice of SECTION_CHOICES) option.addChoices(choice);
    return option;
  })
  .addStringOption((option) => {
    option.setName('sort').setDescription('Sort member details by a stored value').setRequired(false);
    for (const choice of SORT_CHOICES) option.addChoices(choice);
    return option;
  })
  .addStringOption((option) => {
    option
      .setName('filter')
      .setDescription('Filter member details by a stored stat')
      .setRequired(false);
    for (const choice of FILTER_CHOICES) option.addChoices(choice);
    return option;
  })
  .addStringOption((option) =>
    option
      .setName('member')
      .setDescription('Find a member by name or tag (member details only)')
      .setRequired(false)
      .setMaxLength(24),
  )
  .addBooleanOption((option) =>
    option
      .setName('previous')
      .setDescription('Also show previous club members from stored history')
      .setRequired(false),
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

export interface ClubDetailsReply {
  readonly content?: string;
  readonly embeds: EmbedBuilder[];
  readonly failure?: ClubLookupFailure;
}

/** Shared renderer for the club overview select menu and the `/club` overview section. */
export async function buildClubDetailsReply(
  tag: string | undefined,
  guildId: string | null,
  config: BotConfig,
  now: Date,
): Promise<ClubDetailsReply> {
  const result = await loadClubView({
    tag,
    guildId,
    now,
    seasonStartIso: config.seasonStartIso,
  });

  if (result.kind === 'invalid-tag') {
    return { content: INVALID_TAG_MESSAGE, embeds: [], failure: result };
  }

  if (result.kind === 'unregistered') {
    return {
      content:
        `Club #${result.tag} is not registered with BrawlHub. ` +
        'An authorised user must register/link the club first.',
      embeds: [],
      failure: result,
    };
  }

  if (result.kind === 'no-default') {
    return {
      content:
        'No default club is configured for this server and more than one club is registered. ' +
        'Use `/club tag:<tag>` to choose one.',
      embeds: [],
      failure: result,
    };
  }

  const badgeUrl = await resolveClubBadgeUrl(result.view.badgeId);
  const embed = buildClubEmbed(result.view, config, now, badgeUrl);
  const content = apiNotice(result.view.apiIssue);
  return { ...(content === undefined ? {} : { content }), embeds: [embed] };
}

interface ClubSectionState {
  readonly tag: string | undefined;
  readonly section: ClubSection;
  readonly sort: ClubMemberSort;
  readonly filter: ClubMemberFilter | null;
  readonly member: string | null;
  readonly previous: boolean;
}

interface ClubSectionContent {
  readonly content?: string;
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

type ClubSectionReply =
  | ({ readonly kind: 'ok' } & ClubSectionContent)
  | { readonly kind: 'lookup-failure'; readonly failure: ClubLookupFailure };

function isClubSection(value: string): value is ClubSection {
  return SECTION_CHOICES.some((choice) => choice.value === value);
}

function isClubMemberSort(value: string): value is ClubMemberSort {
  return SORT_CHOICES.some((choice) => choice.value === value);
}

function isClubMemberFilter(value: string): value is ClubMemberFilter {
  return FILTER_CHOICES.some((choice) => choice.value === value);
}

/** Encode the exact `/club` lookup into a compact, Discord-safe pagination state. */
function encodeSectionState(state: ClubSectionState): string {
  const member = (state.member ?? '').replace(/[^a-zA-Z0-9 ]/g, '').trim().slice(0, 24) || '-';
  return [
    state.section,
    state.sort,
    state.filter ?? '-',
    member.replace(/ /g, '_'),
    state.previous ? '1' : '0',
    paginationStateForTag(state.tag),
  ].join('|');
}

function decodeSectionState(raw: string): ClubSectionState | null {
  const parts = raw.split('|');
  if (parts.length !== 6) return null;
  const [section, sort, filter, member, previous, tagState] = parts;
  if (section === undefined || sort === undefined || !isClubSection(section) || !isClubMemberSort(sort)) {
    return null;
  }
  const parsedFilter = filter === '-' ? null : (filter ?? null);
  if (parsedFilter !== null && !isClubMemberFilter(parsedFilter)) return null;
  return {
    tag: tagFromPaginationState(tagState ?? DEFAULT_PAGINATION_STATE),
    section,
    sort,
    filter: parsedFilter,
    member: member === '-' || member === undefined ? null : member.replace(/_/g, ' '),
    previous: previous === '1',
  };
}

function failureReply(failure: ClubLookupFailure): ClubSectionReply {
  return { kind: 'lookup-failure', failure };
}

/** Build the requested `/club` section, with stored-data-only details and previous members. */
async function buildClubSectionReply(
  input: ClubSectionState & { readonly guildId: string | null },
  config: BotConfig,
  now: Date,
): Promise<ClubSectionReply> {
  const embeds: EmbedBuilder[] = [];
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  let content: string | undefined;

  if (input.section === 'previous') {
    const result = await loadClubPreviousMembers({
      tag: input.tag,
      guildId: input.guildId,
    });
    if (result.kind !== 'ok') return failureReply(result);
    embeds.push(buildClubPreviousMembersEmbed(result.value, config));
    return { kind: 'ok', embeds, components };
  }

  if (input.section === 'staff') {
    const result = await loadSyncedClub({ tag: input.tag, guildId: input.guildId });
    if (result.kind !== 'ok') return failureReply(result);
    embeds.push(buildClubStaffEmbed(result.value, config));
  } else if (input.section === 'overview') {
    const reply = await buildClubDetailsReply(input.tag, input.guildId, config, now);
    if (reply.failure !== undefined) return failureReply(reply.failure);
    content = reply.content;
    if (reply.embeds.length === 0) {
      return { kind: 'ok', ...(content === undefined ? {} : { content }), embeds: [], components: [] };
    }
    embeds.push(...reply.embeds);
  } else {
    const result = await loadClubMemberDetails({
      tag: input.tag,
      guildId: input.guildId,
      sort: input.sort,
      filter: input.section === 'details' ? input.filter : null,
      search: input.section === 'details' ? input.member : null,
      now,
      seasonStartIso: config.seasonStartIso,
    });
    if (result.kind !== 'ok') return failureReply(result);

    const page = paginate(result.value.members, 1, PAGE_SIZE);
    const row = buildPaginationRowWithState(
      COMMAND_NAME,
      page.page,
      page.pageCount,
      encodeSectionState(input),
    );
    embeds.push(
      input.section === 'details'
        ? buildClubMemberDetailsPageEmbed(result.value, page, config)
        : buildClubMembersPageEmbed(result.value, page, config),
    );
    if (row !== null) components.push(row);
  }

  if (input.previous) {
    const result = await loadClubPreviousMembers({ tag: input.tag, guildId: input.guildId });
    if (result.kind === 'ok') embeds.push(buildClubPreviousMembersEmbed(result.value, config));
  }

  return { kind: 'ok', ...(content === undefined ? {} : { content }), embeds, components };
}

/** Handle `/club` with optional sections, sorting, filters and previous members. */
export async function handleClub(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const config = getBotConfig();
  const rawSection = interaction.options.getString('section', false);
  const rawSort = interaction.options.getString('sort', false);
  const rawFilter = interaction.options.getString('filter', false);
  const state: ClubSectionState = {
    tag: interaction.options.getString('tag', false) ?? undefined,
    section: rawSection !== null && isClubSection(rawSection) ? rawSection : 'overview',
    sort: rawSort !== null && isClubMemberSort(rawSort) ? rawSort : 'trophies',
    filter: rawFilter !== null && isClubMemberFilter(rawFilter) ? rawFilter : null,
    member: interaction.options.getString('member', false),
    previous: interaction.options.getBoolean('previous', false) === true,
  };

  try {
    const reply = await buildClubSectionReply(
      { ...state, guildId: interaction.guildId },
      config,
      new Date(),
    );
    if (reply.kind === 'lookup-failure') {
      if (
        await replyWithClubChooserIfNeeded(interaction, COMMAND_NAME, reply.failure, {
          ...state,
          tag: undefined,
        })
      ) {
        return;
      }
      await interaction.editReply({
        content: mapClubLookupFailureMessage(reply.failure),
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      });
      return;
    }
    await interaction.editReply({
      ...(reply.content === undefined ? {} : { content: reply.content }),
      embeds: reply.embeds,
      components: reply.components,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.error('Club detail lookup failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}

export async function handleClubComponent(interaction: CommandComponentInteraction): Promise<void> {
  const chooser = readClubChooserSelection<ClubSectionState>(interaction, COMMAND_NAME);
  if (chooser.kind !== 'none') {
    try {
      await interaction.deferUpdate();
      if (chooser.kind === 'expired') {
        await interaction.editReply({
          content: 'That club chooser expired. Run the command again.',
          embeds: [],
          components: [],
        });
        return;
      }
      const reply = await buildClubSectionReply(
        { ...chooser.state, tag: chooser.tag, guildId: interaction.guildId },
        getBotConfig(),
        new Date(),
      );
      if (reply.kind === 'lookup-failure') {
        await interaction.editReply({
          content: 'This club is no longer available.',
          embeds: [],
          components: [],
        });
        return;
      }
      await interaction.editReply({
        ...(reply.content === undefined ? {} : { content: reply.content }),
        embeds: reply.embeds,
        components: reply.components,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      logger.error('Club chooser failed', {
        error: error instanceof Error ? error.message : 'unknown error',
      });
      await replyWithSafeError(interaction);
    }
    return;
  }

  if (!isPaginationButtonWithState(interaction, COMMAND_NAME)) return;
  const parsed = parsePaginationCustomIdWithState(interaction.customId, COMMAND_NAME);
  if (parsed === null) return;
  const state = decodeSectionState(parsed.state);
  if (state === null || (state.section !== 'members' && state.section !== 'details')) return;

  try {
    await interaction.deferUpdate();
    const config = getBotConfig();
    const result = await loadClubMemberDetails({
      tag: state.tag,
      guildId: interaction.guildId,
      sort: state.sort,
      filter: state.section === 'details' ? state.filter : null,
      search: state.section === 'details' ? state.member : null,
      seasonStartIso: config.seasonStartIso,
    });
    if (result.kind !== 'ok') {
      await interaction.editReply({
        content: 'This club is no longer available.',
        embeds: [],
        components: [],
      });
      return;
    }

    const page = paginate(result.value.members, parsed.page, PAGE_SIZE);
    const row = buildPaginationRowWithState(
      COMMAND_NAME,
      page.page,
      page.pageCount,
      encodeSectionState(state),
    );
    const embed =
      state.section === 'details'
        ? buildClubMemberDetailsPageEmbed(result.value, page, config)
        : buildClubMembersPageEmbed(result.value, page, config);
    const embeds = [embed];
    if (state.previous) {
      const previous = await loadClubPreviousMembers({ tag: state.tag, guildId: interaction.guildId });
      if (previous.kind === 'ok') embeds.push(buildClubPreviousMembersEmbed(previous.value, config));
    }
    await interaction.editReply({
      embeds,
      components: row === null ? [] : [row],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.error('Club member pagination failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}

/** Suggest registered club names and tags for the `tag` option. */
export async function handleClubAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondWithClubChoices(interaction, 'tag');
}
