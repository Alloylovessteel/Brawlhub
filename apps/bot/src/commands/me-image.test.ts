import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import { SAFE_USER_ERROR } from '../discord/errors';

const mocks = vi.hoisted(() => ({
  service: {
    loadPlayerProfile: vi.fn(),
    loadPlayerHistory: vi.fn(),
    searchPlayers: vi.fn(),
  },
  verification: {
    findVerifiedPlayerForDiscordUser: vi.fn(),
    listLinkedAccounts: vi.fn(),
  },
  assets: {
    resolvePlayerIconUrl: vi.fn(async (_iconId: number | null): Promise<string | null> => null),
    resolveBrawlerPortraitUrl: vi.fn(async (_name: string | null): Promise<string | null> => null),
  },
  card: {
    buildPlayerCardImage: vi.fn(async (): Promise<Buffer> => Buffer.from('fake-png')),
    selectTopBrawlers: vi.fn(),
  },
}));

vi.mock('../players/service', () => mocks.service);
vi.mock('../config.js', () => ({
  getBotConfig: vi.fn(() => ({
    seasonStartIso: '2026-11-05T08:00:00.000Z',
    seasonEndIso: '2026-12-03T08:00:00.000Z',
  })),
}));
vi.mock('../verification/index', () => mocks.verification);
vi.mock('../metadata/assets.js', () => mocks.assets);
vi.mock('../players/card.js', () => mocks.card);

import { handleMeImage } from './me-image';

function chatInteraction(
  options: Record<string, string | null> = {},
  guildId: string | null = 'guild-1',
) {
  const interaction = {
    guildId,
    user: { id: '983248496884875286' },
    options: {
      getSubcommand: vi.fn(() => 'image'),
      getString: vi.fn((name: string) => options[name] ?? null),
    },
    replied: false,
    deferred: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  return interaction as unknown as ChatInputCommandInteraction & {
    editReply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    deferReply: ReturnType<typeof vi.fn>;
  };
}

function profileResult() {
  return {
    kind: 'ok' as const,
    value: {
      player: {
        id: 'p1',
        tag: '2C0Y',
        name: 'Alpha',
        trophies: 5000,
        highestTrophies: 5200,
        expLevel: 35,
        iconId: 28000003,
        threeVsThreeVictories: 20,
        soloVictories: 5,
        duoVictories: 3,
      },
      currentClub: { tag: '8QCL', name: 'Alpha Club', role: 'president' },
      brawlers: [
        { name: 'Shelly', trophies: 900 },
        { name: 'Nita', trophies: 800 },
        { name: 'Colt', trophies: 700 },
        { name: 'Jessie', trophies: 600 },
      ],
      stats: { brawlerCount: 42 },
      source: 'live' as const,
      apiIssue: null,
      profileFetchedAt: '2026-11-21T08:00:00.000Z',
      latestSnapshotAt: '2026-11-20T08:00:00.000Z',
    },
  };
}

function payload(interaction: { editReply: ReturnType<typeof vi.fn> }): any {
  return interaction.editReply.mock.calls[0]?.[0] as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.service.loadPlayerProfile.mockResolvedValue(profileResult());
  mocks.service.loadPlayerHistory.mockResolvedValue({ kind: 'not-found', tag: '2C0Y' });
  mocks.verification.findVerifiedPlayerForDiscordUser.mockResolvedValue(null);
  mocks.verification.listLinkedAccounts.mockResolvedValue(null);
  mocks.assets.resolvePlayerIconUrl.mockResolvedValue(null);
  mocks.assets.resolveBrawlerPortraitUrl.mockResolvedValue(null);
  mocks.card.buildPlayerCardImage.mockResolvedValue(Buffer.from('fake-png'));
  mocks.card.selectTopBrawlers.mockImplementation((profile: any) => profile.brawlers.slice(0, 3));
});

