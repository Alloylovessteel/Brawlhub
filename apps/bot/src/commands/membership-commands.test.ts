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
    appUrl: undefined as string | undefined,
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
  verificationService: {
    startVerification: vi.fn(),
    checkVerification: vi.fn(),
    cancelVerification: vi.fn(),
    getVerificationChallenge: vi.fn(),
  },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  adminService: {
    requireGlobalPermission: vi.fn(),
    AdminServiceError: class AdminServiceError extends Error {
      readonly code: string;
      constructor(code: string, message: string) {
        super(message);
        this.name = 'AdminServiceError';
        this.code = code;
      }
    },
  },
}));

vi.mock('../config', () => ({ getBotConfig: () => mocks.config }));
vi.mock('@brawlhub/logging', () => ({
  createLogger: () => ({
    debug: mocks.logger.debug,
    info: mocks.logger.info,
    warn: mocks.logger.warn,
    error: mocks.logger.error,
  }),
}));
vi.mock('../membership/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../membership/service')>();
  return { ...actual, ...mocks.memberService };
});
vi.mock('../players/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../players/service')>();
  return { ...actual, ...mocks.playerService };
});
vi.mock('../verification', () => mocks.verificationService);
vi.mock('../admin/service', () => mocks.adminService);
vi.mock('../discord/permissions.js', () => ({ getInteractionMemberRoleIds: () => [] }));

import {
  handleMemberHistory,
  handleMemberHistoryAutocomplete,
  handleMemberHistoryComponent,
} from './member-history';
import { handleMemberVerify } from './member-verify';
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
import { clearBotRateLimits } from '../discord/rate-limit';

const ACTOR_DISCORD_ID = '111111111111111111';
const TARGET_DISCORD_ID = '222222222222222222';

function chatInteraction(
  options: Record<string, string | null> = {},
  subcommand: string | null = null,
) {
  const interaction = {
    guildId: 'guild-1',
    guild: { ownerId: '999999999999999999' },
    user: { id: ACTOR_DISCORD_ID, username: null },
    member: { roles: { cache: new Map() } },
    memberPermissions: null,
    options: {
      getString: vi.fn((name: string) => options[name] ?? null),
      getSubcommand: vi.fn(() => subcommand),
    },
    replied: false,
    deferred: false,
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    followUp: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
  };
  return interaction as unknown as ChatInputCommandInteraction;
}

function buttonInteraction(customId: string) {
  return {
    customId,
    guildId: 'guild-1',
    guild: { ownerId: '999999999999999999' },
    user: { id: ACTOR_DISCORD_ID, username: null },
    member: { roles: { cache: new Map() } },
    memberPermissions: null,
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
  clearBotRateLimits();
  for (const fn of Object.values(mocks.memberService)) fn.mockReset();
  for (const fn of Object.values(mocks.playerService)) fn.mockReset();
  for (const fn of Object.values(mocks.verificationService)) {
    if (typeof (fn as { mockReset?: () => void }).mockReset === 'function') {
      (fn as { mockReset: () => void }).mockReset();
    }
  }
  mocks.adminService.requireGlobalPermission.mockReset();
  mocks.adminService.requireGlobalPermission.mockResolvedValue({
    profileId: 'profile-1',
    discordUserId: ACTOR_DISCORD_ID,
    globalRole: 'staff',
  });
  mocks.config.appUrl = undefined;
});

describe('/members roster command', () => {
  it('renders current and historical members with an optional club filter', async () => {
    mocks.memberService.loadTrackedMembers.mockResolvedValue({
      kind: 'ok',
      value: memberView(2),
    });
    const interaction = chatInteraction({ tag: '8QCL' });

    await handleMembers(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.memberService.loadTrackedMembers).toHaveBeenCalledWith({ tag: '8QCL', guildId: 'guild-1' });
    const text = embedText(payload(interaction, 'editReply'));
    expect(text).toContain('Tracked Members');
    expect(text).toContain('**Current:** 1');
    expect(text).toContain('**Historical/unverified:** 1');
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
    expect(invalid.deferReply).toHaveBeenCalledOnce();
    expect(payload(invalid, 'editReply').content).toBe('That club tag is not valid.');

    const empty = chatInteraction();
    mocks.memberService.loadTrackedMembers.mockResolvedValueOnce({
      kind: 'ok',
      value: { ...memberView(0), currentCount: 0, historicalCount: 0 },
    });
    await handleMembers(empty);
    expect(empty.deferReply).toHaveBeenCalledOnce();
    expect(embedText(payload(empty, 'editReply'))).toContain('No stored membership records match');
  });

  it('paginates and restores the optional club filter', async () => {
    mocks.memberService.loadTrackedMembers.mockResolvedValue({
      kind: 'ok',
      value: memberView(12),
    });
    const interaction = buttonInteraction('members:page:2:8QCL');

    await handleMembersComponent(interaction);

    expect(mocks.memberService.loadTrackedMembers).toHaveBeenCalledWith({ tag: '8QCL', guildId: 'guild-1' });
    expect(embedText(payload(interaction, 'editReply'))).toContain('Page 2 / 2');
  });

  it('offers club autocomplete', async () => {
    await handleMembersAutocomplete(autocompleteInteraction('tag', 'alp'));
    expect(mocks.playerService.searchPlayers).not.toHaveBeenCalled();
  });
});

