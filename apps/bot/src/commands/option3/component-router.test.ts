import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { CommandComponentInteraction } from '../../discord/interactions.js';
import { UNKNOWN_COMPONENT_MESSAGE } from '../../discord/errors.js';
import { createCompositeComponentHandler } from './component-router';

function interaction(deferred = false) {
  return {
    customId: 'future-command:page:2',
    replied: false,
    deferred,
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as unknown as CommandComponentInteraction & {
    reply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
  };
}

describe('createCompositeComponentHandler unknown prefixes', () => {
  it('answers explicitly instead of silently returning', async () => {
    const target = interaction();

    await createCompositeComponentHandler({})(target);

    expect(target.reply).toHaveBeenCalledWith({
      content: UNKNOWN_COMPONENT_MESSAGE,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    expect(target.followUp).not.toHaveBeenCalled();
  });

  it('uses followUp when the interaction was already deferred', async () => {
    const target = interaction(true);

    await createCompositeComponentHandler({})(target);

    expect(target.reply).not.toHaveBeenCalled();
    expect(target.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: UNKNOWN_COMPONENT_MESSAGE }),
    );
  });
});
