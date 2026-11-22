import { randomUUID } from 'node:crypto';
import { createLogger } from '@brawlhub/logging';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { getBotConfig } from '../config';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { replyWithSafeError, respondToAutocomplete } from '../discord/errors';
import {
  buildPaginationRowWithState,
  isPaginationButtonWithState,
  paginate,
  parsePaginationCustomIdWithState,
} from '../discord/pagination';
import { resolveBrawlerPortraitUrl } from '../metadata/assets.js';
import {
  createPersistentSession,
  deletePersistentSession,
  listPersistentSessions,
  persistVoid,
  updatePersistentSession,
} from '../state/index.js';
import { loadBrawlerCatalog } from '../players/catalog.js';
import {
  BRAWLER_FILTER_LABELS,
  BRAWLER_SORT_LABELS,
  buildBrawlerDetailEmbed,
  buildPlayerBrawlersPageEmbed,
} from '../players/embed';
import {
  BRAWLER_FILTERS,
  BRAWLER_SORTS,
  filterPlayerBrawlers,
  isBrawlerFilter,
  isBrawlerSort,
  loadPlayerBrawlers,
  sortPlayerBrawlers,
} from '../players/service';
import type {
  BrawlerFilter,
  BrawlerSort,
  PlayerBrawlerDetail,
  PlayerBrawlersView,
} from '../players/types';
import { findVerifiedPlayerForDiscordUser } from '../verification/index.js';
import {
  replyPlayerLookupFailure,
  respondWithPlayerChoices,
} from './player-utils';

const logger = createLogger('bot');
const COMMAND_NAME = 'brawlers';
const PAGE_SIZE = 10;
const SESSION_TTL_MS = 10 * 60 * 1000;

interface BrawlersSession {
  readonly guildId: string | null;
  readonly userId: string;
  readonly tag: string;
  readonly sort: BrawlerSort;
  readonly filter: BrawlerFilter;
  readonly page: number;
  readonly expiresAt: number;
}

const SESSION_COMMAND = 'brawlers';
const SESSION_KIND = 'refreshable';

const sessions = new Map<string, BrawlersSession>();

function persistSessionKey(nonce: string, session: BrawlersSession) {
  return {
    guildId: session.guildId ?? 'dm',
    command: SESSION_COMMAND,
    actorDiscordUserId: session.userId,
    nonce,
  };
}

/** Hydrate the synchronous mirror from Supabase when a service role is configured. */
function hydrateBrawlersSessions(): void {
  persistVoid(
    listPersistentSessions({ command: SESSION_COMMAND })
      .then((rows) => {
        for (const row of rows) {
          const session = row.payload as unknown as BrawlersSession;
          if (
            typeof session.userId === 'string' &&
            typeof session.tag === 'string' &&
            typeof session.expiresAt === 'number' &&
            session.expiresAt > Date.now()
          ) {
            sessions.set(row.nonce, session);
          }
        }
      })
      .catch(() => undefined),
    'hydrate brawler sessions',
  );
}

hydrateBrawlersSessions();

export const brawlersCommandData = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Show a player’s brawler roster from official Brawl Stars data')
  .addStringOption((option) =>
    option
      .setName('tag')
      .setDescription('Player tag, for example #PLAYERTAG. Leave blank for your verified player.')
      .setAutocomplete(true)
      .setRequired(false)
      .setMaxLength(11),
  )
  .addStringOption((option) => {
    option.setName('sort').setDescription('How to sort brawlers').setRequired(false);
    for (const sort of BRAWLER_SORTS) {
      option.addChoices({ name: BRAWLER_SORT_LABELS[sort], value: sort });
    }
    return option;
  })
  .addStringOption((option) => {
    option.setName('filter').setDescription('Which brawlers to show').setRequired(false);
    for (const filter of BRAWLER_FILTERS) {
      option.addChoices({ name: BRAWLER_FILTER_LABELS[filter], value: filter });
    }
    return option;
  });

export const brawlerCommandData = new SlashCommandBuilder()
  .setName('brawler')
  .setDescription('Show official details for one brawler in a player profile')
  .addStringOption((option) =>
    option
      .setName('name')
      .setDescription('Brawler name')
      .setAutocomplete(true)
      .setRequired(true)
      .setMaxLength(100),
  )
  .addStringOption((option) =>
    option
      .setName('tag')
      .setDescription('Player tag, for example #PLAYERTAG. Leave blank for your verified player.')
      .setAutocomplete(true)
      .setRequired(false)
      .setMaxLength(11),
  );