describe('/verify tag command', () => {
  it('starts icon verification, defers ephemerally, and shows a random required default brawler icon without inferring ownership', async () => {
    mocks.verificationService.startVerification.mockResolvedValue({
      ok: true,
      challenge: {
        discordUserId: ACTOR_DISCORD_ID,
        profileId: 'profile-1',
        playerTag: '2C0Y',
        playerDbId: 'player-db-1',
        playerName: 'Alpha',
        startingIconId: 28000000,
        targetIconId: 28000016,
        targetIconName: 'Spike',
        targetIconUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000016.png',
        createdAt: 1_732_000_000_000,
        expiresAt: 1_732_000_600_000,
      },
    });
    const interaction = chatInteraction({ tag: '#2c0y' }, 'start');

    await handleMemberVerify(interaction);

    expect((interaction.deferReply as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ flags: 64 });
    expect(mocks.verificationService.startVerification).toHaveBeenCalledWith({
      discordUserId: ACTOR_DISCORD_ID,
      guildId: 'guild-1',
      tagInput: '#2c0y',
      discordUsername: null,
    });
    const reply = payload(interaction, 'editReply');
    expect(reply.content).toContain('Verification started for Alpha (#2C0Y)');
    expect(reply.content).toContain('Spike');
    expect(reply.content).toContain('default brawler icon');
    expect(reply.content).toContain('automatically');
    expect(reply.content).toContain('any other icon will not verify');
    expect(reply.content).toContain('will not infer ownership');
    expect(reply.embeds?.[0]?.toJSON?.().image?.url ?? JSON.stringify(reply.embeds)).toContain('28000016');
  });

  it('shows the existing challenge when an active verification already exists', async () => {
    mocks.verificationService.startVerification.mockResolvedValue({
      ok: false,
      code: 'active-challenge',
      message: 'You already have an active verification challenge for #2C0Y with required icon **Spike**.',
      challenge: {
        discordUserId: ACTOR_DISCORD_ID,
        profileId: 'profile-1',
        playerTag: '2C0Y',
        playerDbId: 'player-db-1',
        playerName: 'Alpha',
        startingIconId: 28000000,
        targetIconId: 28000016,
        targetIconName: 'Spike',
        targetIconUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000016.png',
        createdAt: 1_732_000_000_000,
        expiresAt: 1_732_001_800_000,
      },
    });
    const interaction = chatInteraction({ tag: '#OTHER' }, 'start');

    await handleMemberVerify(interaction);

    const reply = payload(interaction, 'editReply');
    expect(reply.content).toContain('already have an active verification challenge');
    expect(reply.content).toContain('#2C0Y');
    expect(reply.content).toContain('Spike');
    expect(reply.embeds?.[0]?.toJSON?.().image?.url ?? JSON.stringify(reply.embeds)).toContain('28000016');
  });

  it('reports when the required default brawler icon is not set yet', async () => {
    mocks.verificationService.checkVerification.mockResolvedValue({
      ok: true,
      status: 'pending',
      playerTag: '2C0Y',
      playerName: 'Alpha',
      startingIconId: 28000000,
      targetIconId: 28000016,
      targetIconName: 'Spike',
      targetIconUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000016.png',
      currentIconId: 28000003,
      expiresAt: 1_732_000_600_000,
    });
    const interaction = chatInteraction({}, 'check');

    await handleMemberVerify(interaction);

    const reply = payload(interaction, 'editReply');
    expect(reply.content).toContain('Required icon not detected yet');
    expect(reply.content).toContain('Spike');
    expect(reply.content).toContain('28000003');
    expect(reply.content).toContain('28000016');
    expect(reply.content).toContain('any other icon will not verify');
    expect(reply.content).toContain('checking automatically');
    expect(reply.embeds?.[0]?.toJSON?.().image?.url ?? JSON.stringify(reply.embeds)).toContain('28000016');
  });

  it('confirms successful verification only when the exact required default brawler icon is detected', async () => {
    mocks.verificationService.checkVerification.mockResolvedValue({
      ok: true,
      status: 'verified',
      playerTag: '2C0Y',
      playerName: 'Alpha',
      startingIconId: 28000000,
      targetIconId: 28000016,
      targetIconName: 'Spike',
      targetIconUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000016.png',
      currentIconId: 28000016,
    });
    const interaction = chatInteraction({}, 'check');

    await handleMemberVerify(interaction);

    const reply = payload(interaction, 'editReply');
    expect(reply.content).toContain('**Verified:** Alpha (#2C0Y)');
    expect(reply.content).toContain('Spike');
    expect(reply.content).toContain('28000016');
    expect(reply.content).toContain('official Brawl Stars API');
  });

  it('rate-limits repeated verification checks', async () => {
    mocks.verificationService.checkVerification.mockResolvedValue({
      ok: true,
      status: 'pending',
      playerTag: '2C0Y',
      playerName: 'Alpha',
      startingIconId: 28000000,
      targetIconId: 28000016,
      targetIconName: 'Spike',
      targetIconUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000016.png',
      currentIconId: 28000003,
      expiresAt: 1_732_000_600_000,
    });
    const first = chatInteraction({}, 'check');
    await handleMemberVerify(first);
    expect(mocks.verificationService.checkVerification).toHaveBeenCalledTimes(1);

    const second = chatInteraction({}, 'check');
    await handleMemberVerify(second);
    expect(mocks.verificationService.checkVerification).toHaveBeenCalledTimes(1);
    const reply = (second.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      content?: string;
    };
    expect(reply.content).toContain('Please wait');
  });

  it('reports start failures clearly', async () => {
    mocks.verificationService.startVerification.mockResolvedValue({
      ok: false,
      code: 'api-unavailable',
      message: 'The official Brawl Stars API could not be reached right now. Please try again later.',
    });
    const interaction = chatInteraction({ tag: '2C0Y' }, 'start');

    await handleMemberVerify(interaction);

    expect(payload(interaction, 'editReply').content).toContain('could not be reached');
  });

  it('cancels an active challenge', async () => {
    mocks.verificationService.cancelVerification.mockReturnValue({ ok: true, hadChallenge: true });
    const interaction = chatInteraction({}, 'cancel');

    await handleMemberVerify(interaction);

    expect(payload(interaction, 'editReply').content).toContain('cancelled');
  });
});

