import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';

const mocks = vi.hoisted(() => {
  class MockCompetitionServiceError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'CompetitionServiceError';
    }
  }

  return {
    CompetitionServiceError: MockCompetitionServiceError,
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
      canManageCompetition: vi.fn(),
      createCompetition: vi.fn(),
      endCompetition: vi.fn(),
      joinCompetition: vi.fn(),
      listCompetitions: vi.fn(),
      listVerifiedPlayers: vi.fn(),
      loadCompetitionRecord: vi.fn(),
      loadCompetitionLeaderboard: vi.fn(),
      loadCompetitionPlayer: vi.fn(),
      resolveCompetitionActor: vi.fn(),
      submitCompetitionResult: vi.fn(),
    },
    clubs: {
      getRegisteredClubs: vi.fn(),
      filterRegisteredClubs: vi.fn(),
    },
  };
});

vi.mock('../config', () => ({ getBotConfig: () => mocks.config }));
vi.mock('../competition/service', () => ({
  ...mocks.service,
  CompetitionServiceError: mocks.CompetitionServiceError,
}));
vi.mock('../clubs/service', () => mocks.clubs);

import {
  handleCompetition,
  handleCompetitionAutocomplete,
  handleCompetitionComponent,
  competitionCommandData,
} from './competition';

const COMPETITION_ID = '11111111-1111-4111-8111-111111111111';
const PLAYER_ID = '22222222-2222-4222-8222-222222222222';
const DISCORD_ID = '111111111111111111';

function competition(overrides: Record<string, unknown> = {}) {
  return {
    id: COMPETITION_ID,
    name: 'Midseason Climb',
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
  mocks.service.loadCompetitionRecord.mockResolvedValue(competition());
  mocks.service.loadCompetitionPlayer.mockResolvedValue(player());
});

