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
    loadHistoryView: vi.fn(),
    loadCompareView: vi.fn(),
    getRegisteredClubs: vi.fn(),
    filterRegisteredClubs: vi.fn(),
  },
}));

vi.mock('../config', () => ({ getBotConfig: () => mocks.config }));
vi.mock('../clubs/service', () => mocks.service);

import { handleClubCompare, handleClubCompareAutocomplete } from './club-compare';
import { handleClubHistory, handleClubHistoryAutocomplete, handleClubHistoryComponent } from './club-history';

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

function selectInteraction(customId: string, values: string[], userId = 'user-1') {
  return {
    customId,
    guildId: 'guild-1',
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

const CLUB_A = {
  id: 'club-a',
  tag: '2C0Y',
  name: 'Alpha',
  description: null,
  trophies: 1000,
  requiredTrophies: 500,
  memberCount: 10,
  lastSyncedAt: null,
};

const CLUB_B = {
  id: 'club-b',
  tag: 'Q8VR',
  name: 'Bravo',
  description: null,
  trophies: 900,
  requiredTrophies: 400,
  memberCount: 10,
  lastSyncedAt: null,
};

function synced() {
  return {
    club: CLUB_A,
    snapshots: [],
    completedRunIds: new Set<string>(),
    latestSnapshot: null,
    roster: [],
    rosterSource: 'snapshot' as const,
    latestSyncAt: '2026-11-18T06:05:00.000Z',
  };
}

function historyResult(count: number, period: '7d' | '30d' | '90d' | 'all' = '30d') {
  const points = Array.from({ length: count }, (_, index) => ({
    capturedAt: `2026-11-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    syncRunId: `run-${index + 1}`,
    trophies: 1000 + index * 100,
    averageTrophies: 700 + index * 20,
    memberCount: 10,
  }));
  const first = points[0];
  const last = points[points.length - 1];

  return {
    kind: 'ok' as const,
    value: {
      ...synced(),
      period,
      points,
      latestSnapshotAt: last?.capturedAt ?? null,
      rangeStart: first?.capturedAt ?? null,
      rangeEnd: last?.capturedAt ?? null,
      change: first !== undefined && last !== undefined
        ? {
            trophies: (last.trophies ?? 0) - (first.trophies ?? 0),
            averageTrophies: (last.averageTrophies ?? 0) - (first.averageTrophies ?? 0),
            memberCount: 0,
          }
        : null,
      progression: null,
      membershipChanges: [],
    },
  };
}

function compareResult(aligned: boolean) {
  const snapshotAt = '2026-11-18T06:00:00.000Z';
  return {
    kind: 'ok' as const,
    value: {
      first: {
        club: CLUB_A,
        trophies: 1000,
        averageTrophies: 700,
        memberCount: 10,
        highestTrophies: 900,
        lowestTrophies: 500,
        progression: { today: 100, week: 200, season: 300 },
        latestSyncAt: '2026-11-18T06:05:00.000Z',
        snapshotAt,
        syncRunId: aligned ? 'run-1' : 'run-2',
      },
      second: {
        club: CLUB_B,
        trophies: 900,
        averageTrophies: 600,
        memberCount: 10,
        highestTrophies: 800,
        lowestTrophies: 400,
        progression: { today: 50, week: 100, season: 150 },
        latestSyncAt: aligned ? '2026-11-18T06:05:00.000Z' : '2026-11-17T06:05:00.000Z',
        snapshotAt: aligned ? snapshotAt : '2026-11-17T06:00:00.000Z',
        syncRunId: aligned ? 'run-1' : 'run-3',
      },
      aligned,
    },
  };
}

function replyPayload(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
  method: 'reply' | 'editReply',
): any {
  return (interaction[method] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as any;
}

beforeEach(() => {
  mocks.service.loadHistoryView.mockReset();
  mocks.service.loadCompareView.mockReset();
  mocks.service.getRegisteredClubs.mockReset();
  mocks.service.filterRegisteredClubs.mockReset();
});

describe('/club-history command', () => {
  it('defaults to 30 days and pages stored snapshots with the period in state', async () => {
    mocks.service.loadHistoryView.mockResolvedValue(historyResult(12));
    const interaction = chatInteraction({ tag: '#2c0y' });

    await handleClubHistory(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.service.loadHistoryView).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: '#2c0y',
        guildId: 'guild-1',
        period: '30d',
        seasonStartIso: mocks.config.seasonStartIso,
      }),
    );
    const payload = replyPayload(interaction, 'editReply');
    expect(payload.embeds[0].toJSON().footer?.text).toContain('Last 30 days');
    expect(payload.components?.[0].toJSON().components[0]?.custom_id).toBe(
      'club-history:page:2:30d|2C0Y',
    );
  });

  it('restores period and tag from history pagination buttons', async () => {
    mocks.service.loadHistoryView.mockResolvedValue(historyResult(12, '7d'));
    const button = buttonInteraction('club-history:page:2:7d|2C0Y');

    await handleClubHistoryComponent(button);

    expect(button.deferUpdate).toHaveBeenCalledOnce();
    expect(mocks.service.loadHistoryView).toHaveBeenCalledWith(
      expect.objectContaining({ period: '7d', tag: '2C0Y' }),
    );
    expect(replyPayload(button, 'editReply').embeds[0].toJSON().footer?.text).toContain('Page 2 / 2');
  });

  it('ignores malformed history pagination states', async () => {
    await handleClubHistoryComponent(buttonInteraction('club-history:page:2:bad-state'));

    expect(mocks.service.loadHistoryView).not.toHaveBeenCalled();
  });

  it('clearly handles insufficient history', async () => {
    mocks.service.loadHistoryView.mockResolvedValue(historyResult(0));
    const interaction = chatInteraction();

    await handleClubHistory(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    const json = replyPayload(interaction, 'editReply').embeds[0].toJSON();
    expect(JSON.stringify(json)).toContain('No stored snapshots');
    expect(replyPayload(interaction, 'editReply').components).toEqual([]);
  });

  it('autocompletes only the tag option', async () => {
    const clubs = [{ ...CLUB_A }];
    mocks.service.getRegisteredClubs.mockResolvedValue(clubs);
    mocks.service.filterRegisteredClubs.mockReturnValue(clubs);

    const tag = autocompleteInteraction('tag', 'alp');
    await handleClubHistoryAutocomplete(tag);
    expect(tag.respond).toHaveBeenCalledWith([{ name: 'Alpha (#2C0Y)', value: '2C0Y' }]);

    const period = autocompleteInteraction('period', '7');
    await handleClubHistoryAutocomplete(period);
    expect(period.respond).toHaveBeenCalledWith([]);
    expect(mocks.service.filterRegisteredClubs).toHaveBeenCalledOnce();
  });

  it('keeps the requested period when a tagless history lookup uses the chooser', async () => {
    mocks.service.loadHistoryView
      .mockResolvedValueOnce({ kind: 'no-default' })
      .mockResolvedValueOnce(historyResult(2, '7d'));
    mocks.service.getRegisteredClubs.mockResolvedValue([CLUB_A, CLUB_B]);
    const interaction = chatInteraction({ period: '7d' });

    await handleClubHistory(interaction);

    const customId = replyPayload(interaction, 'editReply').components[0].toJSON().components[0]
      .custom_id as string;
    expect(customId).toMatch(/^club-history:choose:/);

    const select = selectInteraction(customId, ['Q8VR']);
    await handleClubHistoryComponent(select);

    expect(mocks.service.loadHistoryView).toHaveBeenLastCalledWith(
      expect.objectContaining({ tag: 'Q8VR', period: '7d', guildId: 'guild-1' }),
    );
    expect(replyPayload(select, 'editReply').embeds).toHaveLength(1);
  });
});

describe('/club-compare command', () => {
  it('loads and compares two registered clubs', async () => {
    mocks.service.loadCompareView.mockResolvedValue(compareResult(true));
    const interaction = chatInteraction({ first: '2C0Y', second: 'Q8VR' });

    await handleClubCompare(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.service.loadCompareView).toHaveBeenCalledWith(
      expect.objectContaining({
        firstTag: '2C0Y',
        secondTag: 'Q8VR',
        seasonStartIso: mocks.config.seasonStartIso,
      }),
    );
    const json = replyPayload(interaction, 'editReply').embeds[0].toJSON();
    expect(json.description).toContain('same completed sync');
    expect(json.fields?.find((field: { name: string; value: string }) => field.name === 'Total Trophies')?.value).toContain(
      'Leader: Alpha (#2C0Y)',
    );
  });

  it('warns when the two clubs have different snapshot times', async () => {
    mocks.service.loadCompareView.mockResolvedValue(compareResult(false));
    const interaction = chatInteraction({ first: '2C0Y', second: 'Q8VR' });

    await handleClubCompare(interaction);

    const json = replyPayload(interaction, 'editReply').embeds[0].toJSON();
    expect(json.description).toContain('different completed sync times');
  });

  it('prevents comparing a club with itself', async () => {
    mocks.service.loadCompareView.mockResolvedValue({ kind: 'same-club' });
    const interaction = chatInteraction({ first: '#2c0y', second: '2C0Y' });

    await handleClubCompare(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect((interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ content: expect.stringContaining('two different') }),
    );
  });

  it('offers autocomplete choices for a club tag', async () => {
    const clubs = [{ ...CLUB_A }, { ...CLUB_B }];
    mocks.service.getRegisteredClubs.mockResolvedValue(clubs);
    mocks.service.filterRegisteredClubs.mockReturnValue(clubs);
    const interaction = autocompleteInteraction('second', 'bra');

    await handleClubCompareAutocomplete(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([
      { name: 'Alpha (#2C0Y)', value: '2C0Y' },
      { name: 'Bravo (#Q8VR)', value: 'Q8VR' },
    ]);
  });
});
