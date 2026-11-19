import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';

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
    loadPlayerProfile: vi.fn(),
    loadPlayerHistory: vi.fn(),
    loadPlayerClubs: vi.fn(),
    loadPlayerCompare: vi.fn(),
    searchPlayers: vi.fn(),
  },
}));

vi.mock('../config', () => ({ getBotConfig: () => mocks.config }));
vi.mock('../players/service', () => mocks.service);

import { handleMe, handleMeAutocomplete } from './player';
import {
  handlePlayerHistory,
  handlePlayerHistoryAutocomplete,
  handlePlayerHistoryComponent,
} from './player-history';
import {
  handlePlayerClubs,
  handlePlayerClubsAutocomplete,
  handlePlayerClubsComponent,
} from './player-clubs';
import { handlePlayerCompare, handlePlayerCompareAutocomplete } from './player-compare';

function chatInteraction(options: Record<string, string | null> = {}) {
  return {
    guildId: 'guild-1',
    options: { getString: vi.fn((name: string) => options[name] ?? null) },
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

function identity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    tag: '2C0Y',
    name: 'Alpha',
    trophies: 5000,
    highestTrophies: 5200,
    expLevel: 35,
    lastSyncedAt: '2026-11-18T11:55:00.000Z',
    ...overrides,
  };
}

function profileResult() {
  return {
    kind: 'ok' as const,
    value: {
      player: identity(),
      currentClub: {
        id: 'club-a', tag: '8QCL', name: 'Alpha Club', role: 'president',
        validFrom: '2026-11-01T00:00:00.000Z', validTo: null,
      },
      brawlers: [],
      latestSnapshotAt: '2026-11-17T00:00:00.000Z',
      source: 'stored' as const,
      apiIssue: null,
      profileFetchedAt: null,
    },
  };
}

