import type { AutocompleteInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../players/service', () => ({
  searchPlayers: vi.fn(async () => {
    throw new Error('service down');
  }),
}));

import { LOOKUP_UNAVAILABLE_CHOICE, respondWithPlayerChoices } from './player-utils';

function autocomplete() {
  return {
    guildId: 'guild-1',
    responded: false,
    respond: vi.fn(async () => undefined),
    options: { getFocused: vi.fn(() => ({ name: 'tag', value: '' })) },
  } as unknown as AutocompleteInteraction & { respond: ReturnType<typeof vi.fn> };
}

describe('respondWithPlayerChoices failure feedback', () => {
  it('returns one explicit lookup-unavailable choice', async () => {
    const interaction = autocomplete();

    await respondWithPlayerChoices(interaction, 'tag');

    expect(interaction.respond).toHaveBeenCalledTimes(1);
    expect(interaction.respond).toHaveBeenCalledWith([LOOKUP_UNAVAILABLE_CHOICE]);
  });
});
