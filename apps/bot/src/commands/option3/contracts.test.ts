import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { commands, pendingCommands } from '../index';
import { handleClubComponent } from '../club';
import { handleClubsComponent } from '../clubs';
import { handleClubMembersComponent } from '../club-members';
import { handleClubLeaderboardComponent } from '../club-leaderboard';
import { handleClubLogComponent } from '../club-log';
import { handleClubHistoryComponent } from '../club-history';
import { handleClubOverviewComponent } from '../club-overview';
import { handleClubLogsComponent } from '../clublogs';
import { handleEventsComponent } from '../events';
import { handleMeComponent } from '../me-components';
import { handlePlayerHistoryComponent } from '../player-history';
import { handlePlayerBattlesComponent } from '../player-battles';
import { handleBrawlersComponent } from '../brawlers';
import { handlePlayerClubsComponent } from '../player-clubs';
import { handleLeaderboardComponent } from '../leaderboard';
import { handleCompetitionComponent } from '../competition';
import { handleMembersComponent } from '../members';
import {
  handleUnverifyAllComponent,
  handleUnverifyOneComponent,
} from '../admin-identity';
import { handleDeleteMeComponent } from '../delete-me';
import { handleMemberHistoryComponent } from '../member-history';
import { handleMemberSearchComponent } from '../member-search';
import { handleStaffComponent } from '../staff';
import { handleRegisterClubComponent } from '../register-club';
import { handleSettingsComponent } from '../settings';
import { handleAuditComponent } from '../audit';
import { handleRemoveClubComponent } from '../remove-club';
import { handleHelpComponent } from '../help';
import { handleFnComponent } from '../fn';
import { handleAutoComponent } from '../auto';
import { handleUpdateComponent } from '../update';
import { asLegacyAutocomplete, asLegacyChatInput } from './adapter';
import {
  brawlersAnchorData,
  clubsAnchorData,
  helpAnchorData,
  membersAnchorData,
  playerAnchorData,
} from './anchors';
import { tagSetCommandData, verifyAnchorData } from './verify-anchor';
import {
  COMPONENT_HANDLERS,
  LEGACY_COMPONENT_ALIASES,
  hasComponentHandler,
  resolveLegacyComponentCommand,
} from './component-router';

const ACTIVE_COMMANDS = [
  'clubs',
  'me',
  'brawlers',
  'player',
  'leaderboard',
  'events',
  'competition',
  'members',
  'verify',
  'tag-set',
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
] as const;

const EXPECTED_ALIASES: Readonly<Record<string, string>> = {
  club: 'clubs',
  'club-members': 'clubs',
  'club-leaderboard': 'clubs',
  'club-log': 'clubs',
  'club-history': 'clubs',
  'club-compare': 'clubs',
  view: 'clubs',
  'club-overview': 'clubs',
  clublogs: 'clubs',
  'register-club': 'clubs',
  'remove-club': 'clubs',
  'player-history': 'player',
  'player-battles': 'player',
  'player-clubs': 'player',
  'player-compare': 'player',
  brawler: 'brawlers',
  account: 'verify',
  'unverify-one': 'verify',
  'unverify-all': 'verify',
  'delete-me': 'verify',
  'member-history': 'members',
  'member-search': 'members',
  info: 'help',
  ping: 'help',
};

type JsonOption = {
  readonly name: string;
  readonly type: number;
  readonly options?: readonly JsonOption[];
  readonly autocomplete?: boolean;
  readonly required?: boolean;
  readonly max_length?: number;
};

function optionsOf(data: { toJSON: () => { options?: unknown } }): readonly JsonOption[] {
  return (data.toJSON().options ?? []) as readonly JsonOption[];
}

function optionNamed(options: readonly JsonOption[], name: string): JsonOption {
  const option = options.find((candidate) => candidate.name === name);
  if (option === undefined) {
    throw new Error(`Missing option ${name}`);
  }
  return option;
}

describe('Option 3 registry contract', () => {
  it('registers exactly the 20 approved anchors', () => {
    expect(commands.map((command) => command.data.name)).toEqual([...ACTIVE_COMMANDS]);
    expect(pendingCommands.map((command) => command.data.name)).toEqual(['blacklist']);
  });

  it('gives every anchor that absorbs legacy components a composite handler', () => {
    for (const name of ['clubs', 'player', 'brawlers', 'members', 'verify', 'tag-set', 'help']) {
      expect(commands.find((command) => command.data.name === name)?.handleComponent).toBeTypeOf(
        'function',
      );
    }
  });

  it('gives every folded command with autocomplete a matching anchor autocomplete handler', () => {
    for (const name of ['clubs', 'player', 'brawlers', 'members', 'verify']) {
      expect(commands.find((command) => command.data.name === name)?.autocomplete).toBeTypeOf(
        'function',
      );
    }
  });
});

