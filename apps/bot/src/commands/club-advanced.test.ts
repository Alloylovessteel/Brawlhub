import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';

const mocks = vi.hoisted(() => ({
  config: {
    token: undefined,
    clientId: undefined,
    guildId: 'guild-1',
    callbackUrl: undefined,
    logLevel: undefined,
    emojis: {
      trophies: undefined,
      trophyRange: undefined,
      president: undefined,
      requiredTrophies: undefined,
      members: undefined,
      matches: undefined,
      progression: undefined,
      description: undefined,
    },
    playerProfileUrlTemplate: 'https://brawlify.com/player/{tag}',
    seasonStartIso: '2026-11-01T00:00:00Z',
  },
  service: {
    loadMemberView: vi.fn(),
    loadLeaderboardView: vi.fn(),
    getRegisteredClubs: vi.fn(),
    filterRegisteredClubs: vi.fn(),
  },
}));

vi.mock('../config', () => ({ getBotConfig: () => mocks.config }));
vi.mock('../clubs/service', () => mocks.service);

import { handleClubLeaderboard, handleClubLeaderboardAutocomplete, handleClubLeaderboardComponent } from './club-leaderboard';
import { handleClubMembers, handleClubMembersAutocomplete, handleClubMembersComponent } from './club-members';

function chatInteraction(options: Record<string, string | null> = {}, userId = 'user-1') {
  const interaction = {
    guildId: 'guild-1',
    user: { id: userId },
    options: { getString: vi.fn((name: string) => options[name] ?? null) },
    replied: false,
    deferred: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  return interaction as unknown as ChatInputCommandInteraction;
}

function buttonInteraction(customId: string, userId = 'user-1') {
  return {
    customId,
    guildId: 'guild-1',
    user: { id: userId },
    deferred: false,
    replied: false,
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as unknown as ButtonInteraction;
}

function selectInteraction(
  customId: string,
  values: string[],
  guildId = 'guild-1',
  userId = 'user-1',
) {
  return {
    customId,
    guildId,
    user: { id: userId },
    values,
    isStringSelectMenu: vi.fn(() => true),
    deferred: false,
    replied: false,
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as unknown as StringSelectMenuInteraction;
}

function autocompleteInteraction(name: string, value: string) {
  return {
    options: { getFocused: vi.fn(() => ({ name, value })) },
    respond: vi.fn(async () => undefined),
  } as unknown as AutocompleteInteraction;
}

const CLUB = {
  id: 'club-1',
  tag: '2C0Y',
  name: 'Alpha',
  description: null,
  trophies: 1000,
  requiredTrophies: 500,
  memberCount: 30,
  lastSyncedAt: null,
};

function synced(roster: readonly Record<string, unknown>[] = []) {
  return {
    club: CLUB,
    snapshots: [],
    completedRunIds: new Set<string>(),
    latestSnapshot: null,
    roster,
    rosterSource: 'snapshot' as const,
    latestSyncAt: '2026-11-18T06:05:00.000Z',
  };
}

function members(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    tag: `G2P${index}`,
    name: `Player ${index + 1}`,
    trophies: 2000 - index * 100,
    role: index === 0 ? 'president' : 'member',
    playerId: `p${index}`,
    highestTrophies: 2100 - index * 100,
  }));
}

function memberResult(count: number) {
  const list = members(count);
  return { kind: 'ok' as const, value: { ...synced(list), members: list } };
}

function leaderboardResult(count: number) {
  const entries = members(count).map((member, index) => ({
    ...member,
    rank: index + 1,
    progression: { today: 10, week: 20, season: 30 },
  }));
  return { kind: 'ok' as const, value: { ...synced(), entries } };
}

