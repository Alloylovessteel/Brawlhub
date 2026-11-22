import { randomUUID } from 'node:crypto';
import { createLogger } from '@brawlhub/logging';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { getBotConfig } from '../config';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import { replyWithSafeError } from '../discord/errors';
import {
  buildPaginationRowWithState,
  isPaginationButtonWithState,
  paginate,
  parsePaginationCustomIdWithState,
} from '../discord/pagination';
import { resolveBrawlerPortraitUrl, resolvePlayerIconUrl } from '../metadata/assets.js';
import {
  createPersistentSession,
  deletePersistentSession,
  listPersistentReplays,
  listPersistentSessions,
  persistVoid,
  recordPersistentReplay,
  takePersistentSession,
} from '../state/index.js';
import {
  buildMeBrawlersEmbed,
  buildMeMoreEmbed,
  buildMeSummaryEmbed,
} from '../players/embed';
import {
  loadPlayerBattles,
  loadPlayerBrawlers,
  loadPlayerClubs,
  loadPlayerHistory,
  loadPlayerProfile,
} from '../players/service';
import type { PlayerLookupFailure } from '../players/types';

const logger = createLogger('bot');
const PAGE_SIZE = 10;
const SESSION_TTL_MS = 10 * 60 * 1000;
/** Discord can deliver the same button press twice; ignore an identical replay. */
const REPLAY_WINDOW_MS = 5 * 1000;

export const ME_SECTIONS = ['summary', 'brawlers', 'more'] as const;
export type MeSection = (typeof ME_SECTIONS)[number];

export const ME_SECTION_LABELS: Readonly<Record<MeSection, string>> = {
  summary: 'Summary',
  brawlers: 'Brawlers',
  more: 'More',
};

export function isMeSection(value: string): value is MeSection {
  return (ME_SECTIONS as readonly string[]).includes(value);
}

export interface MeSession {
  readonly guildId: string;
  readonly userId: string;
  readonly tag: string;
  readonly section: MeSection;
  readonly page: number;
  readonly expiresAt: number;
}

export type MeSessionInput = Omit<MeSession, 'expiresAt'>;

const SESSION_COMMAND = 'me';
const REPLAY_COMMAND = 'me';
const SESSION_KIND = 'single-use';

const sessions = new Map<string, MeSession>();

interface ReplayEntry {
  readonly guildId: string;
  readonly userId: string;
  readonly expiresAt: number;
}

const consumedClicks = new Map<string, ReplayEntry>();

