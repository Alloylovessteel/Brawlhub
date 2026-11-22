import {
  DiscordAPIError,
  MessageFlags,
  type AutocompleteInteraction,
  type ButtonInteraction,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  replyExpiredComponent,
  replyUnknownComponent,
  respondToAutocomplete,
  UNKNOWN_COMPONENT_MESSAGE,
} from './errors';

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

describe('component feedback helpers', () => {
  function button(replied = false, deferred = false) {
    return {
      replied,
      deferred,
      reply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    } as unknown as ButtonInteraction & {
      reply: ReturnType<typeof vi.fn>;
      followUp: ReturnType<typeof vi.fn>;
    };
  }

  it('replies ephemerally before acknowledgement', async () => {
    const interaction = button();
    await replyExpiredComponent(interaction, 'That button expired.');

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'That button expired.',
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('uses followUp after a defer', async () => {
    const interaction = button(false, true);
    await replyUnknownComponent(interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: UNKNOWN_COMPONENT_MESSAGE,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  });

  it('never throws when the interaction cannot be answered', async () => {
    await expect(
      replyUnknownComponent({ customId: 'unknown:page:2' } as unknown as ButtonInteraction),
    ).resolves.toBeUndefined();
  });
});