function payloadOf(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
  method: 'reply' | 'editReply',
): any {
  return (interaction[method] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as any;
}

beforeEach(() => {
  mocks.service.loadMemberView.mockReset();
  mocks.service.loadLeaderboardView.mockReset();
  mocks.service.getRegisteredClubs.mockReset();
  mocks.service.filterRegisteredClubs.mockReset();
});

describe('/clubs members command', () => {
  it('uses the only registered club and pages the roster ten members at a time', async () => {
    mocks.service.loadMemberView.mockResolvedValue(memberResult(12));
    const interaction = chatInteraction();

    await handleClubMembers(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.service.loadMemberView).toHaveBeenCalledWith({
      tag: undefined,
      guildId: 'guild-1',
    });
    const payload = payloadOf(interaction, 'editReply');
    expect(payload.embeds[0].toJSON().fields).toHaveLength(10);
    expect(payload.embeds[0].toJSON().footer?.text).toContain('Page 1 / 2');
    expect(payload.components[0].toJSON().components[0]?.custom_id).toBe(
      'club-members:page:2:default',
    );
  });

  it('normalizes the tag into pagination state and restores it on page changes', async () => {
    mocks.service.loadMemberView.mockResolvedValue(memberResult(12));
    const button = buttonInteraction('club-members:page:2:2C0Y');

    await handleClubMembersComponent(button);

    expect(button.deferUpdate).toHaveBeenCalledOnce();
    expect(mocks.service.loadMemberView).toHaveBeenCalledWith({
      tag: '2C0Y',
      guildId: 'guild-1',
    });
    const payload = payloadOf(button, 'editReply');
    expect(payload.embeds[0].toJSON().footer?.text).toContain('Page 2 / 2');
    expect(payload.content).toBeNull();
  });

  it('ignores pagination buttons from other commands', async () => {
    await handleClubMembersComponent(buttonInteraction('clubs:page:2'));

    expect(mocks.service.loadMemberView).not.toHaveBeenCalled();
  });

  it('explains invalid and unregistered tags', async () => {
    const invalid = chatInteraction({ tag: '#BAD-TAG!' });
    mocks.service.loadMemberView.mockResolvedValueOnce({ kind: 'invalid-tag' });
    await handleClubMembers(invalid);
    expect(invalid.deferReply).toHaveBeenCalledOnce();
    expect((invalid.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ content: expect.stringContaining('not valid') }),
    );

    const unregistered = chatInteraction({ tag: 'G2P9' });
    mocks.service.loadMemberView.mockResolvedValueOnce({ kind: 'unregistered', tag: 'G2P9' });
    await handleClubMembers(unregistered);
    expect(unregistered.deferReply).toHaveBeenCalledOnce();
    expect((unregistered.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ content: expect.stringContaining('not registered') }),
    );
  });

  it('offers registered club autocomplete choices', async () => {
    const clubs = [{ ...CLUB }];
    mocks.service.getRegisteredClubs.mockResolvedValue(clubs);
    mocks.service.filterRegisteredClubs.mockReturnValue(clubs);
    const interaction = autocompleteInteraction('tag', 'alp');

    await handleClubMembersAutocomplete(interaction);

    expect(mocks.service.filterRegisteredClubs).toHaveBeenCalledWith(clubs, 'alp');
    expect(interaction.respond).toHaveBeenCalledWith([{ name: 'Alpha (#2C0Y)', value: '2C0Y' }]);
  });

  it('offers a club chooser when the tagless lookup has no default', async () => {
    mocks.service.loadMemberView.mockResolvedValueOnce({ kind: 'no-default' });
    mocks.service.getRegisteredClubs.mockResolvedValue([
      CLUB,
      { ...CLUB, id: 'club-2', tag: 'TAG2', name: 'Beta' },
    ]);
    const interaction = chatInteraction();

    await handleClubMembers(interaction);

    const payload = payloadOf(interaction, 'editReply');
    expect(payload.content).toContain('2 registered clubs');
    const menu = payload.components[0].toJSON().components[0];
    expect(menu.custom_id).toMatch(/^club-members:choose:/);
    expect(menu.options.map((option: { value: string }) => option.value)).toEqual(['2C0Y', 'TAG2']);
    expect(menu.min_values).toBe(1);
    expect(menu.max_values).toBe(1);
  });

  it('continues the command with the club chosen from the chooser', async () => {
    mocks.service.loadMemberView
      .mockResolvedValueOnce({ kind: 'no-default' })
      .mockResolvedValueOnce(memberResult(2));
    mocks.service.getRegisteredClubs.mockResolvedValue([
      CLUB,
      { ...CLUB, id: 'club-2', tag: 'TAG2', name: 'Beta' },
    ]);
    const interaction = chatInteraction();
    await handleClubMembers(interaction);
    const customId = payloadOf(interaction, 'editReply').components[0].toJSON().components[0].custom_id as string;
    const select = selectInteraction(customId, ['TAG2']);

    await handleClubMembersComponent(select);

    expect(select.deferUpdate).toHaveBeenCalledOnce();
    expect(mocks.service.loadMemberView).toHaveBeenLastCalledWith({
      tag: 'TAG2',
      guildId: 'guild-1',
    });
    expect(payloadOf(select, 'editReply').embeds).toHaveLength(1);
  });

  it('does not let another user use a club chooser', async () => {
    mocks.service.loadMemberView.mockResolvedValueOnce({ kind: 'no-default' });
    mocks.service.getRegisteredClubs.mockResolvedValue([CLUB, { ...CLUB, id: 'club-2', tag: 'TAG2' }]);
    const interaction = chatInteraction();
    await handleClubMembers(interaction);
    const customId = payloadOf(interaction, 'editReply').components[0].toJSON().components[0].custom_id as string;
    const select = selectInteraction(customId, ['TAG2'], 'guild-1', 'user-2');

    await handleClubMembersComponent(select);

    expect(select.deferUpdate).toHaveBeenCalledOnce();
    expect(payloadOf(select, 'editReply').content).toContain('expired');
    expect(mocks.service.loadMemberView).toHaveBeenCalledTimes(1);
  });
});

