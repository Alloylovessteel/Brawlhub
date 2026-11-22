import { SlashCommandBuilder, type Interaction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { CommandComponentInteraction } from '../../discord/interactions.js';
import { dispatchInteraction, type CommandDefinition } from '../index';
import {
  createCompositeComponentHandler,
  hasComponentHandler,
  resolveLegacyComponentCommand,
  type ComponentHandler,
} from './component-router';

const GUILD_ID = '123456789012345678';
const NONCE = 'nonce-ABC_123';

/**
 * Custom IDs that were emitted before the command anchors existed. Several
 * carry guild IDs, nonces, state suffixes or the special club-overview toggle
 * and done actions; none may be rewritten by the router.
 */
const LEGACY_CUSTOM_IDS: readonly {
  readonly customId: string;
  readonly prefix: string;
  readonly anchor: string;
}[] = [
  { customId: `club:page:2:#8Q0L2G2`, prefix: 'club', anchor: 'clubs' },
  { customId: `club-members:page:2:#8Q0L2G2`, prefix: 'club-members', anchor: 'clubs' },
  { customId: `club-leaderboard:page:2`, prefix: 'club-leaderboard', anchor: 'clubs' },
  {
    customId: `club-log:page:2:30d|#8Q0L2G2`,
    prefix: 'club-log',
    anchor: 'clubs',
  },
  {
    customId: `club-history:page:2:30d|#8Q0L2G2`,
    prefix: 'club-history',
    anchor: 'clubs',
  },
  { customId: `club-overview:toggle:${GUILD_ID}`, prefix: 'club-overview', anchor: 'clubs' },
  { customId: `club-overview:done:${GUILD_ID}`, prefix: 'club-overview', anchor: 'clubs' },
  { customId: `clubs:overview:${GUILD_ID}`, prefix: 'clubs', anchor: 'clubs' },
  { customId: `clubs:page:2`, prefix: 'clubs', anchor: 'clubs' },
  { customId: `clublogs:page:2`, prefix: 'clublogs', anchor: 'clubs' },
  { customId: `register-club:confirm:${NONCE}`, prefix: 'register-club', anchor: 'clubs' },
  { customId: `remove-club:cancel:${NONCE}`, prefix: 'remove-club', anchor: 'clubs' },
  { customId: `me:section:summary:${NONCE}`, prefix: 'me', anchor: 'me' },
  { customId: `me:page:2:${NONCE}`, prefix: 'me', anchor: 'me' },
  {
    customId: `player-history:page:2:30d|#PLAYERTAG`,
    prefix: 'player-history',
    anchor: 'player',
  },
  { customId: `player-battles:page:2:#PLAYERTAG`, prefix: 'player-battles', anchor: 'player' },
  { customId: `player-clubs:page:2:#PLAYERTAG`, prefix: 'player-clubs', anchor: 'player' },
  { customId: `brawlers:sort:${NONCE}`, prefix: 'brawlers', anchor: 'brawlers' },
  { customId: `brawlers:filter:${NONCE}`, prefix: 'brawlers', anchor: 'brawlers' },
  { customId: `brawlers:detail:${NONCE}`, prefix: 'brawlers', anchor: 'brawlers' },
  { customId: `brawlers:back:${NONCE}`, prefix: 'brawlers', anchor: 'brawlers' },
  { customId: `leaderboard:page:2`, prefix: 'leaderboard', anchor: 'leaderboard' },
  { customId: `events:page:2:active`, prefix: 'events', anchor: 'events' },
  { customId: `competition:page:2:open`, prefix: 'competition', anchor: 'competition' },
  { customId: `members:page:2:#8Q0L2G2`, prefix: 'members', anchor: 'members' },
  { customId: `unverify-one:confirm:${NONCE}`, prefix: 'unverify-one', anchor: 'verify' },
  { customId: `unverify-all:cancel:${NONCE}`, prefix: 'unverify-all', anchor: 'verify' },
  { customId: `delete-me:confirm:${NONCE}`, prefix: 'delete-me', anchor: 'verify' },
  { customId: `member-history:page:2:#8Q0L2G2`, prefix: 'member-history', anchor: 'members' },
  { customId: `member-search:page:2:#PLAYERTAG`, prefix: 'member-search', anchor: 'members' },
  { customId: `staff:page:2`, prefix: 'staff', anchor: 'staff' },
  { customId: `settings:setup:${NONCE}:menu`, prefix: 'settings', anchor: 'settings' },
  { customId: `audit:page:2`, prefix: 'audit', anchor: 'audit' },
  { customId: `help:page:2`, prefix: 'help', anchor: 'help' },
  { customId: `fn:me:${GUILD_ID}`, prefix: 'fn', anchor: 'fn' },
  { customId: `auto:guide:${GUILD_ID}`, prefix: 'auto', anchor: 'auto' },
  { customId: `update:run:${GUILD_ID}`, prefix: 'update', anchor: 'update' },
];

function componentInteraction(customId: string): CommandComponentInteraction {
  return {
    customId,
    guildId: GUILD_ID,
    user: { id: 'user-1' },
  } as unknown as CommandComponentInteraction;
}

function dispatchComponentInteraction(customId: string): Interaction {
  return {
    ...componentInteraction(customId),
    isAutocomplete: () => false,
    isButton: () => true,
    isAnySelectMenu: () => false,
    isChatInputCommand: () => false,
  } as unknown as Interaction;
}

function createRouter(): {
  route: ComponentHandler;
  spies: Readonly<Record<string, ReturnType<typeof vi.fn>>>;
} {
  const spies: Record<string, ReturnType<typeof vi.fn>> = {};
  const handlers: Record<string, ComponentHandler> = {};

  for (const prefix of new Set(LEGACY_CUSTOM_IDS.map((entry) => entry.prefix))) {
    const spy = vi.fn(async () => undefined);
    spies[prefix] = spy;
    handlers[prefix] = spy as unknown as ComponentHandler;
  }

  return { route: createCompositeComponentHandler(handlers), spies };
}

describe('legacy component custom-ID smoke test', () => {
  it('resolves every covered prefix to an active anchor with a live handler', () => {
    for (const entry of LEGACY_CUSTOM_IDS) {
      expect(resolveLegacyComponentCommand(entry.prefix), entry.prefix).toBe(entry.anchor);
      expect(hasComponentHandler(entry.prefix), entry.prefix).toBe(true);
    }
  });

  it('routes each original custom ID to its original handler without rewriting it', async () => {
    const { route, spies } = createRouter();

    for (const entry of LEGACY_CUSTOM_IDS) {
      const interaction = componentInteraction(entry.customId);
      await route(interaction);

      expect(interaction.customId, entry.customId).toBe(entry.customId);
      expect(spies[entry.prefix], entry.prefix).toHaveBeenCalledWith(interaction);
    }

    for (const [prefix, spy] of Object.entries(spies)) {
      const expectedCalls = LEGACY_CUSTOM_IDS.filter((entry) => entry.prefix === prefix).length;
      expect(spy, prefix).toHaveBeenCalledTimes(expectedCalls);
    }
  });

  it('ignores custom IDs with no original handler', async () => {
    const { route, spies } = createRouter();
    const interaction = componentInteraction('future-command:page:2');

    await route(interaction);

    for (const [prefix, spy] of Object.entries(spies)) {
      expect(spy, prefix).not.toHaveBeenCalledWith(interaction);
    }
  });

  it('reaches a folded anchor from a retired prefix through the registry dispatcher', async () => {
    const { route, spies } = createRouter();
    const customId = `club-overview:toggle:${GUILD_ID}`;
    const handleComponent = vi.fn(route);
    const anchor: CommandDefinition = {
      data: new SlashCommandBuilder().setName('clubs').setDescription('clubs'),
      handle: vi.fn(async () => undefined),
      handleComponent,
    };

    await dispatchInteraction(dispatchComponentInteraction(customId), [anchor]);

    expect(handleComponent).toHaveBeenCalledOnce();
    expect(spies['club-overview']).toHaveBeenCalledOnce();
    const received = spies['club-overview']?.mock.calls[0]?.[0] as
      | CommandComponentInteraction
      | undefined;
    expect(received?.customId).toBe(customId);
  });
});