function pruneExpiredSessions(now: number): void {
  for (const [nonce, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(nonce);
  }
}

function createSession(input: Omit<BrawlersSession, 'expiresAt'>): string {
  pruneExpiredSessions(Date.now());
  const nonce = randomUUID().replace(/-/g, '').slice(0, 16);
  const session: BrawlersSession = { ...input, expiresAt: Date.now() + SESSION_TTL_MS };
  sessions.set(nonce, session);
  persistVoid(
    createPersistentSession({
      ...persistSessionKey(nonce, session),
      kind: SESSION_KIND,
      payload: session as unknown as Record<string, unknown>,
      expiresAt: session.expiresAt,
    }),
    'create brawler session',
  );
  return nonce;
}

function readSession(
  interaction: CommandComponentInteraction,
  nonce: string | null,
): BrawlersSession | null {
  if (nonce === null) return null;
  const session = sessions.get(nonce);
  if (session === undefined) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(nonce);
    persistVoid(
      deletePersistentSession(persistSessionKey(nonce, session)),
      'delete expired brawler session',
    );
    return null;
  }
  if (session.guildId !== interaction.guildId || session.userId !== interaction.user.id) {
    return null;
  }
  return session;
}

function refreshSession(nonce: string, session: BrawlersSession): BrawlersSession {
  const updated: BrawlersSession = { ...session, expiresAt: Date.now() + SESSION_TTL_MS };
  sessions.set(nonce, updated);
  persistVoid(
    updatePersistentSession(persistSessionKey(nonce, updated), {
      payload: updated as unknown as Record<string, unknown>,
      expiresAt: updated.expiresAt,
    }),
    'refresh brawler session',
  );
  return updated;
}

function parseAction(customId: string): {
  readonly kind: 'sort' | 'filter' | 'detail' | 'back';
  readonly nonce: string;
} | null {
  const parts = customId.split(':');
  if (parts.length !== 3 || parts[0] !== COMMAND_NAME) return null;
  const kind = parts[1];
  const nonce = parts[2];
  if (nonce === undefined || nonce === '') return null;
  if (kind === 'sort' || kind === 'filter' || kind === 'detail' || kind === 'back') {
    return { kind, nonce };
  }
  return null;
}

async function resolveTag(interaction: ChatInputCommandInteraction): Promise<string | null> {
  const explicit = interaction.options.getString('tag')?.trim() ?? '';
  if (explicit !== '') return explicit;
  try {
    const verified = await findVerifiedPlayerForDiscordUser(interaction.user.id);
    return verified?.tag ?? null;
  } catch {
    return null;
  }
}

function visibleBrawlers(view: PlayerBrawlersView, sort: BrawlerSort, filter: BrawlerFilter) {
  return sortPlayerBrawlers(
    filterPlayerBrawlers(view.brawlers, filter, view.catalog),
    sort,
  );
}

interface Payload {
  readonly embeds: ReturnType<typeof buildPlayerBrawlersPageEmbed>[];
  readonly components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
}

function sortRow(nonce: string, session: BrawlersSession): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`brawlers:sort:${nonce}`)
      .setPlaceholder('Sort brawlers')
      .addOptions(
        BRAWLER_SORTS.map((sort) => ({
          label: BRAWLER_SORT_LABELS[sort],
          value: sort,
          default: sort === session.sort,
        })),
      ),
  );
}

function filterRow(nonce: string, session: BrawlersSession): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`brawlers:filter:${nonce}`)
      .setPlaceholder('Filter brawlers')
      .addOptions(
        BRAWLER_FILTERS.map((filter) => ({
          label: BRAWLER_FILTER_LABELS[filter],
          value: filter,
          default: filter === session.filter,
        })),
      ),
  );
}

function detailRow(
  nonce: string,
  items: readonly PlayerBrawlerDetail[],
): ActionRowBuilder<StringSelectMenuBuilder> | null {
  if (items.length === 0) return null;
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`brawlers:detail:${nonce}`)
      .setPlaceholder('View brawler details')
      .addOptions(
        items.map((brawler, index) => ({
          label: brawler.name.slice(0, 100),
          value: String(index),
        })),
      ),
  );
}

function backRow(nonce: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`brawlers:back:${nonce}`)
      .setLabel('Back to roster')
      .setStyle(ButtonStyle.Secondary),
  );
}

async function buildRosterPayload(
  nonce: string,
  session: BrawlersSession,
  guildId: string | null,
  pageNumber: number,
): Promise<
  | { readonly kind: 'ok'; readonly payload: Payload }
  | { readonly kind: 'lookup-failure'; readonly failure: Parameters<typeof replyPlayerLookupFailure>[1] }
