import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
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
    clubProfileUrlTemplate: 'https://example.test/clubs/{tag}',
    seasonStartIso: '2026-11-01T00:00:00.000Z',
  },
  memberService: {
    loadTrackedMembers: vi.fn(),
    searchTrackedMembersByPlayer: vi.fn(),
    searchTrackedMembersByDiscord: vi.fn(),
  },
  playerService: {
    loadPlayerClubs: vi.fn(),
    searchPlayers: vi.fn(),
  },
}));

vi.mock('../config', () => ({ getBotConfig: () => mocks.config }));
vi.mock('../membership/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../membership/service')>();
  return { ...actual, ...mocks.memberService };
});
vi.mock('../players/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../players/service')>();
  return { ...actual, ...mocks.playerService };
});

import {
  handleMemberHistory,
  handleMemberHistoryAutocomplete,
  handleMemberHistoryComponent,
} from './member-history';
import { handleMemberVerify, MEMBER_VERIFY_UNAVAILABLE_MESSAGE } from './member-verify';
import {
  decodeMemberSearchState,
  encodeMemberSearchState,
  handleMemberSearch,
  handleMemberSearchAutocomplete,
  handleMemberSearchComponent,
} from './member-search';
import {
  handleMembers,
  handleMembersAutocomplete,
  handleMembersComponent,
} from './members';

const ACTOR_DISCORD_ID = '111111111111111111';
const TARGET_DISCORD_ID = '222222222222222222';

