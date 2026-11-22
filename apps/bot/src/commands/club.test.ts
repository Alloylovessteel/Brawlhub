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
    seasonStartIso: undefined,
  },
  service: {
    loadClubView: vi.fn(),
    loadClubMemberDetails: vi.fn(),
    loadClubPreviousMembers: vi.fn(),
    loadSyncedClub: vi.fn(),
    getRegisteredClubs: vi.fn(),
    loadClubSummaries: vi.fn(),
    filterRegisteredClubs: vi.fn(),
  },
  resolveClubBadgeUrl: vi.fn(async (): Promise<string | null> => null),
  chartService: {
    loadOrRenderChart: vi.fn(),
    chartFailureMessage: vi.fn(() => 'chart unavailable'),
  },
}));

vi.mock('../config', () => ({ getBotConfig: () => mocks.config }));
vi.mock('../clubs/service', () => mocks.service);
vi.mock('../metadata/assets', () => ({ resolveClubBadgeUrl: mocks.resolveClubBadgeUrl }));
vi.mock('../images/chart-service.js', () => mocks.chartService);

import {
  buildClubSectionCustomId,
  handleClubAutocomplete,
  handleClub,
  handleClubComponent,
} from './club';
import { handleClubs, handleClubsComponent } from './clubs';

function chatInteraction(
  tag: string | null = null,
  guildId: string | null = 'guild-1',
  options: Record<string, unknown> = {},
  userId = 'user-1',
) {
  const interaction = {
    guildId,
    user: { id: userId },
    options: {
      getString: vi.fn((name: string) =>
        name === 'tag' ? tag : (options[name] ?? null),
      ),
      getBoolean: vi.fn((name: string) => options[name] ?? null),
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
  return interaction as unknown as ChatInputCommandInteraction;
}

function autocompleteInteraction(focused: string, name = 'tag') {
  return {
    options: { getFocused: vi.fn(() => ({ name, value: focused })) },
    respond: vi.fn(async () => undefined),
  } as unknown as AutocompleteInteraction;
}

function buttonInteraction(customId: string) {
  const interaction = {
    customId,
    guildId: 'guild-1',
    user: { id: 'user-1' },
    replied: false,
    deferred: false,
    deferUpdate: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  return interaction as unknown as ButtonInteraction;
}

function selectInteraction(
  customId: string,
  values: string[],
  guildId: string | null = 'guild-1',
  userId = 'user-1',
) {
  const interaction = {
    customId,
    guildId,
    user: { id: userId },
    values,
    isStringSelectMenu: vi.fn(() => true),
    replied: false,
    deferred: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  return interaction as unknown as StringSelectMenuInteraction;
}

function okView(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'ok',
    view: {
      club: {
        id: 'club-1',
        tag: '2C0Y',
        name: 'Alpha',
        description: 'Description',
        trophies: 1000,
        requiredTrophies: 500,
        memberCount: 30,
        lastSyncedAt: null,
      },
      roster: [{ tag: 'G2P9', name: 'Leader', trophies: 900, role: 'president' }],
      rosterAvailable: true,
      rosterSource: 'live',
      snapshots: [],
      currentTrophies: 1000,
      currentAt: new Date().toISOString(),
      description: 'Description',
      requiredTrophies: 500,
      type: null,
      badgeId: null,
      matchActivity: null,
      megaPigEstimate: null,
      latestSyncAt: null,
      liveStatus: 'live',
      apiIssue: null,
      ...overrides,
    },
  };
}

function summary(index: number) {
  return {
    club: {
      id: `club-${index}`,
      tag: `TAG${index}`,
      name: `Club ${index}`,
      description: null,
      trophies: 1000 + index,
      requiredTrophies: null,
      memberCount: 20,
      lastSyncedAt: null,
    },
    totalTrophies: 1000 + index,
    averageTrophies: 50 + index,
    memberCount: 20,
    latestSyncAt: null,
  };
}

beforeEach(() => {
  mocks.service.loadClubView.mockReset();
  mocks.service.loadClubMemberDetails.mockReset();
  mocks.service.loadClubPreviousMembers.mockReset();
  mocks.service.loadSyncedClub.mockReset();
  mocks.service.getRegisteredClubs.mockReset();
  mocks.service.loadClubSummaries.mockReset();
  mocks.service.filterRegisteredClubs.mockReset();
  mocks.resolveClubBadgeUrl.mockReset().mockResolvedValue(null);
  mocks.chartService.loadOrRenderChart.mockReset();
  mocks.chartService.chartFailureMessage.mockReset().mockReturnValue('chart unavailable');
});

describe('/clubs details command', () => {
  it('uses the only registered club when no tag is supplied', async () => {
    mocks.service.loadClubView.mockResolvedValue(okView());
    const interaction = chatInteraction();

    await handleClub(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.service.loadClubView).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: undefined,
        guildId: 'guild-1',
      }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) }),
    );
  });

  it('looks up a club by tag and displays the embed', async () => {
    mocks.service.loadClubView.mockResolvedValue(okView());
    const interaction = chatInteraction('#2c0y');

    await handleClub(interaction);

    expect(mocks.service.loadClubView).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: '#2c0y',
        guildId: 'guild-1',
      }),
    );
    const payload = (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload.embeds[0].toJSON().title).toContain('#2C0Y');
  });

  it('resolves the club badge from static metadata before rendering', async () => {
    mocks.resolveClubBadgeUrl.mockResolvedValue('https://cdn.example.test/badge.png');
    mocks.service.loadClubView.mockResolvedValue(okView({ badgeId: 8000001 }));
    const interaction = chatInteraction();

    await handleClub(interaction);

    expect(mocks.resolveClubBadgeUrl).toHaveBeenCalledWith(8000001);
    const payload = (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload.embeds[0].toJSON().thumbnail.url).toBe('https://cdn.example.test/badge.png');
  });

  it('explains invalid tags without a database lookup', async () => {
    mocks.service.loadClubView.mockResolvedValue({ kind: 'invalid-tag' });
    const interaction = chatInteraction('#bad-tag!');

    await handleClub(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('not valid') }),
    );
  });

  it('explains that an unregistered club must be registered first', async () => {
    mocks.service.loadClubView.mockResolvedValue({ kind: 'unregistered', tag: 'G2P9' });
    const interaction = chatInteraction('G2P9');

    await handleClub(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('authorised user must register/link'),
      }),
    );
  });

  it('preserves /clubs details options when resolving a tagless lookup through the chooser', async () => {
    const base = {
      ...okView().view,
      rosterSource: 'snapshot' as const,
      completedRunIds: new Set<string>(),
      latestSnapshot: null,
      roster: [],
    };
    mocks.service.loadClubMemberDetails
      .mockResolvedValueOnce({ kind: 'no-default' })
      .mockResolvedValueOnce({
        kind: 'ok',
        value: { ...base, members: [], sort: 'highest', filter: 'ranked', search: 'Leader' },
      });
    mocks.service.getRegisteredClubs.mockResolvedValue([
      { ...okView().view.club, tag: '2C0Y', name: 'Alpha' },
      { ...okView().view.club, id: 'club-2', tag: 'TAG2', name: 'Beta' },
    ]);
    const interaction = chatInteraction(null, 'guild-1', {
      section: 'details',
      sort: 'highest',
      filter: 'ranked',
      member: 'Leader',
    });

    await handleClub(interaction);

    const chooserPayload = (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const customId = chooserPayload.components[0].toJSON().components[0].custom_id as string;
    expect(customId).toMatch(/^club:choose:/);

    const select = selectInteraction(customId, ['TAG2']);
    await handleClubComponent(select);

    expect(select.deferUpdate).toHaveBeenCalledOnce();
    expect(mocks.service.loadClubMemberDetails).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tag: 'TAG2',
        guildId: 'guild-1',
        sort: 'highest',
        filter: 'ranked',
        search: 'Leader',
      }),
    );
    const payload = (select.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload.embeds).toHaveLength(1);
  });

  it('renders an embed without unavailable fields when data is missing', async () => {
    mocks.service.loadClubView.mockResolvedValue(
      okView({
        roster: [],
        rosterAvailable: false,
        currentTrophies: null,
        description: null,
        requiredTrophies: null,
        type: null,
        badgeId: null,
        matchActivity: null,
        megaPigEstimate: null,
        liveStatus: 'sync-only',
      }),
    );
    const interaction = chatInteraction();

    await handleClub(interaction);

    const payload = (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload.embeds[0].toJSON().fields).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('Unavailable');
  });

  it('explains a rate-limited API response while showing synced data', async () => {
    mocks.service.loadClubView.mockResolvedValue(
      okView({ apiIssue: 'rate-limit', liveStatus: 'sync-only' }),
    );
    const interaction = chatInteraction();

    await handleClub(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('rate limited') }),
    );
  });

  it('offers registered club names and tags as autocomplete choices', async () => {
    const clubs = [summary(1).club];
    mocks.service.getRegisteredClubs.mockResolvedValue(clubs);
    mocks.service.filterRegisteredClubs.mockReturnValue(clubs);
    const interaction = autocompleteInteraction('club');

    await handleClubAutocomplete(interaction);

    expect(mocks.service.filterRegisteredClubs).toHaveBeenCalledWith(clubs, 'club');
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: 'Club 1 (#TAG1)', value: 'TAG1' },
    ]);
  });

  it('keeps previous members when a paginated member-details page changes', async () => {
    const base = {
      ...okView().view,
      rosterSource: 'snapshot' as const,
      completedRunIds: new Set<string>(),
      latestSnapshot: null,
      roster: [],
    };
    const member = {
      tag: 'G2P9',
      name: 'Leader',
      trophies: 1000,
      role: 'president',
      playerId: 'p1',
      highestTrophies: 1050,
      lastBattleAt: null,
      rankedRankName: null,
      highestAllTimeRankedRankName: null,
      soloVictories: null,
      duoVictories: null,
      threeVsThreeVictories: null,
      joinedAt: null,
      verified: false,
      progression: null,
    };
    mocks.service.loadClubMemberDetails.mockResolvedValue({
      kind: 'ok',
      value: { ...base, members: [member], sort: 'trophies', filter: null, search: null },
    });
    mocks.service.loadClubPreviousMembers.mockResolvedValue({
      kind: 'ok',
      value: {
        ...base,
        previous: [
          {
            playerId: 'p2',
            tag: 'Q8VR',
            name: 'Former',
            trophies: 800,
            role: 'member',
            leftAt: '2026-11-16T00:00:00.000Z',
          },
        ],
      },
    });
    const interaction = buttonInteraction('club:page:2:details|trophies|-|-|1|2C0Y');

    await handleClubComponent(
      interaction as unknown as Parameters<typeof handleClubComponent>[0],
    );

    const payload = (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload.embeds).toHaveLength(2);
    expect(payload.embeds[1].toJSON().title).toContain('Previous Members');
  });

  it('switches club detail sections from an in-message button', async () => {
    const base = {
      ...okView().view,
      rosterSource: 'snapshot' as const,
      completedRunIds: new Set<string>(),
      latestSnapshot: null,
      roster: [],
    };
    mocks.service.loadClubPreviousMembers.mockResolvedValue({
      kind: 'ok',
      value: {
        ...base,
        previous: [
          {
            playerId: 'p2',
            tag: 'Q8VR',
            name: 'Former',
            trophies: 800,
            role: 'member',
            leftAt: '2026-11-16T00:00:00.000Z',
          },
        ],
      },
    });
    const interaction = buttonInteraction(buildClubSectionCustomId('previous', '2C0Y'));

    await handleClubComponent(
      interaction as unknown as Parameters<typeof handleClubComponent>[0],
    );

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(mocks.service.loadClubPreviousMembers).toHaveBeenCalledWith(
      expect.objectContaining({ tag: '2C0Y', guildId: 'guild-1' }),
    );
    const payload = (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload.embeds[0].toJSON().title).toContain('Previous Members');
    expect(payload.components[0].toJSON().components).toHaveLength(5);
  });
});

