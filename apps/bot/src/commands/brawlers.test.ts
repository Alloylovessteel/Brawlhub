import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';
import type { PlayerBrawlersView } from '../players/types.js';

const GUILD_ID = '1488531664962326571';
const USER_ID = '983248496884875286';

const mocks = vi.hoisted(() => ({
  loadPlayerBrawlers: vi.fn(),
  findVerifiedPlayerForDiscordUser: vi.fn(),
  resolveBrawlerPortraitUrl: vi.fn(async () => null),
}));

vi.mock('../players/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../players/service.js')>();
  return { ...actual, loadPlayerBrawlers: mocks.loadPlayerBrawlers };
});
vi.mock('../verification/index.js', () => ({
  findVerifiedPlayerForDiscordUser: mocks.findVerifiedPlayerForDiscordUser,
}));
vi.mock('../metadata/assets.js', () => ({
  resolveBrawlerPortraitUrl: mocks.resolveBrawlerPortraitUrl,
}));
vi.mock('../config', () => ({ getBotConfig: () => ({}) }));

import {
  brawlerCommandData,
  brawlersCommandData,
  handleBrawler,
  handleBrawlers,
  handleBrawlersComponent,
} from './brawlers.js';

const view: PlayerBrawlersView = {
  player: {
    id: 'p1',
    tag: '2C0Y',
    name: 'Alpha',
    iconId: null,
    trophies: 5000,
    highestTrophies: 5200,
    expLevel: 30,
    expPoints: null,
    lastSyncedAt: null,
    lastBattleAt: null,
    fame: null,
    fameTierName: null,
    totalPrestigeLevel: null,
    threeVsThreeVictories: null,
    soloVictories: null,
    duoVictories: null,
    bestRoboRumbleTime: null,
    bestTimeAsBigBrawler: null,
    rankedRankName: null,
    rankedElo: null,
    highestSeasonRankedRankName: null,
    highestSeasonRankedElo: null,
    highestAllTimeRankedRankName: null,
    highestAllTimeRankedElo: null,
    isQualifiedFromChampionshipChallenge: null,
    megaPig: null,
  },
  brawlers: [{
    id: 1,
    name: 'Shelly',
    trophies: 900,
    highestTrophies: 1000,
    power: 11,
    rank: 1,
    prestigeLevel: 0,
    currentWinStreak: 2,
    maxWinStreak: 5,
    gadgets: [],
    starPowers: [],
    gears: [],
    hyperCharges: [],
  }],
  catalog: [{ id: 3, name: 'Nita' }],
  source: 'live',
  apiIssue: null,
  fetchedAt: null,
};

function chat(options: Record<string, string | null> = {}): ChatInputCommandInteraction {
  const interaction = {
    user: { id: USER_ID, username: 'alpha' },
    guildId: GUILD_ID,
    options: {
      getString: vi.fn((name: string) => options[name] ?? null),
      getFocused: vi.fn(() => ({ name: 'name', value: '' })),
    },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  return interaction as unknown as ChatInputCommandInteraction;
}

function component(customId: string, userId = USER_ID, values: string[] = []): CommandComponentInteraction {
  const interaction = {
    customId,
    guildId: GUILD_ID,
    user: { id: userId },
    values,
    deferred: false,
    replied: false,
    isStringSelectMenu: () => customId.includes(':sort:') || customId.includes(':filter:') || customId.includes(':detail:'),
    deferUpdate: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
  };
  return interaction as unknown as CommandComponentInteraction;
}

function editPayload(interaction: ChatInputCommandInteraction | CommandComponentInteraction) {
  return (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
    content?: string | null;
    embeds?: unknown[];
    components?: Array<{ components: Array<{ data?: { custom_id?: string } }> }>;
  };
}

function firstCustomId(payload: NonNullable<ReturnType<typeof editPayload>>): string | undefined {
  return payload.components?.[0]?.components?.[0]?.data?.custom_id;
}

beforeEach(() => {
  mocks.loadPlayerBrawlers.mockReset();
  mocks.loadPlayerBrawlers.mockResolvedValue({ kind: 'ok', value: view });
  mocks.findVerifiedPlayerForDiscordUser.mockReset();
  mocks.findVerifiedPlayerForDiscordUser.mockResolvedValue({ tag: '2C0Y' });
  mocks.resolveBrawlerPortraitUrl.mockReset();
  mocks.resolveBrawlerPortraitUrl.mockResolvedValue(null);
});

describe('/brawlers command data', () => {
  it('registers roster and detail commands with autocomplete options', () => {
    const roster = brawlersCommandData.toJSON() as unknown as {
      name: string;
      options: Array<{ name: string; autocomplete?: boolean }>;
    };
    const detail = brawlerCommandData.toJSON() as unknown as {
      name: string;
      options: Array<{ name: string; autocomplete?: boolean }>;
    };

    expect(roster.name).toBe('brawlers');
    expect(roster.options.map((option) => option.name)).toEqual(['tag', 'sort', 'filter']);
    expect(roster.options[0]?.autocomplete).toBe(true);
    expect(detail.name).toBe('brawler');
    expect(detail.options.map((option) => option.name)).toEqual(['name', 'tag']);
    expect(detail.options[0]?.autocomplete).toBe(true);
  });
});

describe('/brawlers handler', () => {
  it('uses the invoking user’s verified tag when none is supplied', async () => {
    const interaction = chat();

    await handleBrawlers(interaction);

    expect(mocks.findVerifiedPlayerForDiscordUser).toHaveBeenCalledWith(USER_ID);
    expect(mocks.loadPlayerBrawlers).toHaveBeenCalledWith({
      tag: '2C0Y',
      guildId: GUILD_ID,
    });
    expect(editPayload(interaction).embeds).toHaveLength(1);
    expect(firstCustomId(editPayload(interaction))).toMatch(/^brawlers:sort:/);
  });

  it('rejects components created for another Discord user', async () => {
    const interaction = chat();
    await handleBrawlers(interaction);
    const nonce = firstCustomId(editPayload(interaction))?.split(':').at(-1);
    expect(nonce).toBeDefined();

    const otherUser = component(`brawlers:back:${nonce}`, '111111111111111111');
    await handleBrawlersComponent(otherUser);

    expect(editPayload(otherUser).content).toContain('expired');
    expect(mocks.loadPlayerBrawlers).toHaveBeenCalledTimes(1);
  });
});

describe('/brawler handler', () => {
  it('shows catalog brawlers with no profile stats without inventing values', async () => {
    const interaction = chat({ name: 'Nita' });

    await handleBrawler(interaction);

    expect(mocks.resolveBrawlerPortraitUrl).toHaveBeenCalledWith('Nita');
    expect(editPayload(interaction).embeds).toHaveLength(1);
    expect(firstCustomId(editPayload(interaction))).toMatch(/^brawlers:back:/);
  });
});
