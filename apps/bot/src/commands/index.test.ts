import { SlashCommandBuilder, type Interaction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { dispatchInteraction, type CommandDefinition } from './index';

function command(name: string, overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription(name),
    handle: vi.fn(async () => undefined),
    ...overrides,
  };
}

function autocompleteInteraction(commandName: string): Interaction {
  return {
    commandName,
    isAutocomplete: () => true,
    isButton: () => false,
    isChatInputCommand: () => false,
  } as unknown as Interaction;
}

function buttonInteraction(customId: string): Interaction {
  return {
    customId,
    replied: false,
    deferred: false,
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    isAutocomplete: () => false,
    isButton: () => true,
    isChatInputCommand: () => false,
  } as unknown as Interaction;
}

function chatInteraction(commandName: string): Interaction {
  return {
    commandName,
    replied: false,
    deferred: false,
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    isAutocomplete: () => false,
    isButton: () => false,
    isChatInputCommand: () => true,
  } as unknown as Interaction;
}

describe('dispatchInteraction', () => {
  it('routes autocomplete interactions to the matching handler', async () => {
    const autocomplete = vi.fn(async () => undefined);
    await dispatchInteraction(
      autocompleteInteraction('club'),
      [command('club', { autocomplete })],
    );
    expect(autocomplete).toHaveBeenCalledOnce();
  });

  it('routes component interactions using the custom ID command prefix', async () => {
    const handleComponent = vi.fn(async () => undefined);
    await dispatchInteraction(
      buttonInteraction('club-members:page:2'),
      [command('club-members', { handleComponent })],
    );
    expect(handleComponent).toHaveBeenCalledOnce();
  });

  it('never exposes raw errors to Discord', async () => {
    const reply = vi.fn(async () => undefined);
    const interaction = {
      commandName: 'broken',
      replied: false,
      deferred: false,
      reply,
      followUp: vi.fn(async () => undefined),
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => true,
    } as unknown as Interaction;

    await dispatchInteraction(
      interaction,
      [
        command('broken', {
          handle: async () => {
            throw new Error('DATABASE_PASSWORD=super-secret stack trace');
          },
        }),
      ],
    );

    expect(reply).toHaveBeenCalledWith({
      content: 'Something went wrong. Please try again later.',
      ephemeral: true,
    });
  });
});
