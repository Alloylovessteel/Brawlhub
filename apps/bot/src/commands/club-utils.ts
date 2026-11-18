import { createLogger } from '@brawlhub/logging';
import { brawlTagSchema } from '@brawlhub/shared';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { filterRegisteredClubs, getRegisteredClubs } from '../clubs/service';
import type { ClubLookupFailure } from '../clubs/types';
import { cleanTag } from '../discord/format';

const logger = createLogger('bot');

export const DEFAULT_PAGINATION_STATE = 'default';

export const INVALID_CLUB_TAG_MESSAGE =
  'That club tag is not valid. Brawl Stars tags use 3–10 characters from 0, 2, 8, 9, C, G, J, L, P, Q, R, U, V and Y.';

/** Encode the original club lookup into a pagination button state. */
export function paginationStateForTag(tag: string | null | undefined): string {
  if (tag === undefined || tag === null || tag.trim() === '') {
    return DEFAULT_PAGINATION_STATE;
  }
  return cleanTag(tag);
}

/** Decode a pagination state, falling back to the guild default when unusable. */
export function tagFromPaginationState(state: string): string | undefined {
  if (state === DEFAULT_PAGINATION_STATE) return undefined;
  const parsed = brawlTagSchema.safeParse(state);
  return parsed.success ? parsed.data : undefined;
}

/** Reply with the shared user-facing message for a failed club lookup. */
export async function replyClubLookupFailure(
  interaction: ChatInputCommandInteraction,
  failure: ClubLookupFailure,
): Promise<boolean> {
  switch (failure.kind) {
    case 'invalid-tag':
      await interaction.reply({ content: INVALID_CLUB_TAG_MESSAGE, ephemeral: true });
      return true;
    case 'unregistered':
      await interaction.reply({
        content:
          `Club #${failure.tag} is not registered with BrawlHub. ` +
          'An authorised user must register/link the club first.',
        ephemeral: true,
      });
      return true;
    case 'no-default':
      await interaction.reply({
        content:
          'No default club is configured for this server and more than one club is registered. ' +
          'Use a command with `tag:<tag>` to choose one.',
        ephemeral: true,
      });
      return true;
    case 'same-club':
      await interaction.reply({
        content: 'Choose two different registered clubs to compare.',
        ephemeral: true,
      });
      return true;
    default:
      return false;
  }
}

/** Respond with registered-club suggestions for the focused option. */
export async function respondWithClubChoices(
  interaction: AutocompleteInteraction,
  optionName?: string,
): Promise<void> {
  try {
    const focused = interaction.options.getFocused(true);
    if (optionName !== undefined && focused.name !== optionName) {
      await interaction.respond([]);
      return;
    }
    const query = typeof focused.value === 'string' ? focused.value : '';
    const clubs = await getRegisteredClubs();
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