function chatInteraction(
  options: Record<string, string | null> = {},
  subcommand: string | null = null,
) {
  return {
    guildId: 'guild-1',
    user: { id: ACTOR_DISCORD_ID },
    options: {
      getString: vi.fn((name: string) => options[name] ?? null),
      getSubcommand: vi.fn(() => subcommand),
    },
    replied: false,
    deferred: false,
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function buttonInteraction(customId: string) {
  return {
    customId,
    guildId: 'guild-1',
    user: { id: ACTOR_DISCORD_ID },
    deferred: false,
    replied: false,
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as unknown as ButtonInteraction;
}

function autocompleteInteraction(name: string, value: string) {
  return {
    options: { getFocused: vi.fn(() => ({ name, value })) },
    respond: vi.fn(async () => undefined),
  } as unknown as AutocompleteInteraction;
}

function payload(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  method: 'reply' | 'editReply',
): any {
  return (interaction[method] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as any;
}

function embedText(value: any): string {
  return JSON.stringify(value.embeds[0].toJSON());
}

function trackedRecord(index: number) {
  return {
    playerId: `p${index}`,
    playerTag: String(2000 + index),
    playerName: `Player ${index}`,
    trophies: 4000 + index,
    club: {
      id: `membership-${index}`,
      tag: index % 2 === 0 ? '8QCL' : '9QVR',
      name: index % 2 === 0 ? 'Alpha Club' : 'Beta Club',
      role: 'member',
      validFrom: '2026-11-01T00:00:00.000Z',
      validTo: index === 0 ? null : '2026-11-10T00:00:00.000Z',
    },
    status: index === 0 ? ('current' as const) : ('past' as const),
  };
}

function memberView(count: number) {
  const records = Array.from({ length: count }, (_, index) => trackedRecord(index));
  return {
    club: null,
    records,
    currentCount: 1,
    historicalCount: count - 1,
  };
}

function searchEntry(index: number) {
  return {
    playerId: `p${index}`,
    playerTag: String(3000 + index),
    playerName: `Search Player ${index}`,
    trophies: 4200 + index,
    currentClub: index === 0
      ? {
          id: 'membership-0',
          tag: '8QCL',
          name: 'Alpha Club',
          role: 'member',
          validFrom: '2026-11-01T00:00:00.000Z',
          validTo: null,
        }
      : null,
  };
}

function searchView(count: number, mode: 'player' | 'discord' = 'player') {
  return {
    mode,
    query: mode === 'player' ? 'alpha' : TARGET_DISCORD_ID,
    entries: Array.from({ length: count }, (_, index) => searchEntry(index)),
    identityContext: mode === 'discord',
  };
}

beforeEach(() => {
  for (const fn of Object.values(mocks.memberService)) fn.mockReset();
  for (const fn of Object.values(mocks.playerService)) fn.mockReset();
});

describe('/members command', () => {
  it('renders current and historical members with an optional club filter', async () => {
    mocks.memberService.loadTrackedMembers.mockResolvedValue({
      kind: 'ok',
      value: memberView(2),
    });
    const interaction = chatInteraction({ tag: '8QCL' });

    await handleMembers(interaction);

    expect(mocks.memberService.loadTrackedMembers).toHaveBeenCalledWith({ tag: '8QCL' });
    const text = embedText(payload(interaction, 'reply'));
    expect(text).toContain('Tracked Members');
    expect(text).toContain('Current: 1');
    expect(text).toContain('Historical/unverified: 1');
    expect(text).toContain('Current (verified by latest sync)');
    expect(text).toContain('Confirmed previous membership');
  });

  it('shows safe validation failures and empty views', async () => {
    const invalid = chatInteraction({ tag: 'bad-tag' });
    mocks.memberService.loadTrackedMembers.mockResolvedValueOnce({
      kind: 'invalid-tag',
      message: 'That club tag is not valid.',
    });
    await handleMembers(invalid);
    expect(payload(invalid, 'reply').content).toBe('That club tag is not valid.');

    const empty = chatInteraction();
    mocks.memberService.loadTrackedMembers.mockResolvedValueOnce({
      kind: 'ok',
      value: { ...memberView(0), currentCount: 0, historicalCount: 0 },
    });
    await handleMembers(empty);
    expect(embedText(payload(empty, 'reply'))).toContain('No stored membership records match');
  });

  it('paginates and restores the optional club filter', async () => {
    mocks.memberService.loadTrackedMembers.mockResolvedValue({
      kind: 'ok',
      value: memberView(12),
    });
    const interaction = buttonInteraction('members:page:2:8QCL');

    await handleMembersComponent(interaction);

    expect(mocks.memberService.loadTrackedMembers).toHaveBeenCalledWith({ tag: '8QCL' });
    expect(embedText(payload(interaction, 'editReply'))).toContain('Page 2 / 2');
  });

  it('offers club autocomplete', async () => {
    await handleMembersAutocomplete(autocompleteInteraction('tag', 'alp'));
    expect(mocks.playerService.searchPlayers).not.toHaveBeenCalled();
  });
});

describe('/member-verify command', () => {
  it('always reports that verification is unavailable without inferring ownership', async () => {
    const interaction = chatInteraction();
    await handleMemberVerify(interaction);
    const reply = payload(interaction, 'reply');
    expect(reply.content).toBe(MEMBER_VERIFY_UNAVAILABLE_MESSAGE);
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toContain('not infer player ownership');
  });
});

describe('/member-history command', () => {
  function historyMembership(index: number) {
    const record = trackedRecord(index);
    return {
      ...record.club,
      id: record.club.id,
      role: record.club.role,
      validFrom: record.club.validFrom,
      validTo: record.club.validTo,
      status: record.status,
      durationMs: null,
    };
  }

  function historyView(count: number) {
    const memberships = Array.from({ length: count }, (_, index) => historyMembership(index));
    return {
      player: {
        id: 'p0',
        tag: '2C0Y',
        name: 'Alpha',
        trophies: 5000,
        highestTrophies: 5200,
        expLevel: 35,
        lastSyncedAt: '2026-11-18T11:55:00.000Z',
      },
      currentClub: memberships[0] ?? null,
      memberships,
      events: [
        {
          id: 'event-1',
          eventType: 'transfer',
          detectedAt: '2026-11-10T00:00:00.000Z',
          fromClub: {
            id: 'membership-1',
            tag: '9QVR',
            name: 'Beta Club',
            role: null,
            validFrom: null,
            validTo: null,
          },
          toClub: {
            id: 'membership-0',
            tag: '8QCL',
            name: 'Alpha Club',
            role: null,
            validFrom: null,
            validTo: null,
          },
        },
      ],
      latestSyncAt: '2026-11-18T11:55:00.000Z',
    };
  }

  it('shows transfers, membership dates and incomplete records', async () => {
    mocks.playerService.loadPlayerClubs.mockResolvedValue({ kind: 'ok', value: historyView(2) });
    const interaction = chatInteraction({ tag: '#2c0y' });

    await handleMemberHistory(interaction);

    expect(mocks.playerService.loadPlayerClubs).toHaveBeenCalledWith({ tag: '#2c0y' });
    const text = embedText(payload(interaction, 'reply'));
    expect(text).toContain('Club History');
    expect(text).toContain('transferred from');
    expect(text).toContain('Joined:');
    expect(text).toContain('Left:');
    expect(text).toContain('Confirmed previous membership');
  });

  it('handles invalid players and paginates stored memberships', async () => {
    const invalid = chatInteraction({ tag: 'bad' });
    mocks.playerService.loadPlayerClubs.mockResolvedValueOnce({ kind: 'invalid-tag' });
    await handleMemberHistory(invalid);
    expect(payload(invalid, 'reply').content).toContain('not valid');

    mocks.playerService.loadPlayerClubs.mockResolvedValue({ kind: 'ok', value: historyView(12) });
    const interaction = buttonInteraction('member-history:page:2:2C0Y');
    await handleMemberHistoryComponent(interaction);
    expect(mocks.playerService.loadPlayerClubs).toHaveBeenCalledWith({ tag: '2C0Y' });
    expect(embedText(payload(interaction, 'editReply'))).toContain('Page 2 / 2');
  });

  it('offers stored player autocomplete', async () => {
    mocks.playerService.searchPlayers.mockResolvedValue([
      { id: 'p0', tag: '2C0Y', name: 'Alpha', trophies: 5000, highestTrophies: null, expLevel: null, lastSyncedAt: null },
    ]);
    await handleMemberHistoryAutocomplete(autocompleteInteraction('tag', 'alp'));
    expect(mocks.playerService.searchPlayers).toHaveBeenCalledWith('alp');
  });
});

describe('/member-search command', () => {
  it('searches by player name and tag', async () => {
    mocks.memberService.searchTrackedMembersByPlayer.mockResolvedValue({
      kind: 'ok',
      value: searchView(1),
    });
    const byName = chatInteraction({ query: 'alpha' }, 'player');
    await handleMemberSearch(byName);
    expect(mocks.memberService.searchTrackedMembersByPlayer).toHaveBeenCalledWith('alpha');
    expect(embedText(payload(byName, 'reply'))).toContain('Alpha');

    const byTag = chatInteraction({ query: '#2c0y' }, 'player');
    await handleMemberSearch(byTag);
    expect(mocks.memberService.searchTrackedMembersByPlayer).toHaveBeenCalledWith('#2c0y');
  });

  it('shows empty results and safe validation failures', async () => {
    const empty = chatInteraction({ query: 'nobody' }, 'player');
    mocks.memberService.searchTrackedMembersByPlayer.mockResolvedValueOnce({
      kind: 'ok',
      value: { ...searchView(0), query: 'nobody' },
    });
    await handleMemberSearch(empty);
    expect(embedText(payload(empty, 'reply'))).toContain('No tracked players matched');

    const invalid = chatInteraction({ query: 'a' }, 'player');
    mocks.memberService.searchTrackedMembersByPlayer.mockResolvedValueOnce({
      kind: 'invalid-input',
      message: 'Enter 2–32 characters.',
    });
    await handleMemberSearch(invalid);
    expect(payload(invalid, 'reply').content).toContain('Enter 2–32 characters');

    const unknown = chatInteraction({}, 'unknown');
    await handleMemberSearch(unknown);
    expect(payload(unknown, 'reply').content).toContain('Choose either');
  });

  it('allows Discord identity search for staff and enforces permission failures', async () => {
    mocks.memberService.searchTrackedMembersByDiscord.mockResolvedValueOnce({
      kind: 'ok',
      value: searchView(1, 'discord'),
    });
    const staff = chatInteraction({ user: TARGET_DISCORD_ID }, 'discord');
    await handleMemberSearch(staff);
    expect(mocks.memberService.searchTrackedMembersByDiscord).toHaveBeenCalledWith(
      TARGET_DISCORD_ID,
      ACTOR_DISCORD_ID,
    );
    const text = embedText(payload(staff, 'reply'));
    expect(text).toContain('Linked Discord Players');
    expect(text).toContain(TARGET_DISCORD_ID);
    expect(text).toContain('No ownership is inferred');

    const member = chatInteraction({ user: TARGET_DISCORD_ID }, 'discord');
    mocks.memberService.searchTrackedMembersByDiscord.mockResolvedValueOnce({
      kind: 'forbidden',
      message: 'You do not have permission.',
    });
    await handleMemberSearch(member);
    expect(payload(member, 'reply').content).toBe('You do not have permission.');
    expect(payload(member, 'reply').ephemeral).toBe(true);
  });

  it('round-trips encoded pagination state and paginates results', async () => {
    const state = { mode: 'player' as const, query: 'alpha player' };
    const encoded = encodeMemberSearchState(state);
    expect(decodeMemberSearchState(encoded)).toEqual(state);

    mocks.memberService.searchTrackedMembersByPlayer.mockResolvedValue({
      kind: 'ok',
      value: searchView(12),
    });
    const interaction = buttonInteraction(`member-search:page:2:${encoded}`);
    await handleMemberSearchComponent(interaction);
    expect(mocks.memberService.searchTrackedMembersByPlayer).toHaveBeenCalledWith('alpha player');
    expect(embedText(payload(interaction, 'editReply'))).toContain('Page 2 / 2');
  });

  it('offers player autocomplete only for the query option', async () => {
    mocks.playerService.searchPlayers.mockResolvedValue([
      { id: 'p0', tag: '2C0Y', name: 'Alpha', trophies: 5000, highestTrophies: null, expLevel: null, lastSyncedAt: null },
    ]);
    await handleMemberSearchAutocomplete(autocompleteInteraction('query', 'alp'));
    expect(mocks.playerService.searchPlayers).toHaveBeenCalledWith('alp');

    await handleMemberSearchAutocomplete(autocompleteInteraction('user', '111'));
    expect(mocks.playerService.searchPlayers).toHaveBeenCalledTimes(1);
  });
});
