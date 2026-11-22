import { Routes, SlashCommandBuilder, type Interaction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  commands,
  dispatchInteraction,
  pendingCommands,
  registerCommands,
  type CommandDefinition,
  type CommandRegistrationRest,
} from './index';

function command(name: string, overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription(name),
    handle: vi.fn(async () => undefined),
    ...overrides,
  };
}

function autocompleteInteraction(commandName: string, responded = false): Interaction {
  return {
    commandName,
    responded,
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
  it('registers the 18 Option 3 anchors in order', () => {
    expect(commands.map((command) => command.data.name)).toEqual([
      'clubs',
      'me',
      'brawlers',
      'player',
      'leaderboard',
      'events',
      'competition',
      'members',
      'staff',
      'sync',
      'settings',
      'inactivity',
      'audit',
      'help',
      'fn',
      'auto',
      'update',
      'club-roles',
    ]);
  });

  it('keeps schema-dependent moderation commands unregistered', () => {
    expect(commands.map((command) => command.data.name)).not.toContain('blacklist');
    const blacklist = pendingCommands.find((command) => command.data.name === 'blacklist');
    expect(blacklist).toBeDefined();
    expect(blacklist?.autocomplete).toBeTypeOf('function');
    expect(blacklist?.handleComponent).toBeTypeOf('function');
  });

  it('uses composite handlers for the folded anchors', () => {
    for (const name of ['clubs', 'player', 'brawlers', 'members', 'help']) {
      expect(commands.find((command) => command.data.name === name)?.handleComponent).toBeTypeOf(
        'function',
      );
    }
    for (const name of ['clubs', 'player', 'brawlers', 'members']) {
      expect(commands.find((command) => command.data.name === name)?.autocomplete).toBeTypeOf(
        'function',
      );
    }
  });

  it('keeps handlers for the standalone commands', () => {
    expect(commands.find((command) => command.data.name === 'competition')?.autocomplete).toBeTypeOf(
      'function',
    );
    expect(commands.find((command) => command.data.name === 'competition')?.handleComponent).toBeTypeOf(
      'function',
    );
    for (const name of ['me', 'events', 'leaderboard', 'staff', 'settings', 'audit', 'fn', 'auto', 'update']) {
      expect(commands.find((command) => command.data.name === name)?.handleComponent).toBeTypeOf(
        'function',
      );
    }
  });
});

describe('registerCommands', () => {
  const CLIENT_ID = '123456789012345678';
  const PRIMARY_GUILD_ID = '1488531664962326571';
  const JOINED_GUILD_ID = '1501888916024856659';

  function registrar(
    get: ReturnType<typeof vi.fn> = vi.fn(async () => [{ id: JOINED_GUILD_ID }, { id: 'bad' }]),
  ): { rest: CommandRegistrationRest; get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> } {
    const put = vi.fn(async () => ({}));
    return { rest: { get, put } as unknown as CommandRegistrationRest, get, put };
  }

  it('registers globally and to every joined guild, not only the configured guild', async () => {
    const { rest, get, put } = registrar();

    await registerCommands({
      rest,
      token: 'test-token',
      clientId: CLIENT_ID,
      guildId: PRIMARY_GUILD_ID,
    });

    expect(get).toHaveBeenCalledWith(Routes.userGuilds());
    expect(put).toHaveBeenCalledTimes(3);
    expect(put.mock.calls.map(([route]) => route)).toEqual([
      Routes.applicationCommands(CLIENT_ID),
      Routes.applicationGuildCommands(CLIENT_ID, JOINED_GUILD_ID),
      Routes.applicationGuildCommands(CLIENT_ID, PRIMARY_GUILD_ID),
    ]);
    for (const [, options] of put.mock.calls) {
      expect(options.body).toHaveLength(commands.length);
    }
  });

  it('still registers global and configured-guild commands when guild listing fails', async () => {
    const get = vi.fn(async () => {
      throw new Error('guild list unavailable');
    });
    const { rest, put } = registrar(get);

    await registerCommands({
      rest,
      token: 'test-token',
      clientId: CLIENT_ID,
      guildId: PRIMARY_GUILD_ID,
    });

    expect(put.mock.calls.map(([route]) => route)).toEqual([
      Routes.applicationCommands(CLIENT_ID),
      Routes.applicationGuildCommands(CLIENT_ID, PRIMARY_GUILD_ID),
    ]);
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

  it('skips autocomplete handlers that are already acknowledged', async () => {
    const autocomplete = vi.fn(async () => undefined);
    await dispatchInteraction(
      autocompleteInteraction('club', true),
      [command('club', { autocomplete })],
    );
    expect(autocomplete).not.toHaveBeenCalled();
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

  it('routes retired component prefixes to their Option 3 anchor', async () => {
    const handleComponent = vi.fn(async () => undefined);
    const interaction = buttonInteraction('club-members:page:2:TAG');
    await dispatchInteraction(interaction, [command('clubs', { handleComponent })]);
    expect(handleComponent).toHaveBeenCalledWith(interaction);
    expect((interaction as { customId: string }).customId).toBe('club-members:page:2:TAG');
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
