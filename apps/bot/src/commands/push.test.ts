import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';

const mocks = vi.hoisted(() => {
  class MockPushServiceError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'PushServiceError';
    }
  }

  return {
    PushServiceError: MockPushServiceError,
    config: {
      token: undefined,
      clientId: undefined,
      guildId: 'guild-1',
      callbackUrl: undefined,
      logLevel: undefined,
      emojis: {},
      playerProfileUrlTemplate: 'https://example.test/player/{tag}',
      clubProfileUrlTemplate: undefined,
      seasonStartIso: undefined,
    },
    service: {
      canManagePushCompetition: vi.fn(),
      createPushCompetition: vi.fn(),
      endPushCompetition: vi.fn(),
      joinPushCompetition: vi.fn(),
      listPushCompetitions: vi.fn(),
      listVerifiedPlayers: vi.fn(),
      loadPushCompetition: vi.fn(),
      loadPushLeaderboard: vi.fn(),
      loadPushPlayer: vi.fn(),
      resolvePushActor: vi.fn(),
      submitPushResult: vi.fn(),
    },
    clubs: {
      getRegisteredClubs: vi.fn(),
      filterRegisteredClubs: vi.fn(),
    },
  };
});

vi.mock('../config', () => ({ getBotConfig: () => mocks.config }));
vi.mock('../push/service', () => ({
  ...mocks.service,
  PushServiceError: mocks.PushServiceError,
}));
vi.mock('../clubs/service', () => mocks.clubs);

import {
  handlePush,
  handlePushAutocomplete,
  handlePushComponent,
  pushCommandData,
} from './push';

const COMPETITION_ID = '11111111-1111-4111-8111-111111111111';
const PLAYER_ID = '22222222-2222-4222-8222-222222222222';
const DISCORD_ID = '111111111111111111';

function competition(overrides: Record<string, unknown> = {}) {
  return {
    id: COMPETITION_ID,
    name: 'Midseason Push',
    description: 'No camping',
    clubId: null,
    club: null,
    startsAt: '2026-11-20T00:00:00.000Z',
    endsAt: '2026-11-22T00:00:00.000Z',
    goal: 10_000,
    status: 'scheduled',
    createdBy: null,
    createdAt: '2026-11-18T00:00:00.000Z',
    endedBy: null,
    endedAt: null,
    entryCount: 0,
    ...overrides,
  };
}

function player(name = 'Alpha') {
  return {
    id: PLAYER_ID,
    tag: '2C0Y',
    name,
    trophies: 5_000,
    highestTrophies: 5_200,
    expLevel: 40,
    lastSyncedAt: null,
  };
}

function leaderboardView(count: number) {
  return {
    competition: competition(),
    generatedAt: '2026-11-21T12:00:00.000Z',
    rows: Array.from({ length: count }, (_, index) => ({
      rank: index + 1,
      entry: {
        id: `entry-${index}`,
        competitionId: COMPETITION_ID,
        player: player(`Player ${index + 1}`),
        joinedAt: '2026-11-18T00:00:00.000Z',
        baselineTrophies: 4_000,
        baselineSource: 'player_snapshot' as const,
        baselineCapturedAt: null,
      },
      trophies: 5_000,
      gain: 1_000,
      latestSubmissionAt: '2026-11-21T10:00:00.000Z',
      verificationStatus: 'unverified' as const,
    })),
  };
}