describe('/clubs command', () => {
  it('paginates the registered club list', async () => {
    mocks.service.loadClubSummaries.mockResolvedValue(
      Array.from({ length: 7 }, (_, index) => summary(index + 1)),
    );
    const interaction = chatInteraction();

    await handleClubs(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    const payload = (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload.embeds[0].toJSON().footer.text).toContain('Page 1 / 2');
    expect(payload.components[0].toJSON().components[0].custom_id).toBe('clubs:page:2');
  });

  it('updates the requested page from a pagination button', async () => {
    mocks.service.loadClubSummaries.mockResolvedValue(
      Array.from({ length: 7 }, (_, index) => summary(index + 1)),
    );
    const interaction = buttonInteraction('clubs:page:2');

    await handleClubsComponent(interaction);

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    const payload = (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload.embeds[0].toJSON().footer.text).toContain('Page 2 / 2');
  });

  it('adds an open button for every club on the page', async () => {
    mocks.service.loadClubSummaries.mockResolvedValue(
      Array.from({ length: 7 }, (_, index) => summary(index + 1)),
    );
    const interaction = chatInteraction();

    await handleClubs(interaction);

    const payload = (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload.components[0].toJSON().components[0].custom_id).toBe('clubs:page:2');
    expect(payload.components[1].toJSON().components.map((component: { custom_id: string }) => component.custom_id)).toEqual([
      'clubs:open:TAG1',
      'clubs:open:TAG2',
      'clubs:open:TAG3',
      'clubs:open:TAG4',
      'clubs:open:TAG5',
    ]);
  });

  it('opens a club detail message with section buttons from a list button', async () => {
    mocks.service.loadClubView.mockResolvedValue(okView());
    const interaction = buttonInteraction('clubs:open:2C0Y');

    await handleClubsComponent(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.service.loadClubView).toHaveBeenCalledWith(
      expect.objectContaining({ tag: '2C0Y', guildId: 'guild-1' }),
    );
    const payload = (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload.embeds[0].toJSON().title).toContain('#2C0Y');
    expect(payload.components[0].toJSON().components).toHaveLength(5);
    expect(payload.components[0].toJSON().components[0].custom_id).toMatch(
      /^club:section:overview\|trophies\|-\|-\|0\|2C0Y$/,
    );
    expect(payload.components[1].toJSON().components).toHaveLength(1);
    expect(payload.components[1].toJSON().components[0]).toMatchObject({
      custom_id: 'clubs:chart:2C0Y',
      label: 'Chart',
    });
  });

  it('posts a public stored-data chart from the Chart button', async () => {
    mocks.chartService.loadOrRenderChart.mockResolvedValue({
      kind: 'ok',
      image: {
        png: Buffer.from('png'),
        fileName: 'club.png',
        width: 1200,
        height: 700,
      },
    });
    const interaction = buttonInteraction('clubs:chart:2C0Y');

    await handleClubsComponent(interaction);

    expect(mocks.chartService.loadOrRenderChart).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 'guild-1',
        kind: 'club',
        tag: '2C0Y',
        option: 'trophies',
      }),
    );
    const payload = (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload.files).toHaveLength(1);
    expect(payload.components).toEqual([]);
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it('ignores pagination buttons belonging to another command', async () => {
    const interaction = buttonInteraction('other:page:2');

    await handleClubsComponent(interaction);

    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.service.loadClubSummaries).not.toHaveBeenCalled();
  });

  it('shows details for every club selected in the overview menu', async () => {
    mocks.service.loadClubView.mockResolvedValue(okView());
    const interaction = selectInteraction('clubs:overview:guild-1', ['TAG1', 'TAG2']);

    await handleClubsComponent(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.service.loadClubView).toHaveBeenCalledTimes(2);
    expect(mocks.service.loadClubView).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ tag: 'TAG1', guildId: 'guild-1' }),
    );
    expect(mocks.service.loadClubView).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tag: 'TAG2', guildId: 'guild-1' }),
    );
    const payload = (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload.embeds).toHaveLength(2);
  });

  it('ignores overview selections from another guild', async () => {
    const interaction = selectInteraction('clubs:overview:guild-1', ['TAG1'], 'guild-2');

    await handleClubsComponent(interaction);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(mocks.service.loadClubView).not.toHaveBeenCalled();
  });
});