describe('/members history command', () => {
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

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.playerService.loadPlayerClubs).toHaveBeenCalledWith({ tag: '#2c0y', guildId: 'guild-1' });
    const text = embedText(payload(interaction, 'editReply'));
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
    expect(invalid.deferReply).toHaveBeenCalledOnce();
    expect(payload(invalid, 'editReply').content).toContain('not valid');

    mocks.playerService.loadPlayerClubs.mockResolvedValue({ kind: 'ok', value: historyView(12) });
    const interaction = buttonInteraction('member-history:page:2:2C0Y');
    await handleMemberHistoryComponent(interaction);
    expect(mocks.playerService.loadPlayerClubs).toHaveBeenCalledWith({ tag: '2C0Y', guildId: 'guild-1' });
    expect(embedText(payload(interaction, 'editReply'))).toContain('Page 2 / 2');
  });

  it('offers stored player autocomplete', async () => {
    mocks.playerService.searchPlayers.mockResolvedValue([
      { id: 'p0', tag: '2C0Y', name: 'Alpha', trophies: 5000, highestTrophies: null, expLevel: null, lastSyncedAt: null },
    ]);
    await handleMemberHistoryAutocomplete(autocompleteInteraction('tag', 'alp'));
    expect(mocks.playerService.searchPlayers).toHaveBeenCalledWith('alp', { guildId: undefined });
  });
});