describe('/competition command registration', () => {
  it('registers all six subcommands with required options', () => {
    const json = competitionCommandData.toJSON() as any;
    expect(json.name).toBe('competition');
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

describe('/competition command handlers', () => {
  it('creates and displays a competition for authorised staff', async () => {
    mocks.service.createCompetition.mockResolvedValue(competition());
    const interaction = chatInteraction('create', {
      name: 'Midseason Climb',
      description: 'No camping',
      start: '2026-11-20T00:00Z',
      end: '2026-11-22T00:00Z',
      goal: 10_000,
    });

    await handleCompetition(interaction);

    expect(mocks.service.createCompetition).toHaveBeenCalledWith(
      expect.objectContaining({ discordUserId: DISCORD_ID, name: 'Midseason Climb' }),
    );
    expect(embedText(payload(interaction, 'reply').embeds[0])).toContain('No camping');
  });

  it('replies ephemerally when staff permission is missing', async () => {
    mocks.service.createCompetition.mockRejectedValue(
      new mocks.CompetitionServiceError('forbidden', 'You do not have permission to manage competitions.'),
    );
    const interaction = chatInteraction('create', {
      name: 'Nope',
      start: '2026-11-20T00:00Z',
      end: '2026-11-22T00:00Z',
    });

    await handleCompetition(interaction);

    expect(payload(interaction, 'reply')).toMatchObject({ ephemeral: true });
    expect(payload(interaction, 'reply').content).toContain('permission');
  });

  it('keeps join and submit tied to the interacting user', async () => {
    mocks.service.joinCompetition.mockResolvedValue({
      entryId: 'entry-1',
      baselineTrophies: 4_000,
      baselineSource: 'player_snapshot',
      baselineCapturedAt: null,
    });
    const join = chatInteraction('join', { competition: COMPETITION_ID, account: PLAYER_ID });
    await handleCompetition(join);

    expect(mocks.service.joinCompetition).toHaveBeenCalledWith({
      discordUserId: DISCORD_ID,
      competitionId: COMPETITION_ID,
      playerId: PLAYER_ID,
    });

    mocks.service.submitCompetitionResult.mockResolvedValue({
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
    await handleCompetition(submit);

    expect(mocks.service.submitCompetitionResult).toHaveBeenCalledWith({
      discordUserId: DISCORD_ID,
      competitionId: COMPETITION_ID,
      playerId: PLAYER_ID,
      trophies: 5_000,
    });
    expect(embedText(payload(submit, 'reply').embeds[0])).toContain('Unverified user submission');
  });

  it('ends a competition and shows who ended it', async () => {
    mocks.service.endCompetition.mockResolvedValue(
      competition({ status: 'ended', endedAt: '2026-11-21T12:00:00.000Z', endedBy: 'profile-1' }),
    );
    const interaction = chatInteraction('end', { competition: COMPETITION_ID });

    await handleCompetition(interaction);

    expect(mocks.service.endCompetition).toHaveBeenCalledWith({
      discordUserId: DISCORD_ID,
      competitionId: COMPETITION_ID,
    });
    expect(embedText(payload(interaction, 'reply').embeds[0])).toContain(`<@${DISCORD_ID}>`);
  });

  it('paginates leaderboards and preserves the competition state', async () => {
    mocks.service.loadCompetitionLeaderboard.mockResolvedValue(leaderboardView(12));
    const initial = chatInteraction('leaderboard', { competition: COMPETITION_ID });
    await handleCompetition(initial);

    const first = payload(initial, 'reply');
    expect(embedText(first.embeds[0])).toContain('Player 1');
    expect(first.components[0].components[0].data.custom_id).toContain(
      `leaderboard|${COMPETITION_ID}`,
    );

    const button = buttonInteraction(`competition:page:2:leaderboard|${COMPETITION_ID}`);
    await handleCompetitionComponent(button);

    expect(mocks.service.loadCompetitionLeaderboard).toHaveBeenCalledTimes(2);
    expect(embedText(payload(button, 'editReply').embeds[0])).toContain('Player 11');
  });

  it('lists competitions and handles an empty list', async () => {
    mocks.service.listCompetitions.mockResolvedValue([
      competition(),
      competition({ id: 'another-id', name: 'Season Climb' }),
    ]);
    const list = chatInteraction('list');
    await handleCompetition(list);
    expect(embedText(payload(list, 'reply').embeds[0])).toContain('Midseason Climb');

    mocks.service.listCompetitions.mockResolvedValue([]);
    const empty = chatInteraction('list');
    await handleCompetition(empty);
    expect(embedText(payload(empty, 'reply').embeds[0])).toContain(
      'No competitions have been created yet.',
    );
  });

  it('routes autocomplete for clubs, competitions and verified accounts', async () => {
    mocks.clubs.getRegisteredClubs.mockResolvedValue([
      { id: 'club-1', tag: '2C0Y', name: 'Alpha', description: null, trophies: null, requiredTrophies: null, memberCount: null, lastSyncedAt: null },
    ]);
    mocks.clubs.filterRegisteredClubs.mockReturnValue([
      { id: 'club-1', tag: '2C0Y', name: 'Alpha', description: null, trophies: null, requiredTrophies: null, memberCount: null, lastSyncedAt: null },
    ]);
    mocks.service.listCompetitions.mockResolvedValue([competition()]);
    mocks.service.resolveCompetitionActor.mockResolvedValue({
      profileId: 'profile-1',
      discordUserId: DISCORD_ID,
      globalRole: 'staff',
      clubRoles: new Map(),
    });
    mocks.service.canManageCompetition.mockReturnValue(true);
    mocks.service.listVerifiedPlayers.mockResolvedValue([
      { id: PLAYER_ID, tag: '2C0Y', name: 'Alpha', verifiedAt: '2026-11-17T00:00:00.000Z', method: 'manual_staff' },
    ]);

    const club = autocompleteInteraction('create', 'club', '2C0Y');
    await handleCompetitionAutocomplete(club);
    expect((club.respond as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual([
      { name: 'Alpha (#2C0Y)', value: 'club-1' },
    ]);

    const competitions = autocompleteInteraction('end', 'competition', 'mid');
    await handleCompetitionAutocomplete(competitions);
    expect((competitions.respond as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual([
      { name: 'Midseason Climb', value: COMPETITION_ID },
    ]);
    expect(mocks.service.canManageCompetition).toHaveBeenCalled();

    const accounts = autocompleteInteraction('join', 'account', 'alpha');
    await handleCompetitionAutocomplete(accounts);
    expect((accounts.respond as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual([
      { name: 'Alpha (#2C0Y)', value: PLAYER_ID },
    ]);
  });
});