describe('/me image', () => {
  it('posts a public attachment built from official data and static asset URLs', async () => {
    mocks.verification.listLinkedAccounts.mockResolvedValue([
      { tag: '2C0Y', name: 'Alpha', isMain: true },
      { tag: 'OTHER', name: 'Other', isMain: false },
    ]);
    mocks.assets.resolvePlayerIconUrl.mockResolvedValue('https://cdn.example.test/icon.png');
    mocks.assets.resolveBrawlerPortraitUrl
      .mockResolvedValueOnce('https://cdn.example.test/shelly.png')
      .mockResolvedValueOnce('https://cdn.example.test/nita.png')
      .mockResolvedValueOnce('https://cdn.example.test/colt.png');
    const interaction = chatInteraction({ tag: '#2c0y' });

    await handleMeImage(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.service.loadPlayerProfile).toHaveBeenCalledWith({
      tag: '#2c0y',
      guildId: 'guild-1',
    });
    expect(mocks.assets.resolvePlayerIconUrl).toHaveBeenCalledWith(28000003);
    expect(mocks.assets.resolveBrawlerPortraitUrl.mock.calls.map((call) => call[0])).toEqual([
      'Shelly',
      'Nita',
      'Colt',
    ]);
    expect(mocks.card.buildPlayerCardImage).toHaveBeenCalledWith(
      profileResult().value,
      expect.objectContaining({
        playerIconUrl: 'https://cdn.example.test/icon.png',
        brawlerPortraitUrls: [
          'https://cdn.example.test/shelly.png',
          'https://cdn.example.test/nita.png',
          'https://cdn.example.test/colt.png',
        ],
        badges: ['VERIFIED', 'MAIN'],
      }),
      { mode: 'profile' },
    );

    const reply = payload(interaction);
    expect(reply.flags).toBeUndefined();
    expect(reply.components).toEqual([]);
    expect(reply.files).toHaveLength(1);
    expect(reply.files[0].name).toBe('brawlhub-2C0Y.png');
    expect(reply.content).toContain('Alpha');
  });

  it('uses the verified player and labels linked alts', async () => {
    mocks.verification.findVerifiedPlayerForDiscordUser.mockResolvedValue({ tag: '2C0Y' });
    mocks.verification.listLinkedAccounts.mockResolvedValue([
      { tag: '2C0Y', name: 'Alpha', isMain: false },
    ]);
    const interaction = chatInteraction();

    await handleMeImage(interaction);

    expect(mocks.verification.findVerifiedPlayerForDiscordUser).toHaveBeenCalledWith(
      '983248496884875286',
    );
    expect(mocks.service.loadPlayerProfile).toHaveBeenCalledWith({
      tag: '2C0Y',
      guildId: 'guild-1',
    });
    expect(mocks.card.buildPlayerCardImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ badges: ['VERIFIED', 'ALT'] }),
      { mode: 'profile' },
    );
  });

  it('never attaches components in DMs', async () => {
    mocks.verification.findVerifiedPlayerForDiscordUser.mockResolvedValue({ tag: '2C0Y' });
    const interaction = chatInteraction({}, null);

    await handleMeImage(interaction);

    expect(payload(interaction).components).toEqual([]);
    expect(payload(interaction).files).toHaveLength(1);
  });

  it('does not build a card when the player lookup fails', async () => {
    mocks.service.loadPlayerProfile.mockResolvedValue({ kind: 'not-found', tag: 'QQQ' });
    const interaction = chatInteraction({ tag: 'QQQ' });

    await handleMeImage(interaction);

    expect(mocks.card.buildPlayerCardImage).not.toHaveBeenCalled();
    expect(payload(interaction).content).toContain('was not found');
    expect(payload(interaction).files).toBeUndefined();
  });

  it('returns a safe error if image rendering fails', async () => {
    mocks.card.buildPlayerCardImage.mockRejectedValueOnce(new Error('DATABASE_PASSWORD=secret'));
    const interaction = chatInteraction({ tag: '#2c0y' });

    await handleMeImage(interaction);

    expect(interaction.followUp).toHaveBeenCalledWith({
      content: SAFE_USER_ERROR,
      flags: 64,
    });
  });

  it('renders the brawler-trophies preset with all static portraits', async () => {
    mocks.assets.resolveBrawlerPortraitUrl.mockImplementation(
      async (name: string | null) => `https://cdn.example.test/${name}.png`,
    );
    const interaction = chatInteraction({ tag: '#2c0y', mode: 'trophies' });

    await handleMeImage(interaction);

    expect(mocks.card.buildPlayerCardImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        allBrawlerPortraitUrls: {
          Shelly: 'https://cdn.example.test/Shelly.png',
          Nita: 'https://cdn.example.test/Nita.png',
          Colt: 'https://cdn.example.test/Colt.png',
          Jessie: 'https://cdn.example.test/Jessie.png',
        },
      }),
      { mode: 'trophies' },
    );
    expect(payload(interaction).files[0].name).toBe('brawlhub-2C0Y-trophies.png');
  });

  it('passes the configured season window to the season preset', async () => {
    const interaction = chatInteraction({ tag: '#2c0y', mode: 'season' });

    await handleMeImage(interaction);

    expect(mocks.card.buildPlayerCardImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        mode: 'season',
        seasonWindow: {
          start: '2026-11-05T08:00:00.000Z',
          end: '2026-12-03T08:00:00.000Z',
        },
      },
    );
  });

  it('loads stored snapshots for the history preset', async () => {
    mocks.service.loadPlayerHistory.mockResolvedValue({
      kind: 'ok',
      value: {
        points: [
          { capturedAt: '2026-11-01T00:00:00.000Z', trophies: 4800 },
          { capturedAt: '2026-11-20T00:00:00.000Z', trophies: 5000 },
        ],
        events: [{ eventType: 'join' }, { eventType: 'leave' }],
      },
    });
    const interaction = chatInteraction({ tag: '#2c0y', mode: 'history' });

    await handleMeImage(interaction);

    expect(mocks.service.loadPlayerHistory).toHaveBeenCalledWith({
      tag: '#2c0y',
      guildId: 'guild-1',
      period: '30d',
    });
    expect(mocks.card.buildPlayerCardImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        mode: 'history',
        history: {
          points: 2,
          firstAt: '2026-11-01T00:00:00.000Z',
          latestAt: '2026-11-20T00:00:00.000Z',
          firstTrophies: 4800,
          latestTrophies: 5000,
          clubChanges: 2,
          nameChanges: null,
        },
      },
    );
  });

  it('falls back to the profile preset for an unknown mode', async () => {
    const interaction = chatInteraction({ tag: '#2c0y', mode: 'mastery' });

    await handleMeImage(interaction);

    expect(mocks.card.buildPlayerCardImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { mode: 'profile' },
    );
    expect(payload(interaction).files[0].name).toBe('brawlhub-2C0Y.png');
  });
});