> {
  const result = await loadPlayerBrawlers({ tag: session.tag, guildId });
  if (result.kind !== 'ok') return { kind: 'lookup-failure', failure: result };

  const page = paginate(visibleBrawlers(result.value, session.sort, session.filter), pageNumber, PAGE_SIZE);
  const portraitUrl = await resolveBrawlerPortraitUrl(page.items[0]?.name ?? null);
  const updated = refreshSession(nonce, { ...session, page: page.page });
  const pagination = buildPaginationRowWithState(
    COMMAND_NAME,
    page.page,
    page.pageCount,
    nonce,
  );
  const detail = detailRow(nonce, page.items);
  const components: Payload['components'] = [sortRow(nonce, updated), filterRow(nonce, updated)];
  if (pagination !== null) components.push(pagination);
  if (detail !== null) components.push(detail);

  return {
    kind: 'ok',
    payload: {
      embeds: [
        buildPlayerBrawlersPageEmbed(
          result.value,
          page,
          session.sort,
          session.filter,
          getBotConfig(),
          portraitUrl,
        ),
      ],
      components,
    },
  };
}

async function buildDetailPayload(
  nonce: string,
  session: BrawlersSession,
  guildId: string | null,
  index: number,
): Promise<Payload | null> {
  const result = await loadPlayerBrawlers({ tag: session.tag, guildId });
  if (result.kind !== 'ok') return null;

  const page = paginate(visibleBrawlers(result.value, session.sort, session.filter), session.page, PAGE_SIZE);
  const brawler = page.items[index];
  if (brawler === undefined) return null;
  const portraitUrl = await resolveBrawlerPortraitUrl(brawler.name);
  return {
    embeds: [buildBrawlerDetailEmbed(result.value, brawler, getBotConfig(), portraitUrl)],
    components: [backRow(nonce)],
  };
}

async function replyExpired(interaction: CommandComponentInteraction): Promise<void> {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  await interaction.editReply({
    content: 'This brawler view has expired. Run `/brawlers list` again.',
    embeds: [],
    components: [],
    allowedMentions: { parse: [] },
  });
}

export async function handleBrawlers(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const tag = await resolveTag(interaction);
  if (tag === null) {
    await interaction.editReply({
      content:
        'No player tag was supplied and no verified Brawl Stars player is linked to you. ' +
        'Use `/brawlers list tag:YOURTAG` or verify with `/members verify tag:YOURTAG`.',
      allowedMentions: { parse: [] },
    });
    return;
  }

  const rawSort = interaction.options.getString('sort', false) ?? 'trophies';
  const rawFilter = interaction.options.getString('filter', false) ?? 'all';
  const sort: BrawlerSort = isBrawlerSort(rawSort) ? rawSort : 'trophies';
  const filter: BrawlerFilter = isBrawlerFilter(rawFilter) ? rawFilter : 'all';
  const nonce = createSession({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    tag,
    sort,
    filter,
    page: 1,
  });
  const session = sessions.get(nonce);
  if (session === undefined) return;

  const built = await buildRosterPayload(nonce, session, interaction.guildId, 1);
  if (built.kind === 'lookup-failure') {
    await replyPlayerLookupFailure(interaction, built.failure);
    return;
  }
  await interaction.editReply({
    ...built.payload,
    content: null,
    allowedMentions: { parse: [] },
  });
}

