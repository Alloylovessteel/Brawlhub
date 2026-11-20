import { SlashCommandBuilder, type Interaction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { commands, dispatchInteraction, pendingCommands, type CommandDefinition } from './index';

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
    isAnySelectMenu: () => false,
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
    isAnySelectMenu: () => false,
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
    isAnySelectMenu: () => false,
    isChatInputCommand: () => true,
  } as unknown as Interaction;
}

describe('command registry', () => {
  it('registers club autocomplete and clubs pagination handlers', () => {
    expect(commands.find((command) => command.data.name === 'club')?.autocomplete).toBeTypeOf(
      'function',
    );
    expect(commands.find((command) => command.data.name === 'clubs')?.handleComponent).toBeTypeOf(
      'function',
    );
  });

  it('registers all advanced club commands with their handlers', () => {
    expect(commands.map((command) => command.data.name)).toEqual([
      'ping',
      'club',
      'clubs',
      'club-members',
      'club-leaderboard',
      'club-log',
      'club-history',
      'club-compare',
      'view',
      'events',
      'me',
      'player-history',
      'player-clubs',
      'player-compare',
      'leaderboard',
      'competition',
      'members',
      'member-verify',
      'accounts',
      'verify-info',
      'verify-settings',
      'tag',
      'register-list',
      'find',
      'unverify-one',
      'unverify-all',
      'delete-me',
      'member-history',
      'member-search',
      'staff',
      'register-club',
      'sync',
      'sync-status',
      'settings',
      'audit',
      'remove-club',
      'help',
      'about',
      'status',
    ]);
    expect(commands.find((command) => command.data.name === 'competition')?.autocomplete).toBeTypeOf(
      'function',
    );
    expect(commands.find((command) => command.data.name === 'competition')?.handleComponent).toBeTypeOf(
      'function',
    );
    for (const name of [
      'club-members',
      'club-leaderboard',
      'club-log',
      'club-history',
      'club-compare',
      'members',
      'member-history',
      'member-search',
    ]) {
      expect(commands.find((command) => command.data.name === name)?.autocomplete).toBeTypeOf('function');
    }
    for (const name of ['club-members', 'club-leaderboard', 'club-log', 'club-history', 'events', 'members', 'member-history', 'member-search', 'staff', 'register-club', 'settings', 'audit', 'help']) {
      expect(commands.find((command) => command.data.name === name)?.handleComponent).toBeTypeOf(
        'function',
      );
    }
    for (const name of ['settings', 'remove-club', 'view']) {
      expect(commands.find((command) => command.data.name === name)?.autocomplete).toBeTypeOf('function');
    }
    expect(commands.find((command) => command.data.name === 'club')?.handleComponent).toBeTypeOf(
      'function',
    );
  });

  it('keeps schema-dependent moderation commands unregistered', () => {
    expect(commands.map((command) => command.data.name)).not.toContain('blacklist');
    const blacklist = pendingCommands.find((command) => command.data.name === 'blacklist');
    expect(blacklist).toBeDefined();
    expect(blacklist?.autocomplete).toBeTypeOf('function');
    expect(blacklist?.handleComponent).toBeTypeOf('function');
  });

  it('registers club archival as a confirmed, non-destructive command', () => {
    expect(commands.map((command) => command.data.name)).toContain('remove-club');
    expect(pendingCommands.map((command) => command.data.name)).not.toContain('remove-club');
    const removeClub = commands.find((command) => command.data.name === 'remove-club');
    expect(removeClub).toBeDefined();
    expect(removeClub?.autocomplete).toBeTypeOf('function');
    expect(removeClub?.handleComponent).toBeTypeOf('function');
  });

  it('registers all player commands with their handlers', () => {
    for (const name of ['me', 'player-history', 'player-clubs', 'player-compare']) {
      expect(commands.find((command) => command.data.name === name)?.autocomplete).toBeTypeOf('function');
    }
    for (const name of ['player-history', 'player-clubs']) {
      expect(commands.find((command) => command.data.name === name)?.handleComponent).toBeTypeOf(
        'function',
      );
    }
    expect(
      commands.find((command) => command.data.name === 'leaderboard')?.handleComponent,
    ).toBeTypeOf('function');
  });
});

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

  it('routes help pagination components to the help handler', async () => {
    const handleComponent = vi.fn(async () => undefined);
    await dispatchInteraction(
      buttonInteraction('help:page:2'),
      [command('help', { handleComponent })],
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
      isAnySelectMenu: () => false,
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
      flags: 64,
    });
  });
});
