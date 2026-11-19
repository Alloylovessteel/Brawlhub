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
    seasonStartIso: undefined,
  },
  service: {
    loadClubView: vi.fn(),
    getRegisteredClubs: vi.fn(),
    loadClubSummaries: vi.fn(),
    filterRegisteredClubs: vi.fn(),
  },
}));

vi.mock('../config', () => ({ getBotConfig: () => mocks.config }));
vi.mock('../clubs/service', () => mocks.service);

import { handleClubAutocomplete, handleClub } from './club';
import { handleClubs, handleClubsComponent } from './clubs';

function chatInteraction(tag: string | null = null, guildId: string | null = 'guild-1') {
  const interaction = {
    guildId,
    options: { getString: vi.fn(() => tag) },
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

function autocompleteInteraction(focused: string) {
  return {
    options: { getFocused: vi.fn(() => focused) },
    respond: vi.fn(async () => undefined),
  } as unknown as AutocompleteInteraction;
}

function buttonInteraction(customId: string) {
  return {
    customId,
    replied: false,
    deferred: false,
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as unknown as ButtonInteraction;
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
  mocks.service.getRegisteredClubs.mockReset();
  mocks.service.loadClubSummaries.mockReset();
  mocks.service.filterRegisteredClubs.mockReset();
});

describe('/club command', () => {
  it('uses the default club when no tag is supplied', async () => {
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
});

describe('/clubs command', () => {
  it('paginates the registered club list', async () => {
    mocks.service.loadClubSummaries.mockResolvedValue(
      Array.from({ length: 7 }, (_, index) => summary(index + 1)),
    );
    const interaction = chatInteraction();

    await handleClubs(interaction);

    const payload = (interaction.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
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

  it('ignores pagination buttons belonging to another command', async () => {
    const interaction = buttonInteraction('other:page:2');

    await handleClubsComponent(interaction);

    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.service.loadClubSummaries).not.toHaveBeenCalled();
  });
});