describe('Option 3 legacy component contract', () => {
  it('maps every retired top-level prefix to its anchor without rewriting custom IDs', () => {
    expect(LEGACY_COMPONENT_ALIASES).toEqual(EXPECTED_ALIASES);
    for (const [prefix, anchor] of Object.entries(LEGACY_COMPONENT_ALIASES)) {
      expect(resolveLegacyComponentCommand(prefix)).toBe(anchor);
      expect(commands.find((command) => command.data.name === anchor)?.handleComponent).toBeTypeOf(
        'function',
      );
    }
    expect(resolveLegacyComponentCommand('unknown')).toBe('unknown');
  });

  it('never lets a legacy alias collide with an active command name', () => {
    for (const prefix of Object.keys(LEGACY_COMPONENT_ALIASES)) {
      expect(ACTIVE_COMMANDS).not.toContain(prefix);
    }
  });

  it('keeps a handler for every custom-ID prefix the bot has ever emitted', () => {
    const emittedPrefixes = [
      'club',
      'clubs',
      'club-members',
      'club-leaderboard',
      'club-log',
      'club-history',
      'club-overview',
      'clublogs',
      'events',
      'me',
      'player-history',
      'player-battles',
      'brawlers',
      'player-clubs',
      'leaderboard',
      'competition',
      'members',
      'unverify-one',
      'unverify-all',
      'delete-me',
      'member-history',
      'member-search',
      'staff',
      'register-club',
      'settings',
      'audit',
      'remove-club',
      'help',
      'fn',
      'auto',
      'update',
    ];
    for (const prefix of emittedPrefixes) {
      expect(hasComponentHandler(prefix)).toBe(true);
    }
  });

  it('routes each original prefix to its original component handler', () => {
    expect(COMPONENT_HANDLERS).toEqual({
      club: handleClubComponent,
      clubs: handleClubsComponent,
      'club-members': handleClubMembersComponent,
      'club-leaderboard': handleClubLeaderboardComponent,
      'club-log': handleClubLogComponent,
      'club-history': handleClubHistoryComponent,
      'club-overview': handleClubOverviewComponent,
      clublogs: handleClubLogsComponent,
      events: handleEventsComponent,
      me: handleMeComponent,
      'player-history': handlePlayerHistoryComponent,
      'player-battles': handlePlayerBattlesComponent,
      brawlers: handleBrawlersComponent,
      'player-clubs': handlePlayerClubsComponent,
      leaderboard: handleLeaderboardComponent,
      competition: handleCompetitionComponent,
      members: handleMembersComponent,
      'unverify-one': handleUnverifyOneComponent,
      'unverify-all': handleUnverifyAllComponent,
      'delete-me': handleDeleteMeComponent,
      'member-history': handleMemberHistoryComponent,
      'member-search': handleMemberSearchComponent,
      staff: handleStaffComponent,
      'register-club': handleRegisterClubComponent,
      settings: handleSettingsComponent,
      audit: handleAuditComponent,
      'remove-club': handleRemoveClubComponent,
      help: handleHelpComponent,
      fn: handleFnComponent,
      auto: handleAutoComponent,
      update: handleUpdateComponent,
    });
  });
});

describe('Option 3 legacy interaction adapter', () => {
  it('presents a new chat-input shape to an old handler while preserving option access', () => {
    const getString = vi.fn(() => 'tag-value');
    const options = {
      getSubcommandGroup: vi.fn(() => 'new-group'),
      getSubcommand: vi.fn(() => 'new-subcommand'),
      getString,
    };
    const interaction = { guildId: 'guild-1', options, deferReply: vi.fn() };
    const legacy = asLegacyChatInput(interaction as unknown as ChatInputCommandInteraction, {
      group: 'old-group',
      subcommand: 'old-subcommand',
    });

    expect(legacy.guildId).toBe('guild-1');
    expect(legacy.options.getSubcommandGroup(false)).toBe('old-group');
    expect(legacy.options.getSubcommand(false)).toBe('old-subcommand');
    expect(legacy.options.getString('tag', false)).toBe('tag-value');
    expect(getString).toHaveBeenCalledWith('tag', false);
    expect(options.getSubcommand).not.toHaveBeenCalled();
  });

  it('presents a new autocomplete shape to an old handler', () => {
    const options = {
      getSubcommandGroup: vi.fn(() => 'new-group'),
      getSubcommand: vi.fn(() => 'new-subcommand'),
    };
    const interaction = { guildId: 'guild-2', options, respond: vi.fn() };
    const legacy = asLegacyAutocomplete(interaction as unknown as AutocompleteInteraction, 'old');

    expect(legacy.guildId).toBe('guild-2');
    expect(legacy.options.getSubcommandGroup(false)).toBeNull();
    expect(legacy.options.getSubcommand(false)).toBe('old');
    expect(options.getSubcommand).not.toHaveBeenCalled();
  });
});

