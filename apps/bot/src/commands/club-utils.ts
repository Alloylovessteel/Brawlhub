import { randomUUID } from 'node:crypto';
import { createLogger } from '@brawlhub/logging';
import { brawlTagSchema } from '@brawlhub/shared';
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { filterRegisteredClubs, getRegisteredClubs } from '../clubs/service';
import type { ClubLookupFailure } from '../clubs/types';
import { cleanTag } from '../discord/format';
import { respondToAutocomplete } from '../discord/errors.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';

const logger = createLogger('bot');

export const DEFAULT_PAGINATION_STATE = 'default';
const CLUB_CHOOSER_MAX_OPTIONS = 25;
const CLUB_CHOOSER_TTL_MS = 10 * 60 * 1000;

interface ClubChooserSession<T = unknown> {
  readonly commandName: string;
  readonly guildId: string;
  readonly userId: string;
  readonly state: T;
  readonly expiresAt: number;
}

const clubChooserSessions = new Map<string, ClubChooserSession>();

export const INVALID_CLUB_TAG_MESSAGE =
  'That club tag is not valid. Brawl Stars tags use 3–10 characters from 0, 2, 8, 9, C, G, J, L, P, Q, R, U, V and Y.';

/** Encode the original club lookup into a pagination button state. */
export function paginationStateForTag(tag: string | null | undefined): string {
  if (tag === undefined || tag === null || tag.trim() === '') {
    return DEFAULT_PAGINATION_STATE;
  }
  return cleanTag(tag);
}

/** Decode a pagination state, returning an unresolved tag when unusable. */
export function tagFromPaginationState(state: string): string | undefined {
  if (state === DEFAULT_PAGINATION_STATE) return undefined;
  const parsed = brawlTagSchema.safeParse(state);
  return parsed.success ? parsed.data : undefined;
}

/** Map a club lookup failure to a safe user-facing message. */
export function mapClubLookupFailureMessage(failure: ClubLookupFailure): string {
  switch (failure.kind) {
    case 'invalid-tag':
      return INVALID_CLUB_TAG_MESSAGE;
    case 'unregistered':
      return (
        `Club #${failure.tag} is not registered with BrawlHub. ` +
        'An authorised user must register/link the club first.'
      );
    case 'no-default':
      return (
        'More than one club is registered in this server. ' +
        'Use the club chooser or a command with `tag:<tag>` to choose one.'
      );
    case 'same-club':
      return 'Choose two different registered clubs to compare.';
    default:
      return 'That club could not be loaded right now.';
  }
}

/** Reply with the shared user-facing message for a failed club lookup. */
export async function replyClubLookupFailure(
  interaction: ChatInputCommandInteraction,
  failure: ClubLookupFailure,
): Promise<boolean> {
  const content = mapClubLookupFailureMessage(failure);
  if (interaction.deferred) {
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
    return true;
  }
  await interaction.reply({ content, flags: 64, allowedMentions: { parse: [] } });
  return true;
}

function chooserSessionKey(commandName: string, nonce: string): string {
  return `${commandName}:${nonce}`;
}

function pruneExpiredChooserSessions(now: number): void {
  for (const [key, session] of clubChooserSessions) {
    if (session.expiresAt <= now) clubChooserSessions.delete(key);
  }
}

export function createClubChooserSession<T>(input: {
  readonly commandName: string;
  readonly guildId: string;
  readonly userId: string;
  readonly state: T;
}): string {
  pruneExpiredChooserSessions(Date.now());
  const nonce = randomUUID().replace(/-/g, '').slice(0, 16);
  clubChooserSessions.set(chooserSessionKey(input.commandName, nonce), {
    commandName: input.commandName,
    guildId: input.guildId,
    userId: input.userId,
    state: input.state,
    expiresAt: Date.now() + CLUB_CHOOSER_TTL_MS,
  });
  return nonce;
}

export function parseClubChooserCustomId(customId: string, commandName: string): string | null {
  const prefix = `${commandName}:choose:`;
  return customId.startsWith(prefix) ? customId.slice(prefix.length) || null : null;
}