/** Hydrate the synchronous mirrors from Supabase when a service role is configured. */
function hydrateMeMirrors(): void {
  persistVoid(
    listPersistentSessions({ command: SESSION_COMMAND })
      .then((rows) => {
        for (const row of rows) {
          const session = row.payload as unknown as MeSession;
          if (
            typeof session.guildId === 'string' &&
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
    'hydrate /me sessions',
  );
  persistVoid(
    listPersistentReplays()
      .then((rows) => {
        for (const row of rows) {
          if (row.guildId === '' || row.actionKey.length === 0) continue;
          consumedClicks.set(`${row.nonce}:${row.actionKey}`, {
            guildId: row.guildId,
            userId: row.actorDiscordUserId,
            expiresAt: row.expiresAt,
          });
        }
      })
      .catch(() => undefined),
    'hydrate /me replays',
  );
}

hydrateMeMirrors();

function pruneExpiredSessions(now: number): void {
  for (const [nonce, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(nonce);
  }
  for (const [key, entry] of consumedClicks) {
    if (entry.expiresAt <= now) consumedClicks.delete(key);
  }
}

function replayKey(nonce: string, action: string): string {
  return `${nonce}:${action}`;
}

/** Only the same actor, guild and button may replay a just-consumed nonce. */
function isDuplicateMeClick(
  interaction: CommandComponentInteraction,
  nonce: string | null,
  action: string | null,
): boolean {
  if (nonce === null || action === null || interaction.guildId === null) return false;
  const key = replayKey(nonce, action);
  const entry = consumedClicks.get(key);
  if (entry === undefined) return false;
  if (entry.expiresAt <= Date.now()) {
    consumedClicks.delete(key);
    return false;
  }
  return entry.guildId === interaction.guildId && entry.userId === interaction.user.id;
}

function rememberMeClick(
  interaction: CommandComponentInteraction,
  nonce: string,
  action: string,
): void {
  if (interaction.guildId === null) return;
  pruneExpiredSessions(Date.now());
  const expiresAt = Date.now() + REPLAY_WINDOW_MS;
  consumedClicks.set(replayKey(nonce, action), {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    expiresAt,
  });
  persistVoid(
    recordPersistentReplay({
      guildId: interaction.guildId,
      actorDiscordUserId: interaction.user.id,
      nonce,
      actionKey: action,
      expiresAt,
    }),
    'remember /me click',
  );
}

async function acknowledgeDuplicate(interaction: CommandComponentInteraction): Promise<void> {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  await interaction.editReply({
    content: 'That button was already handled. Run /me profile again for a fresh view.',
    embeds: [],
    components: [],
    allowedMentions: { parse: [] },
  });
}

/** Create a single-use, actor- and guild-bound `/me` component session. */
export function createMeSession(input: MeSessionInput): string {
  pruneExpiredSessions(Date.now());
  const nonce = randomUUID().replace(/-/g, '').slice(0, 16);
  const session: MeSession = { ...input, expiresAt: Date.now() + SESSION_TTL_MS };
  sessions.set(nonce, session);
  persistVoid(
    createPersistentSession({
      guildId: session.guildId,
      command: SESSION_COMMAND,
      kind: SESSION_KIND,
      actorDiscordUserId: session.userId,
      nonce,
      payload: session as unknown as Record<string, unknown>,
      expiresAt: session.expiresAt,
    }),
    'create /me session',
  );
  return nonce;
}

/** Read and consume a session. A stale or cross-user click cannot be reused. */
export function readMeSession(
  interaction: CommandComponentInteraction,
  nonce: string | null,
): MeSession | null {
  if (nonce === null) return null;
  const session = sessions.get(nonce);
  if (session === undefined) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(nonce);
    return null;
  }

  const guildId = interaction.guildId;
  if (guildId === null || session.guildId !== guildId || session.userId !== interaction.user.id) {
    return null;
  }

  // Only the bound actor in the bound guild consumes the nonce. A stray click
  // from someone else must not invalidate a live view.
  sessions.delete(nonce);
  persistVoid(
    takePersistentSession({
      guildId,
      command: SESSION_COMMAND,
      actorDiscordUserId: interaction.user.id,
      nonce,
    }),
    'take /me session',
  );
  return session;
}

export function deleteMeSession(nonce: string): void {
  const session = sessions.get(nonce);
  sessions.delete(nonce);
  if (session === undefined) return;
  persistVoid(
    deletePersistentSession({
      guildId: session.guildId,
      command: SESSION_COMMAND,
      actorDiscordUserId: session.userId,
      nonce,
    }),
    'delete /me session',
  );
}

function parseSectionCustomId(customId: string): { section: MeSection; nonce: string } | null {
  const parts = customId.split(':');
  if (parts.length !== 4 || parts[0] !== 'me' || parts[1] !== 'section') return null;
  const section = parts[2];
  const nonce = parts[3];
  if (section === undefined || nonce === undefined || nonce === '' || !isMeSection(section)) {
    return null;
  }
  return { section, nonce };
}

function sectionRow(nonce: string, active: MeSection): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ME_SECTIONS.map((section) =>
      new ButtonBuilder()
        .setCustomId(`me:section:${section}:${nonce}`)
        .setLabel(ME_SECTION_LABELS[section])
        .setStyle(section === active ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );
}

export interface MePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

export type MeBuildResult =
  | { readonly kind: 'ok'; readonly payload: MePayload }
  | { readonly kind: 'lookup-failure'; readonly failure: PlayerLookupFailure };

/** Load one `/me` section using the guild context from the interaction. */
export async function buildMeResponse(
  session: MeSessionInput,
  nonce: string,
): Promise<MeBuildResult> {
  const config = getBotConfig();
  const guildId = session.guildId;

  if (session.section === 'summary') {
    const result = await loadPlayerProfile({ tag: session.tag, guildId });
    if (result.kind !== 'ok') return { kind: 'lookup-failure', failure: result };
    const iconUrl = await resolvePlayerIconUrl(result.value.player.iconId);
    return {
      kind: 'ok',
      payload: {
        embeds: [buildMeSummaryEmbed(result.value, config, iconUrl)],
        components: [sectionRow(nonce, 'summary')],
      },
    };
  }

  if (session.section === 'brawlers') {
    const result = await loadPlayerBrawlers({ tag: session.tag, guildId });
    if (result.kind !== 'ok') return { kind: 'lookup-failure', failure: result };
    const page = paginate(result.value.brawlers, session.page, PAGE_SIZE);
    const portraitUrl = await resolveBrawlerPortraitUrl(page.items[0]?.name ?? null);
    const pagination = buildPaginationRowWithState('me', page.page, page.pageCount, nonce);
    const components = [sectionRow(nonce, 'brawlers')];
    if (pagination !== null) components.push(pagination);
    return {
      kind: 'ok',
      payload: {
        embeds: [buildMeBrawlersEmbed(result.value, page, config, portraitUrl)],
        components,
      },
    };
  }

  const [history, battles, clubs] = await Promise.all([
    loadPlayerHistory({ tag: session.tag, period: '30d', guildId }),
    loadPlayerBattles({ tag: session.tag, period: '30d', guildId }),
    loadPlayerClubs({ tag: session.tag, guildId }),
  ]);
  const failed = [history, battles, clubs].find((result) => result.kind !== 'ok');
  if (failed !== undefined) {
    return { kind: 'lookup-failure', failure: failed };
  }
  if (history.kind !== 'ok' || battles.kind !== 'ok' || clubs.kind !== 'ok') {
    return { kind: 'lookup-failure', failure: { kind: 'not-found', tag: session.tag } };
  }

  const iconUrl = await resolvePlayerIconUrl(history.value.player.iconId);
  return {
    kind: 'ok',
    payload: {
      embeds: [
        buildMeMoreEmbed(
          { history: history.value, battles: battles.value, clubs: clubs.value },
          config,
          iconUrl,
        ),
      ],
      components: [sectionRow(nonce, 'more')],
    },
  };
}

async function replyExpired(interaction: CommandComponentInteraction): Promise<void> {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  await interaction.editReply({
    content: 'This `/me profile` view has expired. Run `/me profile` again.',
    embeds: [],
    components: [],
    allowedMentions: { parse: [] },
  });
}

async function respondWithSession(
  interaction: CommandComponentInteraction,
  session: MeSession,
): Promise<void> {
  const nonce = createMeSession(session);
  const built = await buildMeResponse(session, nonce);
  if (built.kind === 'lookup-failure') {
    deleteMeSession(nonce);
    await interaction.editReply({
      content: 'This player is no longer available in this server.',
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.editReply({
    ...built.payload,
    content: null,
    allowedMentions: { parse: [] },
  });
}

/** Handle Summary/Brawlers/More buttons and brawler pagination for `/me`. */
export async function handleMeComponent(
  interaction: CommandComponentInteraction,
): Promise<void> {
  if (interaction.guildId === null) {
    await replyExpired(interaction);
    return;
  }

  if (isPaginationButtonWithState(interaction, 'me')) {
    const parsed = parsePaginationCustomIdWithState(interaction.customId, 'me');
    const nonce = parsed?.state ?? null;
    const action = parsed === null ? null : `page:${parsed.page}`;
    if (isDuplicateMeClick(interaction, nonce, action)) {
      await acknowledgeDuplicate(interaction);
      return;
    }

    const session = readMeSession(interaction, nonce);
    if (parsed === null || session === null || nonce === null || action === null) {
      await replyExpired(interaction);
      return;
    }
    rememberMeClick(interaction, nonce, action);

    try {
      await interaction.deferUpdate();
      await respondWithSession(interaction, {
        ...session,
        section: 'brawlers',
        page: parsed.page,
      });
    } catch (error) {
      logger.error('Interactive /me pagination failed', {
        error: error instanceof Error ? error.message : 'unknown error',
      });
      await replyWithSafeError(interaction);
    }
    return;
  }

  const action = parseSectionCustomId(interaction.customId);
  const nonce = action?.nonce ?? null;
  const actionKey = action === null ? null : `section:${action.section}`;
  if (isDuplicateMeClick(interaction, nonce, actionKey)) {
    await acknowledgeDuplicate(interaction);
    return;
  }

  const session = readMeSession(interaction, nonce);
  if (action === null || session === null || nonce === null || actionKey === null) {
    await replyExpired(interaction);
    return;
  }
  rememberMeClick(interaction, nonce, actionKey);

  try {
    await interaction.deferUpdate();
    await respondWithSession(interaction, {
      ...session,
      section: action.section,
      page: action.section === 'brawlers' ? session.page : 1,
    });
  } catch (error) {
    logger.error('Interactive /me section switch failed', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await replyWithSafeError(interaction);
  }
}
