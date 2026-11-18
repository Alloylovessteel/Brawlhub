import { createLogger } from '@brawlhub/logging';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import type { HistoryPeriod } from '../clubs/types';
import { searchPlayers } from '../players/service';
import type { PlayerLookupFailure } from '../players/types';
import {
  paginationStateForTag,
  tagFromPaginationState,
} from './club-utils';

const logger = createLogger('bot');

export const INVALID_PLAYER_TAG_MESSAGE =
  'That player tag is not valid. Brawl Stars tags use 3–10 characters from 0, 2, 8, 9, C, G, J, L, P, Q, R, U, V and Y.';

export const PLAYER_PERIOD_CHOICES: ReadonlyArray<{
  readonly name: string;
  readonly value: HistoryPeriod;
}> = [
  { name: '7 days', value: '7d' },
  { name: '30 days', value: '30d' },
  { name: '90 days', value: '90d' },
  { name: 'All available history', value: 'all' },
];

export const DEFAULT_PLAYER_PERIOD: HistoryPeriod = '30d';

export function isPlayerHistoryPeriod(value: string): value is HistoryPeriod {
  return PLAYER_PERIOD_CHOICES.some((choice) => choice.value === value);
}

export const playerPaginationStateForTag = paginationStateForTag;
export const playerTagFromPaginationState = tagFromPaginationState;

/** Reply with a safe message for a failed player lookup. */
export async function replyPlayerLookupFailure(
  interaction: ChatInputCommandInteraction,
  failure: PlayerLookupFailure,
): Promise<boolean> {
  switch (failure.kind) {
    case 'invalid-tag':
      await interaction.reply({ content: INVALID_PLAYER_TAG_MESSAGE, ephemeral: true });
      return true;
    case 'not-found':
      await interaction.reply({
        content: `Player #${failure.tag} was not found in BrawlHub data or the official API.`,
        ephemeral: true,
      });
      return true;
    case 'api-unavailable':
      await interaction.reply({
        content:
          `Player #${failure.tag} could not be verified right now (API issue: ${failure.issue}). ` +
          'No valid stored profile was available to show.',
        ephemeral: true,
      });
      return true;
    case 'same-player':
      await interaction.reply({
        content: 'Choose two different players to compare.',
        ephemeral: true,
      });
      return true;
    default:
      return false;
  }
}

/** Respond with registered/stored player suggestions for the focused option. */
export async function respondWithPlayerChoices(
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
    const players = await searchPlayers(query);
    await interaction.respond(
      players.map((player) => ({
        name: `${player.name} (#${player.tag})`,
        value: player.tag,
      })),
    );
  } catch (error) {
    logger.warn('Player autocomplete could not read players', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    await interaction.respond([]).catch(() => undefined);
  }
}