export type ClubChooserSelection<T> =
  | { readonly kind: 'none' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'selected'; readonly state: T; readonly tag: string };

/**
 * Read a chooser selection, binding it to the invoking user, guild and command.
 * The session is single-use so a stale component cannot be reused.
 */
export function readClubChooserSelection<T>(
  interaction: CommandComponentInteraction,
  commandName: string,
): ClubChooserSelection<T> {
  const nonce = parseClubChooserCustomId(interaction.customId, commandName);
  if (nonce === null) return { kind: 'none' };
  if (typeof interaction.isStringSelectMenu !== 'function' || !interaction.isStringSelectMenu()) {
    return { kind: 'expired' };
  }

  const key = chooserSessionKey(commandName, nonce);
  const session = clubChooserSessions.get(key) as ClubChooserSession<T> | undefined;
  if (session === undefined || session.expiresAt <= Date.now()) {
    clubChooserSessions.delete(key);
    return { kind: 'expired' };
  }
  if (
    session.commandName !== commandName ||
    session.guildId !== interaction.guildId ||
    session.userId !== interaction.user.id
  ) {
    return { kind: 'expired' };
  }
  clubChooserSessions.delete(key);

  const tag = interaction.values[0];
  return tag === undefined ? { kind: 'expired' } : { kind: 'selected', state: session.state, tag };
}

/** Show a guild-scoped club chooser for a tagless command with several registered clubs. */
export async function replyWithClubChooser<T>(
  interaction: ChatInputCommandInteraction,
  commandName: string,
  state: T,
): Promise<boolean> {
  if (interaction.guildId === null || interaction.guildId === '') {
    await interaction.editReply({
      content: 'This command needs a server context before choosing a club.',
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  const clubs = await getRegisteredClubs(interaction.guildId);
  if (clubs.length === 0) {
    await interaction.editReply({
      content: 'No clubs are registered in this server yet.',
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  const nonce = createClubChooserSession({
    commandName,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    state,
  });
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${commandName}:choose:${nonce}`)
    .setPlaceholder('Choose a club for this command')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      clubs.slice(0, CLUB_CHOOSER_MAX_OPTIONS).map((club) => ({
        label: `${club.name} (#${club.tag})`.slice(0, 100),
        value: club.tag,
      })),
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const hidden = clubs.length > CLUB_CHOOSER_MAX_OPTIONS
    ? ` Showing the first ${CLUB_CHOOSER_MAX_OPTIONS}.`
    : '';

  await interaction.editReply({
    content:
      `This server has ${clubs.length} registered clubs. Choose one to continue ` +
      `\`/${commandName}\`.${hidden}`,
    embeds: [],
    components: [row],
    allowedMentions: { parse: [] },
  });
  return true;
}

/** Show the chooser only for the no-default failure; return false for other failures. */
export async function replyWithClubChooserIfNeeded<T>(
  interaction: ChatInputCommandInteraction,
  commandName: string,
  failure: ClubLookupFailure,
  state: T,
): Promise<boolean> {
  if (failure.kind !== 'no-default') return false;
  await replyWithClubChooser(interaction, commandName, state);
  return true;
}

/** Respond with registered-club suggestions for the focused option. */
export async function respondWithClubChoices(
  interaction: AutocompleteInteraction,
  optionName?: string,
): Promise<void> {
  try {
    const focused = interaction.options.getFocused(true);
    if (optionName !== undefined && focused.name !== optionName) {
      await respondToAutocomplete(interaction, []);
      return;
    }
    const query = typeof focused.value === 'string' ? focused.value : '';
    const clubs = await getRegisteredClubs(interaction.guildId);
    const choices = filterRegisteredClubs(clubs, query).map((club) => ({
      name: `${club.name} (#${club.tag})`,
      value: club.tag,
    }));
    await respondToAutocomplete(interaction, choices);
  } catch (error) {
    logger.warn('Club autocomplete could not read registered clubs', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await respondToAutocomplete(interaction, [], { swallowUnexpectedErrors: true });
  }
}
