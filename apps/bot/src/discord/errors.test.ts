import { DiscordAPIError, type AutocompleteInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { respondToAutocomplete } from './errors';

function autocomplete(respond: ReturnType<typeof vi.fn>, responded = false): AutocompleteInteraction {
  return { responded, respond } as unknown as AutocompleteInteraction;
}

function alreadyAcknowledgedError(): DiscordAPIError {
  return new DiscordAPIError(
    { code: 40060, message: 'Interaction has already been acknowledged.' },
    40060,
    400,
    'POST',
    '/webhook',
    { body: undefined, files: [] },
  );
}

describe('respondToAutocomplete', () => {
  it('sends choices while the interaction is unacknowledged', async () => {
    const respond = vi.fn(async () => undefined);
    const choices = [{ name: 'Example', value: 'example' }];

    await respondToAutocomplete(autocomplete(respond), choices);

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(choices);
  });

  it('skips respond entirely when the interaction was already acknowledged', async () => {
    const respond = vi.fn(async () => undefined);

    await respondToAutocomplete(autocomplete(respond, true), []);

    expect(respond).not.toHaveBeenCalled();
  });

  it('ignores Discord acknowledgement races', async () => {
    const respond = vi.fn(async () => {
      throw alreadyAcknowledgedError();
    });

    await expect(respondToAutocomplete(autocomplete(respond), [])).resolves.toBeUndefined();
    expect(respond).toHaveBeenCalledOnce();
  });

  it('propagates unexpected response failures', async () => {
    const respond = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(respondToAutocomplete(autocomplete(respond), [])).rejects.toThrow('boom');
  });

  it('suppresses unexpected failures when used as a fallback', async () => {
    const respond = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(
      respondToAutocomplete(autocomplete(respond), [], { swallowUnexpectedErrors: true }),
    ).resolves.toBeUndefined();
  });
});