describe('/members find command', () => {
  it('searches by player name and tag', async () => {
    mocks.memberService.searchTrackedMembersByPlayer.mockResolvedValue({
      kind: 'ok',
      value: searchView(1),
    });
    const byName = chatInteraction({ query: 'alpha' }, 'player');
    await handleMemberSearch(byName);
    expect(byName.deferReply).toHaveBeenCalledOnce();
    expect(mocks.memberService.searchTrackedMembersByPlayer).toHaveBeenCalledWith('alpha', { guildId: 'guild-1' });
    expect(embedText(payload(byName, 'editReply'))).toContain('Alpha');

    const byTag = chatInteraction({ query: '#2c0y' }, 'player');
    await handleMemberSearch(byTag);
    expect(byTag.deferReply).toHaveBeenCalledOnce();
    expect(mocks.memberService.searchTrackedMembersByPlayer).toHaveBeenCalledWith('#2c0y', { guildId: 'guild-1' });
  });

  it('shows empty results and safe validation failures', async () => {
    const empty = chatInteraction({ query: 'nobody' }, 'player');
    mocks.memberService.searchTrackedMembersByPlayer.mockResolvedValueOnce({
      kind: 'ok',
      value: { ...searchView(0), query: 'nobody' },
    });
    await handleMemberSearch(empty);
    expect(empty.deferReply).toHaveBeenCalledOnce();
    expect(embedText(payload(empty, 'editReply'))).toContain('No tracked players matched');

    const invalid = chatInteraction({ query: 'a' }, 'player');
    mocks.memberService.searchTrackedMembersByPlayer.mockResolvedValueOnce({
      kind: 'invalid-input',
      message: 'Enter 2–32 characters.',
    });
    await handleMemberSearch(invalid);
    expect(invalid.deferReply).toHaveBeenCalledOnce();
    expect(payload(invalid, 'editReply').content).toContain('Enter 2–32 characters');

    const unknown = chatInteraction({}, 'unknown');
    await handleMemberSearch(unknown);
    expect(unknown.deferReply).toHaveBeenCalledOnce();
    expect(payload(unknown, 'editReply').content).toContain('Choose either');
  });

  it('allows Discord identity search for staff and enforces permission failures', async () => {
    mocks.memberService.searchTrackedMembersByDiscord.mockResolvedValueOnce({
      kind: 'ok',
      value: searchView(1, 'discord'),
    });
    const staff = chatInteraction({ user: TARGET_DISCORD_ID }, 'discord');
    await handleMemberSearch(staff);
    expect(staff.deferReply).toHaveBeenCalledOnce();
    expect(mocks.adminService.requireGlobalPermission).toHaveBeenCalledWith(
      ACTOR_DISCORD_ID,
      'members:verify',
      expect.objectContaining({ guildId: 'guild-1' }),
    );
    expect(mocks.memberService.searchTrackedMembersByDiscord).toHaveBeenCalledWith(
      TARGET_DISCORD_ID,
      ACTOR_DISCORD_ID,
      { guildId: 'guild-1', allowInspectOthers: true },
    );
    const text = embedText(payload(staff, 'editReply'));
    expect(text).toContain('Linked Discord Players');
    expect(text).toContain(TARGET_DISCORD_ID);
    expect(text).toContain('No ownership is inferred');

    mocks.adminService.requireGlobalPermission.mockRejectedValueOnce(
      new mocks.adminService.AdminServiceError('forbidden', 'You do not have permission.'),
    );
    const member = chatInteraction({ user: TARGET_DISCORD_ID }, 'discord');
    await handleMemberSearch(member);
    expect(member.deferReply).toHaveBeenCalledOnce();
    expect(payload(member, 'editReply').content).toBe('You do not have permission to look up other Discord users’ linked players.');
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
    expect(mocks.memberService.searchTrackedMembersByPlayer).toHaveBeenCalledWith('alpha player', { guildId: 'guild-1' });
    expect(embedText(payload(interaction, 'editReply'))).toContain('Page 2 / 2');
  });

  it('offers player autocomplete only for the query option', async () => {
    mocks.playerService.searchPlayers.mockResolvedValue([
      { id: 'p0', tag: '2C0Y', name: 'Alpha', trophies: 5000, highestTrophies: null, expLevel: null, lastSyncedAt: null },
    ]);
    await handleMemberSearchAutocomplete(autocompleteInteraction('query', 'alp'));
    expect(mocks.playerService.searchPlayers).toHaveBeenCalledWith('alp', { guildId: undefined });

    await handleMemberSearchAutocomplete(autocompleteInteraction('user', '111'));
    expect(mocks.playerService.searchPlayers).toHaveBeenCalledTimes(1);
  });
});
