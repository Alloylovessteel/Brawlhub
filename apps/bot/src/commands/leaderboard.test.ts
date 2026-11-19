import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';

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
  service: {
    loadClubLeaderboard: vi.fn(),
    loadPlayerLeaderboard: vi.fn(),
    loadTrophyLeaderboard: vi.fn(),
    loadProgressionLeaderboard: vi.fn(),
  },
}));

vi.mock('../config', () => ({ getBotConfig: () => mocks.config }));
vi.mock('../leaderboard/service', () => mocks.service);

import { SAFE_USER_ERROR } from '../discord/errors';
import type { ProgressionPeriod } from '../leaderboard/types';
import {
  handleLeaderboard,
  handleLeaderboardComponent,
  leaderboardCommandData,
} from './leaderboard';

function chatInteraction(
  subcommand: string | null,
  options: Record<string, string | null> = {},
) {
  return {
    guildId: 'guild-1',
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getString: vi.fn((name: string) => options[name] ?? null),
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
    guildId: 'guild-1',
    deferred: false,
    replied: false,
    deferUpdate: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  return interaction as unknown as ButtonInteraction;
}

function payload(interaction: ChatInputCommandInteraction | ButtonInteraction, method: 'reply' | 'editReply'): any {
  return (interaction[method] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as any;
}

const GENERATED_AT = '2026-11-18T12:00:00.000Z';
const LATEST_SYNC_AT = '2026-11-17T00:01:00.000Z';

const CLUB = {
  id: 'club-1', tag: '2C0Y', name: 'Alpha', description: null,
  trophies: 1_200_000, requiredTrophies: null, memberCount: 30, lastSyncedAt: null,
};

function identity(index: number) {
  return {
    id: `p${index}`,
    tag: '2C0Y',
    name: `Player ${index + 1}`,
    trophies: 5_000,
    highestTrophies: 5_200,
    expLevel: 35,
    lastSyncedAt: '2026-11-18T11:55:00.000Z',
  };
}

const PLAYER_CLUB = {
  id: 'club-1', tag: '2C0Y', name: 'Alpha Club', role: 'member',
  validFrom: '2026-11-01T00:00:00.000Z', validTo: null,
};

function meta() {
  return { generatedAt: GENERATED_AT, latestSyncAt: LATEST_SYNC_AT, warning: null };
}

function clubView(count: number) {
  return {
    ...meta(),
    rows: Array.from({ length: count }, (_, index) => ({
      rank: index + 1,
      club: CLUB,
      totalTrophies: 1_200_000,
      memberCount: 30,
      averageTrophies: 40_000,
      snapshotAt: '2026-11-17T00:00:00.000Z',
      syncRunId: 'run-3',
    })),
  };
}

function playerView(count: number) {
  return {
    ...meta(),
    rows: Array.from({ length: count }, (_, index) => ({
      rank: index + 1,
      player: identity(index),
      trophies: 5_000,
      club: PLAYER_CLUB,
      clubStatus: 'current' as const,
    })),
  };
}

function trophyView(count: number) {
  return {
    ...meta(),
    rows: Array.from({ length: count }, (_, index) => ({
      rank: index + 1,
      player: identity(index),
      highestTrophies: 5_200,
      currentTrophies: 5_000,
      club: PLAYER_CLUB,
      clubStatus: 'current' as const,
    })),
  };
}

function progressionView(count: number, period: ProgressionPeriod = '30d') {
  return {
    ...meta(),
    period,
    rows: Array.from({ length: count }, (_, index) => ({
      rank: index + 1,
      player: identity(index),
      startTrophies: 4_300,
      latestTrophies: 5_000,
      difference: 700,
      startAt: '2026-11-12T00:00:00.000Z',
      latestAt: '2026-11-17T00:00:00.000Z',
      syncRunId: 'run-3',
      club: PLAYER_CLUB,
      clubStatus: 'current' as const,
    })),
  };
}

beforeEach(() => {
  for (const loader of Object.values(mocks.service)) loader.mockReset();
});

describe('/leaderboard command', () => {
  it('registers four subcommands and progression period choices', () => {
    const json = leaderboardCommandData.toJSON() as any;
    const progression = json.options?.find((option: any) => option.name === 'progression');

    expect(json.name).toBe('leaderboard');
    expect(json.options?.map((option: any) => option.name)).toEqual([
      'clubs', 'players', 'trophies', 'progression',
    ]);
    expect(progression?.options?.[0]?.choices?.map((choice: any) => choice.value)).toEqual([
      '7d', '30d', '90d',
    ]);
  });

  it('routes each subcommand to its read-only loader', async () => {
    mocks.service.loadClubLeaderboard.mockResolvedValue(clubView(0));
    mocks.service.loadPlayerLeaderboard.mockResolvedValue(playerView(0));
    mocks.service.loadTrophyLeaderboard.mockResolvedValue(trophyView(0));
    mocks.service.loadProgressionLeaderboard.mockResolvedValue(progressionView(0));

    await handleLeaderboard(chatInteraction('clubs'));
    await handleLeaderboard(chatInteraction('players'));
    await handleLeaderboard(chatInteraction('trophies'));
    await handleLeaderboard(chatInteraction('progression'));

    expect(mocks.service.loadClubLeaderboard).toHaveBeenCalledWith({ guildId: 'guild-1' });
    expect(mocks.service.loadPlayerLeaderboard).toHaveBeenCalledWith({ guildId: 'guild-1' });
    expect(mocks.service.loadTrophyLeaderboard).toHaveBeenCalledWith({ guildId: 'guild-1' });
    expect(mocks.service.loadProgressionLeaderboard).toHaveBeenCalledWith({ period: '30d' }, { guildId: 'guild-1' });
  });

  it('uses the selected progression period and defaults to 30 days', async () => {
    mocks.service.loadProgressionLeaderboard.mockResolvedValue(progressionView(0, '7d'));

    await handleLeaderboard(chatInteraction('progression', { period: '7d' }));
    await handleLeaderboard(chatInteraction('progression', { period: 'invalid' }));

    expect(mocks.service.loadProgressionLeaderboard).toHaveBeenNthCalledWith(1, { period: '7d' }, { guildId: 'guild-1' });
    expect(mocks.service.loadProgressionLeaderboard).toHaveBeenNthCalledWith(2, { period: '30d' }, { guildId: 'guild-1' });
  });

  it('paginates ten rows at a time and preserves the leaderboard state', async () => {
    mocks.service.loadClubLeaderboard.mockResolvedValue(clubView(12));
    const clubs = chatInteraction('clubs');
    await handleLeaderboard(clubs);

    expect(payload(clubs, 'reply').embeds[0].toJSON().fields).toHaveLength(10);
    expect(payload(clubs, 'reply').components[0].toJSON().components[0].custom_id).toBe(
      'leaderboard:page:2:clubs',
    );

    mocks.service.loadProgressionLeaderboard.mockResolvedValue(progressionView(12, '7d'));
    const progression = chatInteraction('progression', { period: '7d' });
    await handleLeaderboard(progression);

    expect(payload(progression, 'reply').components[0].toJSON().components[0].custom_id).toBe(
      'leaderboard:page:2:progression|7d',
    );
  });

  it('restores progression state from pagination buttons and ignores invalid buttons', async () => {
    mocks.service.loadProgressionLeaderboard.mockResolvedValue(progressionView(12, '7d'));
    const button = buttonInteraction('leaderboard:page:2:progression|7d');

    await handleLeaderboardComponent(button);

    expect(button.deferUpdate).toHaveBeenCalledOnce();
    expect(mocks.service.loadProgressionLeaderboard).toHaveBeenCalledWith({ period: '7d' }, { guildId: 'guild-1' });
    expect(payload(button, 'editReply').embeds[0].toJSON().footer?.text).toContain('Page 2 / 2');
    expect(payload(button, 'editReply').content).toBeNull();

    await handleLeaderboardComponent(buttonInteraction('leaderboard:page:2:bad'));
    await handleLeaderboardComponent(buttonInteraction('clubs:page:2:7d|2C0Y'));
    expect(mocks.service.loadProgressionLeaderboard).toHaveBeenCalledOnce();
  });

  it('renders graceful empty states without pagination controls', async () => {
    mocks.service.loadPlayerLeaderboard.mockResolvedValue(playerView(0));
    const players = chatInteraction('players');
    await handleLeaderboard(players);
    expect(JSON.stringify(payload(players, 'reply').embeds[0].toJSON())).toContain('No ranked players');
    expect(payload(players, 'reply').components).toEqual([]);

    mocks.service.loadProgressionLeaderboard.mockResolvedValue(progressionView(0));
    const progression = chatInteraction('progression');
    await handleLeaderboard(progression);
    expect(JSON.stringify(payload(progression, 'reply').embeds[0].toJSON())).toContain(
      'Insufficient progression history',
    );
  });

  it('replies with a safe error when loading or paging fails', async () => {
    mocks.service.loadTrophyLeaderboard.mockRejectedValue(new Error('database unavailable'));
    const initial = chatInteraction('trophies');
    await handleLeaderboard(initial);
    expect(payload(initial, 'reply')).toEqual(
      expect.objectContaining({ content: SAFE_USER_ERROR, ephemeral: true }),
    );

    mocks.service.loadClubLeaderboard.mockRejectedValue(new Error('database unavailable'));
    const button = buttonInteraction('leaderboard:page:2:clubs');
    await handleLeaderboardComponent(button);
    expect((button.followUp as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ content: SAFE_USER_ERROR, ephemeral: true }),
    );
  });
});