export async function handleBrawler(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const requestedName = interaction.options.getString('name', true).trim();
  const tag = await resolveTag(interaction);
  if (tag === null) {
    await interaction.editReply({
      content:
        'No player tag was supplied and no verified Brawl Stars player is linked to you. ' +
        'Use `/brawlers detail name:BRAWLER tag:YOURTAG` or verify with `/members verify tag:YOURTAG`.',
      allowedMentions: { parse: [] },
    });
    return;
  }

  const result = await loadPlayerBrawlers({ tag, guildId: interaction.guildId });
  if (result.kind !== 'ok') {
    await replyPlayerLookupFailure(interaction, result);
    return;
  }

  const key = requestedName.toLowerCase();
  const catalogOnly = filterPlayerBrawlers([], 'unowned', result.value.catalog);
  const brawler =
    result.value.brawlers.find((item) => item.name.toLowerCase() === key) ??
    catalogOnly.find((item) => item.name.toLowerCase() === key) ??
    null;
  if (brawler === null) {
    await interaction.editReply({
      content: `Brawler \`${requestedName}\` was not found in the official catalog or this player’s profile.`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const portraitUrl = await resolveBrawlerPortraitUrl(brawler.name);
  const nonce = createSession({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    tag,
    sort: 'trophies',
    filter: 'all',
    page: 1,
  });
  await interaction.editReply({
    embeds: [buildBrawlerDetailEmbed(result.value, brawler, getBotConfig(), portraitUrl)],
    components: [backRow(nonce)],
    allowedMentions: { parse: [] },
  });
}

export async function handleBrawlersComponent(
  interaction: CommandComponentInteraction,
): Promise<void> {
  if (isPaginationButtonWithState(interaction, COMMAND_NAME)) {
    const parsed = parsePaginationCustomIdWithState(interaction.customId, COMMAND_NAME);
    const session = readSession(interaction, parsed?.state ?? null);
    if (parsed === null || session === null) {
      await replyExpired(interaction);
      return;
    }

    try {
      await interaction.deferUpdate();
      const nonce = parsed.state;
      const built = await buildRosterPayload(nonce, session, interaction.guildId, parsed.page);
      if (built.kind === 'lookup-failure') {
        await interaction.editReply({
          content: 'This player is no longer available.',
          embeds: [],
          components: [],
          allowedMentions: { parse: [] },
        });
        return;
      }
      await interaction.editReply({ ...built.payload, content: null, allowedMentions: { parse: [] } });
    } catch (error) {
      logger.error('Brawler roster pagination failed', {
        error: error instanceof Error ? error.message : 'unknown error',
      });
      await replyWithSafeError(interaction);
    }
    return;
  }

  const action = parseAction(interaction.customId);
  if (action === null) return;
  const session = readSession(interaction, action.nonce);
  if (session === null) {
    await replyExpired(interaction);
    return;
  }

  try {
    await interaction.deferUpdate();

    if (action.kind === 'sort' || action.kind === 'filter') {
      if (typeof interaction.isStringSelectMenu !== 'function' || !interaction.isStringSelectMenu()) {
        await interaction.editReply({ content: 'This control is no longer valid.', components: [] });
        return;
      }
      const value = interaction.values[0] ?? '';
      const updated = refreshSession(action.nonce, {
        ...session,
        ...(action.kind === 'sort'
          ? { sort: isBrawlerSort(value) ? value : session.sort }
          : { filter: isBrawlerFilter(value) ? value : session.filter }),
        page: 1,
      });
      const built = await buildRosterPayload(
        action.nonce,
        updated,
        interaction.guildId,
        1,
      );
      if (built.kind === 'lookup-failure') {
        await interaction.editReply({
          content: 'This player is no longer available.',
          embeds: [],
          components: [],
          allowedMentions: { parse: [] },
        });
        return;
      }
      await interaction.editReply({ ...built.payload, content: null, allowedMentions: { parse: [] } });
      return;
    }

    if (action.kind === 'detail') {
      if (typeof interaction.isStringSelectMenu !== 'function' || !interaction.isStringSelectMenu()) {
        await interaction.editReply({ content: 'This control is no longer valid.', components: [] });
        return;
      }
      const index = Number(interaction.values[0] ?? '');
      const payload = Number.isInteger(index) && index >= 0 && index < PAGE_SIZE
        ? await buildDetailPayload(action.nonce, session, interaction.guildId, index)
        : null;
      if (payload === null) {
        await interaction.editReply({
          content: 'That brawler is no longer available in this view.',
          embeds: [],
          components: [],
          allowedMentions: { parse: [] },
        });
        return;
      }
      await interaction.editReply({ ...payload, content: null, allowedMentions: { parse: [] } });
      return;
    }

    const built = await buildRosterPayload(
      action.nonce,
      session,
      interaction.guildId,
      session.page,
    );
    if (built.kind === 'lookup-failure') {
      await interaction.editReply({
        content: 'This player is no longer available.',
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      });
      return;
    }
    await interaction.editReply({ ...built.payload, content: null, allowedMentions: { parse: [] } });
  } catch (error) {
    logger.error('Brawler component failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}

export async function handleBrawlersAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name === 'tag') {
    await respondWithPlayerChoices(interaction, 'tag');
    return;
  }

  const query = typeof focused.value === 'string' ? focused.value.trim().toLowerCase() : '';
  const catalog = await loadBrawlerCatalog();
  const choices = catalog
    .filter((brawler) => brawler.name.toLowerCase().includes(query))
    .slice(0, 25)
    .map((brawler) => ({ name: brawler.name, value: brawler.name }));
  await respondToAutocomplete(interaction, choices);
}