function historyResult(count: number, period = '30d') {
  const points = Array.from({ length: count }, (_, index) => ({
    capturedAt: `2026-11-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    trophies: 4000 + index * 100,
  }));
  return {
    kind: 'ok' as const,
    value: {
      player: identity(),
      period,
      points,
      currentTrophies: 5000,
      highestRecordedTrophies: 5200,
      firstSnapshotAt: points[0]?.capturedAt ?? null,
      latestSnapshotAt: points[points.length - 1]?.capturedAt ?? null,
      change: null,
      progression: null,
      memberships: [],
      events: [],
    },
  };
}

function membership(index: number) {
  return {
    id: `m${index}`,
    club_id: `club-${index}`,
    player_id: 'p1',
    tag: '8QCL',
    name: `Club ${index}`,
    role: 'member',
    validFrom: '2026-11-01T00:00:00.000Z',
    validTo: null,
    status: 'current' as const,
    durationMs: null,
  };
}

function clubsResult(count: number) {
  const memberships = Array.from({ length: count }, (_, index) => membership(index));
  return {
    kind: 'ok' as const,
    value: {
      player: identity(),
      currentClub: memberships[0] ?? null,
      memberships,
      events: [],
      latestSyncAt: '2026-11-18T11:55:00.000Z',
    },
  };
}

function compareResult(aligned: boolean) {
  return {
    kind: 'ok' as const,
    value: {
      first: {
        player: identity(), currentClub: null, currentTrophies: 5000,
        highestTrophies: 5200, expLevel: 35, highestRecordedTrophies: 5200,
        progression: null, firstSnapshotAt: '2026-11-01T00:00:00.000Z',
        latestSnapshotAt: '2026-11-17T00:00:00.000Z', snapshotTrophies: 5000,
      },
      second: {
        player: identity({ id: 'p2', tag: 'Q8VR', name: 'Bravo' }), currentClub: null,
        currentTrophies: 4500, highestTrophies: 4700, expLevel: 30,
        highestRecordedTrophies: 4700, progression: null,
        firstSnapshotAt: aligned ? '2026-11-01T00:00:00.000Z' : '2026-11-02T00:00:00.000Z',
        latestSnapshotAt: '2026-11-17T00:00:00.000Z', snapshotTrophies: 4500,
      },
      period: '30d',
      aligned,
      warning: aligned ? null : 'Stored snapshots cover different periods; compare with care.',
    },
  };
}

function payload(interaction: ChatInputCommandInteraction | ButtonInteraction, method: 'reply' | 'editReply'): any {
  return (interaction[method] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as any;
}

beforeEach(() => {
  for (const fn of Object.values(mocks.service)) fn.mockReset();
});

describe('/me command', () => {
  it('loads and renders a player profile with a Brawlify link', async () => {
    mocks.service.loadPlayerProfile.mockResolvedValue(profileResult());
    const interaction = chatInteraction({ tag: '#2c0y' });

    await handleMe(interaction);

    expect(mocks.service.loadPlayerProfile).toHaveBeenCalledWith({ tag: '#2c0y', guildId: 'guild-1' });
    expect(JSON.stringify(payload(interaction, 'reply').embeds[0].toJSON())).toContain(
      '[Alpha](https://brawlify.com/player/2C0Y)',
    );
  });

  it('handles invalid, unknown and API-unavailable players safely', async () => {
    const invalid = chatInteraction({ tag: '#BAD-TAG!' });
    mocks.service.loadPlayerProfile.mockResolvedValueOnce({ kind: 'invalid-tag' });
    await handleMe(invalid);
    expect(payload(invalid, 'reply').content).toContain('not valid');

    const unknown = chatInteraction({ tag: 'QQQ' });
    mocks.service.loadPlayerProfile.mockResolvedValueOnce({ kind: 'not-found', tag: 'QQQ' });
    await handleMe(unknown);
    expect(payload(unknown, 'reply').content).toContain('was not found');

    const unavailable = chatInteraction({ tag: 'QQQ' });
    mocks.service.loadPlayerProfile.mockResolvedValueOnce({ kind: 'api-unavailable', tag: 'QQQ', issue: 'rate-limit' });
    await handleMe(unavailable);
    expect(payload(unavailable, 'reply').content).toContain('could not be verified');
  });

  it('offers stored player autocomplete choices', async () => {
    const players = [identity()];
    mocks.service.searchPlayers.mockResolvedValue(players);
    const interaction = autocompleteInteraction('tag', 'alp');

    await handleMeAutocomplete(interaction);

    expect(mocks.service.searchPlayers).toHaveBeenCalledWith('alp', { guildId: undefined });
    expect(interaction.respond).toHaveBeenCalledWith([{ name: 'Alpha (#2C0Y)', value: '2C0Y' }]);
  });
});

describe('/player-history command', () => {
  it('defaults to 30 days and keeps period/tag in pagination state', async () => {
    mocks.service.loadPlayerHistory.mockResolvedValue(historyResult(12));
    const interaction = chatInteraction({ tag: '#2c0y' });

    await handlePlayerHistory(interaction);

    expect(mocks.service.loadPlayerHistory).toHaveBeenCalledWith(
      expect.objectContaining({ tag: '#2c0y', period: '30d', seasonStartIso: mocks.config.seasonStartIso }),
    );
    expect(payload(interaction, 'reply').components[0].toJSON().components[0]?.custom_id).toBe(
      'player-history:page:2:30d|2C0Y',
    );
  });

  it('restores state from buttons and ignores malformed states', async () => {
    mocks.service.loadPlayerHistory.mockResolvedValue(historyResult(12, '7d'));
    const button = buttonInteraction('player-history:page:2:7d|2C0Y');
    await handlePlayerHistoryComponent(button);
    expect(mocks.service.loadPlayerHistory).toHaveBeenCalledWith(
      expect.objectContaining({ tag: '2C0Y', period: '7d' }),
    );
    expect(payload(button, 'editReply').embeds[0].toJSON().footer?.text).toContain('Page 2 / 2');

    await handlePlayerHistoryComponent(buttonInteraction('player-history:page:2:bad'));
    expect(mocks.service.loadPlayerHistory).toHaveBeenCalledTimes(1);
  });

  it('only autocompletes the tag option', async () => {
    mocks.service.searchPlayers.mockResolvedValue([identity()]);
    await handlePlayerHistoryAutocomplete(autocompleteInteraction('tag', 'alp'));
    await handlePlayerHistoryAutocomplete(autocompleteInteraction('period', '7'));
    expect(mocks.service.searchPlayers).toHaveBeenCalledOnce();
  });
});

describe('/player-clubs command', () => {
  it('paginates stored memberships and preserves the tag', async () => {
    mocks.service.loadPlayerClubs.mockResolvedValue(clubsResult(12));
    const button = buttonInteraction('player-clubs:page:2:2C0Y');

    await handlePlayerClubsComponent(button);

    expect(mocks.service.loadPlayerClubs).toHaveBeenCalledWith({ tag: '2C0Y', guildId: 'guild-1' });
    expect(payload(button, 'editReply').embeds[0].toJSON().footer?.text).toContain('Page 2 / 2');
  });

  it('renders a safe empty membership view', async () => {
    mocks.service.loadPlayerClubs.mockResolvedValue(clubsResult(0));
    const interaction = chatInteraction({ tag: '2C0Y' });

    await handlePlayerClubs(interaction);

    expect(JSON.stringify(payload(interaction, 'reply').embeds[0].toJSON())).toContain(
      'No stored club membership records',
    );
    expect(payload(interaction, 'reply').components).toEqual([]);
  });

  it('offers stored player autocomplete choices', async () => {
    mocks.service.searchPlayers.mockResolvedValue([identity()]);
    const interaction = autocompleteInteraction('tag', '2C');
    await handlePlayerClubsAutocomplete(interaction);
    expect(interaction.respond).toHaveBeenCalledWith([{ name: 'Alpha (#2C0Y)', value: '2C0Y' }]);
  });
});

describe('/player-compare command', () => {
  it('compares two players and shows the alignment warning when needed', async () => {
    mocks.service.loadPlayerCompare.mockResolvedValue(compareResult(false));
    const interaction = chatInteraction({ first: '2C0Y', second: 'Q8VR' });

    await handlePlayerCompare(interaction);

    expect(mocks.service.loadPlayerCompare).toHaveBeenCalledWith(
      expect.objectContaining({ firstTag: '2C0Y', secondTag: 'Q8VR', period: '30d' }),
    );
    const data = payload(interaction, 'reply').embeds[0].toJSON();
    expect(data.description).toContain('different periods');
    expect(JSON.stringify(data)).toContain('Leader: [Alpha](https://brawlify.com/player/2C0Y)');
  });

  it('rejects self-comparison before rendering', async () => {
    mocks.service.loadPlayerCompare.mockResolvedValue({ kind: 'same-player' });
    const interaction = chatInteraction({ first: '2C0Y', second: '2C0Y' });

    await handlePlayerCompare(interaction);

    expect(payload(interaction, 'reply').content).toContain('two different players');
  });

  it('offers autocomplete choices for both tag options', async () => {
    mocks.service.searchPlayers.mockResolvedValue([identity()]);
    const interaction = autocompleteInteraction('second', 'bra');
    await handlePlayerCompareAutocomplete(interaction);
    expect(interaction.respond).toHaveBeenCalledWith([{ name: 'Alpha (#2C0Y)', value: '2C0Y' }]);
  });
});