describe('/clubs leaderboard command', () => {
  it('pages ranked stored entries and preserves the selected tag', async () => {
    mocks.service.loadLeaderboardView.mockResolvedValue(leaderboardResult(11));
    const interaction = chatInteraction({ tag: '#2c0y' });

    await handleClubLeaderboard(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.service.loadLeaderboardView).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: '#2c0y',
        guildId: 'guild-1',
        seasonStartIso: mocks.config.seasonStartIso,
      }),
    );
    const payload = payloadOf(interaction, 'editReply');
    expect(payload.embeds[0].toJSON().fields).toHaveLength(10);
    expect(payload.components[0].toJSON().components[0]?.custom_id).toBe(
      'club-leaderboard:page:2:2C0Y',
    );
  });

  it('renders a safe empty leaderboard when no stored trophy data exists', async () => {
    mocks.service.loadLeaderboardView.mockResolvedValue(leaderboardResult(0));
    const interaction = chatInteraction();

    await handleClubLeaderboard(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    const payload = payloadOf(interaction, 'editReply');
    expect(JSON.stringify(payload.embeds[0].toJSON())).toContain('No members have valid stored trophy data');
    expect(payload.components).toEqual([]);
  });

  it('updates leaderboard pages from stateful buttons', async () => {
    mocks.service.loadLeaderboardView.mockResolvedValue(leaderboardResult(11));
    const button = buttonInteraction('club-leaderboard:page:2:2C0Y');

    await handleClubLeaderboardComponent(button);

    expect(mocks.service.loadLeaderboardView).toHaveBeenCalledWith(
      expect.objectContaining({ tag: '2C0Y' }),
    );
    expect(payloadOf(button, 'editReply').embeds[0].toJSON().footer?.text).toContain('Page 2 / 2');
  });

  it('offers registered club autocomplete choices', async () => {
    const clubs = [{ ...CLUB }];
    mocks.service.getRegisteredClubs.mockResolvedValue(clubs);
    mocks.service.filterRegisteredClubs.mockReturnValue(clubs);
    const interaction = autocompleteInteraction('tag', '2C0');

    await handleClubLeaderboardAutocomplete(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([{ name: 'Alpha (#2C0Y)', value: '2C0Y' }]);
  });
});