describe('Option 3 anchor option preservation', () => {
  it('preserves autocomplete, choices and length limits when copying options', () => {
    const clubsOptions = optionsOf(clubsAnchorData);
    const details = optionNamed(clubsOptions, 'details');
    expect(optionNamed(details.options ?? [], 'tag')).toMatchObject({
      name: 'tag',
      autocomplete: true,
      max_length: 11,
    });
    expect(optionNamed(details.options ?? [], 'sort').options).toBeUndefined();

    const compare = optionNamed(clubsOptions, 'compare');
    expect(optionNamed(compare.options ?? [], 'first')).toMatchObject({
      name: 'first',
      required: true,
      autocomplete: true,
    });
    expect(optionNamed(clubsOptions, 'clublogs')).toBeDefined();

    const brawlersOptions = optionsOf(brawlersAnchorData);
    const detail = optionNamed(brawlersOptions, 'detail');
    expect(optionNamed(detail.options ?? [], 'name')).toMatchObject({
      name: 'name',
      required: true,
      autocomplete: true,
      max_length: 100,
    });
  });

  it('keeps only member searches under /members', () => {
    const memberOptions = optionsOf(membersAnchorData);
    expect(memberOptions.map((option) => option.name)).toEqual(['roster', 'find', 'history']);

    const find = optionNamed(memberOptions, 'find');
    expect(find.options?.map((option) => option.name)).toEqual(['player', 'discord']);
    expect(optionNamed(optionNamed(find.options ?? [], 'player').options ?? [], 'query')).toMatchObject({
      name: 'query',
      required: true,
      autocomplete: true,
      max_length: 32,
    });
  });

  it('builds the /verify anchor with every verification action', () => {
    const verifyOptions = optionsOf(verifyAnchorData);
    expect(verifyOptions.map((option) => option.name)).toEqual([
      'tag',
      'check',
      'cancel',
      'status',
      'info',
      'settings',
      'list',
      'find',
      'unverify-one',
      'unverify-all',
      'delete-me',
      'set-verified-role',
      'clear-verified-role',
      'accounts',
    ]);

    expect(optionNamed(optionNamed(verifyOptions, 'tag').options ?? [], 'tag')).toMatchObject({
      name: 'tag',
      required: true,
    });

    const find = optionNamed(verifyOptions, 'find');
    expect(find.options?.map((option) => option.name)).toEqual(['user', 'tag']);
    expect(optionNamed(find.options ?? [], 'user').options?.[0]?.type).toBe(6);

    const unverifyOne = optionNamed(verifyOptions, 'unverify-one');
    expect(unverifyOne.options?.map((option) => option.name)).toEqual(['user', 'tag']);

    const accounts = optionNamed(verifyOptions, 'accounts');
    expect(accounts.options?.map((option) => option.name)).toEqual(['list', 'set-main']);
    expect(
      optionNamed(optionNamed(accounts.options ?? [], 'set-main').options ?? [], 'tag'),
    ).toMatchObject({ name: 'tag', required: true, autocomplete: true });

    expect(
      optionNamed(optionNamed(verifyOptions, 'set-verified-role').options ?? [], 'role').type,
    ).toBe(8);
  });

  it('builds the top-level /tag-set anchor with staff options', () => {
    const tagSetOptions = optionsOf(tagSetCommandData);
    expect(tagSetOptions.map((option) => option.name)).toEqual(['user', 'tag', 'reason']);
    expect(optionNamed(tagSetOptions, 'user').type).toBe(6);
    expect(optionNamed(tagSetOptions, 'tag').required).toBe(true);
    expect(optionNamed(tagSetOptions, 'reason').required).toBe(false);
  });

  it('builds the help anchor from the retired help, info and ping commands', () => {
    expect(optionsOf(helpAnchorData).map((option) => option.name)).toEqual([
      'directory',
      'about',
      'status',
      'ping',
    ]);
  });

  it('builds the player anchor from the retired player command set', () => {
    expect(optionsOf(playerAnchorData).map((option) => option.name)).toEqual([
      'history',
      'battles',
      'clubs',
      'compare',
    ]);
  });
});