function chatInteraction(
  subcommand: string | null,
  options: Record<string, string | number | null> = {},
) {
  return {
    user: { id: DISCORD_ID },
    guildId: 'guild-1',
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getString: vi.fn((name: string) => options[name] ?? null),
      getInteger: vi.fn((name: string) => options[name] ?? null),
    },
    replied: false,
    deferred: false,
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function buttonInteraction(customId: string) {
  const interaction = {
    customId,
    replied: false,
    deferred: false,
    deferUpdate: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  return interaction as unknown as ButtonInteraction;
}

function autocompleteInteraction(subcommand: string, name: string, value: string) {
  return {
    user: { id: DISCORD_ID },
    guildId: 'guild-1',
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getFocused: vi.fn(() => ({ name, value })),
    },
    respond: vi.fn(async () => undefined),
  } as unknown as AutocompleteInteraction;
}

function payload(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  method: 'reply' | 'editReply' | 'followUp',
): any {
  return (interaction[method] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as any;
}

function embedText(embed: any): string {
  const json = embed.toJSON();
  return [
    json.title ?? '',
    json.description ?? '',
    json.footer?.text ?? '',
    ...(json.fields ?? []).map((field: any) => `${field.name} ${field.value}`),
  ].join('\n');
}

beforeEach(() => {
  for (const fn of Object.values(mocks.service)) fn.mockReset();
  mocks.clubs.getRegisteredClubs.mockReset();
  mocks.clubs.filterRegisteredClubs.mockReset();
  mocks.service.loadPushCompetition.mockResolvedValue(competition());
  mocks.service.loadPushPlayer.mockResolvedValue(player());
});

describe('/push command registration', () => {
  it('registers all six subcommands with required options', () => {
    const json = pushCommandData.toJSON() as any;
    expect(json.name).toBe('push');
    expect(json.options?.map((option: any) => option.name)).toEqual([
      'create', 'join', 'submit', 'leaderboard', 'end', 'list',
    ]);

    const create = json.options.find((option: any) => option.name === 'create');
    expect(create.options.map((option: any) => option.name)).toEqual([
      'name', 'description', 'start', 'end', 'club', 'goal',
    ]);
    const submit = json.options.find((option: any) => option.name === 'submit');
    expect(submit.options.find((option: any) => option.name === 'trophies').min_value).toBe(0);
  });
});

describe('/push command handlers', () => {
  it('creates and displays a competition for authorised staff', async () => {
    mocks.service.createPushCompetition.mockResolvedValue(competition());
    const interaction = chatInteraction('create', {
      name: 'Midseason Push',
      description: 'No camping',
      start: '2026-11-20T00:00Z',
      end: '2026-11-22T00:00Z',
      goal: 10_000,
    });

    await handlePush(interaction);

    expect(mocks.service.createPushCompetition).toHaveBeenCalledWith(
      expect.objectContaining({ discordUserId: DISCORD_ID, name: 'Midseason Push' }),
    );
    expect(embedText(payload(interaction, 'reply').embeds[0])).toContain('No camping');
  });

  it('replies ephemerally when staff permission is missing', async () => {
    mocks.service.createPushCompetition.mockRejectedValue(
      new mocks.PushServiceError('forbidden', 'You do not have permission to manage push competitions.'),
    );
    const interaction = chatInteraction('create', {
      name: 'Nope',
      start: '2026-11-20T00:00Z',
      end: '2026-11-22T00:00Z',
    });

    await handlePush(interaction);

    expect(payload(interaction, 'reply')).toMatchObject({ ephemeral: true });
    expect(payload(interaction, 'reply').content).toContain('permission');
  });

  it('keeps join and submit tied to the interacting user', async () => {
    mocks.service.joinPushCompetition.mockResolvedValue({
      entryId: 'entry-1',
      baselineTrophies: 4_000,
      baselineSource: 'player_snapshot',
      baselineCapturedAt: null,
    });
    const join = chatInteraction('join', { competition: COMPETITION_ID, account: PLAYER_ID });
    await handlePush(join);

    expect(mocks.service.joinPushCompetition).toHaveBeenCalledWith({
      discordUserId: DISCORD_ID,
      competitionId: COMPETITION_ID,
      playerId: PLAYER_ID,
    });

    mocks.service.submitPushResult.mockResolvedValue({
      submissionId: 'submission-1',
      submittedAt: '2026-11-21T10:00:00.000Z',
      trophies: 5_000,
      verificationStatus: 'unverified',
    });
    const submit = chatInteraction('submit', {
      competition: COMPETITION_ID,
      account: PLAYER_ID,
      trophies: 5_000,
    });
    await handlePush(submit);

    expect(mocks.service.submitPushResult).toHaveBeenCalledWith({
      discordUserId: DISCORD_ID,
      competitionId: COMPETITION_ID,
      playerId: PLAYER_ID,
      trophies: 5_000,
    });
    expect(embedText(payload(submit, 'reply').embeds[0])).toContain('Unverified user submission');
  });

  it('ends a competition and shows who ended it', async () => {
    mocks.service.endPushCompetition.mockResolvedValue(
      competition({ status: 'ended', endedAt: '2026-11-21T12:00:00.000Z', endedBy: 'profile-1' }),
    );
    const interaction = chatInteraction('end', { competition: COMPETITION_ID });

    await handlePush(interaction);

    expect(mocks.service.endPushCompetition).toHaveBeenCalledWith({
      discordUserId: DISCORD_ID,
      competitionId: COMPETITION_ID,
    });
    expect(embedText(payload(interaction, 'reply').embeds[0])).toContain(`<@${DISCORD_ID}>`);
  });

  it('paginates leaderboards and preserves the competition state', async () => {
    mocks.service.loadPushLeaderboard.mockResolvedValue(leaderboardView(12));
    const initial = chatInteraction('leaderboard', { competition: COMPETITION_ID });
    await handlePush(initial);

    const first = payload(initial, 'reply');
    expect(embedText(first.embeds[0])).toContain('Player 1');
    expect(first.components[0].components[0].data.custom_id).toContain(
      `leaderboard|${COMPETITION_ID}`,
    );

    const button = buttonInteraction(`push:page:2:leaderboard|${COMPETITION_ID}`);
    await handlePushComponent(button);

    expect(mocks.service.loadPushLeaderboard).toHaveBeenCalledTimes(2);
    expect(embedText(payload(button, 'editReply').embeds[0])).toContain('Player 11');
  });

  it('lists competitions and handles an empty list', async () => {
    mocks.service.listPushCompetitions.mockResolvedValue([
      competition(),
      competition({ id: 'another-id', name: 'Season Climb' }),
    ]);
    const list = chatInteraction('list');
    await handlePush(list);
    expect(embedText(payload(list, 'reply').embeds[0])).toContain('Midseason Push');

    mocks.service.listPushCompetitions.mockResolvedValue([]);
    const empty = chatInteraction('list');
    await handlePush(empty);
    expect(embedText(payload(empty, 'reply').embeds[0])).toContain(
      'No push competitions have been created yet.',
    );
  });

  it('routes autocomplete for clubs, competitions and verified accounts', async () => {
    mocks.clubs.getRegisteredClubs.mockResolvedValue([
      { id: 'club-1', tag: '2C0Y', name: 'Alpha', description: null, trophies: null, requiredTrophies: null, memberCount: null, lastSyncedAt: null },
    ]);
    mocks.clubs.filterRegisteredClubs.mockReturnValue([
      { id: 'club-1', tag: '2C0Y', name: 'Alpha', description: null, trophies: null, requiredTrophies: null, memberCount: null, lastSyncedAt: null },
    ]);
    mocks.service.listPushCompetitions.mockResolvedValue([competition()]);
    mocks.service.resolvePushActor.mockResolvedValue({
      profileId: 'profile-1',
      discordUserId: DISCORD_ID,
      globalRole: 'staff',
      clubRoles: new Map(),
    });
    mocks.service.canManagePushCompetition.mockReturnValue(true);
    mocks.service.listVerifiedPlayers.mockResolvedValue([
      { id: PLAYER_ID, tag: '2C0Y', name: 'Alpha', verifiedAt: '2026-11-17T00:00:00.000Z', method: 'manual_staff' },
    ]);

    const club = autocompleteInteraction('create', 'club', '2C0Y');
    await handlePushAutocomplete(club);
    expect((club.respond as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual([
      { name: 'Alpha (#2C0Y)', value: 'club-1' },
    ]);

    const competitions = autocompleteInteraction('end', 'competition', 'mid');
    await handlePushAutocomplete(competitions);
    expect((competitions.respond as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual([
      { name: 'Midseason Push', value: COMPETITION_ID },
    ]);
    expect(mocks.service.canManagePushCompetition).toHaveBeenCalled();

    const accounts = autocompleteInteraction('join', 'account', 'alpha');
    await handlePushAutocomplete(accounts);
    expect((accounts.respond as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual([
      { name: 'Alpha (#2C0Y)', value: PLAYER_ID },
    ]);
  });
});
