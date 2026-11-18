import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ButtonStyle, type AutocompleteInteraction, type ButtonInteraction, type ChatInputCommandInteraction } from 'discord.js';

const mocks = vi.hoisted(() => {
  class MockModerationServiceError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
      super(message);
      this.name = 'ModerationServiceError';
      this.code = code;
    }
  }

  return {
    ModerationServiceError: MockModerationServiceError,
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
    embeds: {
      addConfirmation: { kind: 'add-confirmation' },
      added: { kind: 'added' },
      list: { kind: 'list' },
      removed: { kind: 'removed' },
    },
    embed: {
      buildBlacklistAddConfirmationEmbed: vi.fn(),
      buildBlacklistAddedEmbed: vi.fn(),
      buildBlacklistListEmbed: vi.fn(),
      buildBlacklistRemovedEmbed: vi.fn(),
    },
    service: {
      addBlacklist: vi.fn(),
      canManageBlacklists: vi.fn(),
      listActiveBlacklists: vi.fn(),
      removeBlacklist: vi.fn(),
      resolveBlacklistTarget: vi.fn(),
      resolveModerationActor: vi.fn(),
    },
  };
});

vi.mock('../config', () => ({ getBotConfig: () => mocks.config }));
vi.mock('../moderation/service', () => ({
  ...mocks.service,
  ModerationServiceError: mocks.ModerationServiceError,
}));
vi.mock('../moderation/embed', () => mocks.embed);

import {
  blacklistCommandData,
  clearPendingBlacklistActions,
  handleBlacklist,
  handleBlacklistAutocomplete,
  handleBlacklistComponent,
} from './blacklist';

const DISCORD_ID = '111111111111111111';
const OTHER_DISCORD_ID = '999999999999999999';
const ENTRY_ID = '33333333-3333-4333-8333-333333333333';
const FIVE_MINUTES_MS = 5 * 60 * 1000;

function moderator() {
  return { profileId: 'profile-1', discordUserId: DISCORD_ID, globalRole: 'admin' as const };
}

function target() {
  return { id: 'player-1', tag: '2C0Y', name: 'Alpha' };
}

function blacklistEntries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `entry-${index}`,
    playerId: `player-${index}`,
    playerTag: '2C0Y',
    playerName: `Player ${index}`,
    reason: `reason ${index}`,
    createdByProfileId: 'profile-1',
    createdByDiscordId: DISCORD_ID,
    createdAt: '2026-11-18T00:00:00.000Z',
    expiresAt: null,
    removedAt: null,
  }));
}

function listView(count: number) {
  return { entries: blacklistEntries(count), generatedAt: new Date('2026-11-18T01:00:00.000Z') };
}

function chatInteraction(subcommand: string | null, options: Record<string, string | null> = {}) {
  return {
    user: { id: DISCORD_ID },
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

function buttonInteraction(customId: string, discordUserId = DISCORD_ID) {
  const interaction = {
    customId,
    user: { id: discordUserId },
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

function autocompleteInteraction(name: string, value: string) {
  return {
    user: { id: DISCORD_ID },
    guildId: 'guild-1',
    options: {
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

function buttons(reply: any) {
  return reply.components[0].components as Array<{ data: { custom_id: string; style: number } }>;
}

async function startAdd(reason = '  cheating  ') {
  const interaction = chatInteraction('add', { player: '2C0Y', reason });
  await handleBlacklist(interaction);
  const [confirm, cancel] = buttons(payload(interaction, 'reply'));
  return {
    interaction,
    confirmId: confirm!.data.custom_id,
    cancelId: cancel!.data.custom_id,
    nonce: confirm!.data.custom_id.replace('blacklist:confirm:', ''),
  };
}

beforeEach(() => {
  clearPendingBlacklistActions();
  for (const fn of Object.values(mocks.service)) fn.mockReset();
  for (const fn of Object.values(mocks.embed)) fn.mockReset();
  mocks.embed.buildBlacklistAddConfirmationEmbed.mockReturnValue(mocks.embeds.addConfirmation);
  mocks.embed.buildBlacklistAddedEmbed.mockReturnValue(mocks.embeds.added);
  mocks.embed.buildBlacklistListEmbed.mockReturnValue(mocks.embeds.list);
  mocks.embed.buildBlacklistRemovedEmbed.mockReturnValue(mocks.embeds.removed);
  mocks.service.resolveModerationActor.mockResolvedValue(moderator());
  mocks.service.canManageBlacklists.mockReturnValue(true);
  mocks.service.resolveBlacklistTarget.mockResolvedValue(target());
  mocks.service.addBlacklist.mockResolvedValue({
    id: ENTRY_ID,
    player: target(),
    reason: 'cheating',
    createdAt: '2026-11-18T00:00:00.000Z',
  });
  mocks.service.removeBlacklist.mockResolvedValue({
    id: ENTRY_ID,
    removedAt: '2026-11-18T01:00:00.000Z',
  });
  mocks.service.listActiveBlacklists.mockResolvedValue(listView(7));
});

describe('/blacklist command registration', () => {
  it('registers add, remove and list with their options', () => {
    const json = blacklistCommandData.toJSON() as any;
    expect(json.name).toBe('blacklist');
    expect(json.description).toBe('Manage BrawlHub moderation blacklists');
    expect(json.options?.map((option: any) => option.name)).toEqual(['add', 'remove', 'list']);

    const add = json.options.find((option: any) => option.name === 'add');
    expect(add.options.map((option: any) => option.name)).toEqual(['player', 'reason']);
    expect(add.options[0].required).toBe(true);
    expect(add.options[0].max_length).toBe(20);
    expect(add.options[1].max_length).toBe(500);

    const remove = json.options.find((option: any) => option.name === 'remove');
    expect(remove.options[0].autocomplete).toBe(true);
    expect(remove.options[0].max_length).toBe(100);

    const list = json.options.find((option: any) => option.name === 'list');
    expect(list.options[0].max_length).toBe(32);
  });
});

describe('/blacklist command handlers', () => {
  it('previews an add without mutating and binds the buttons to the actor', async () => {
    const { interaction, confirmId, cancelId } = await startAdd();

    expect(mocks.service.resolveBlacklistTarget).toHaveBeenCalledWith('2C0Y');
    expect(mocks.service.addBlacklist).not.toHaveBeenCalled();
    expect(
      mocks.embed.buildBlacklistAddConfirmationEmbed,
    ).toHaveBeenCalledWith(target(), 'cheating', DISCORD_ID);

    const reply = payload(interaction, 'reply');
    expect(reply.ephemeral).toBe(true);
    expect(reply.embeds).toEqual([mocks.embeds.addConfirmation]);
    expect(confirmId).toMatch(/^blacklist:confirm:[0-9a-f-]{36}$/);
    expect(cancelId).toMatch(/^blacklist:cancel:[0-9a-f-]{36}$/);
    expect(buttons(reply).map((button) => button.data.style)).toEqual([
      ButtonStyle.Success,
      ButtonStyle.Danger,
    ]);
  });

  it('applies the captured input only when Confirm is pressed', async () => {
    const { confirmId } = await startAdd();
    const confirm = buttonInteraction(confirmId);

    await handleBlacklistComponent(confirm);

    expect(mocks.service.resolveModerationActor).toHaveBeenCalledWith(DISCORD_ID);
    expect(mocks.service.addBlacklist).toHaveBeenCalledWith({
      discordUserId: DISCORD_ID,
      tag: '2C0Y',
      reason: 'cheating',
    });
    expect(mocks.embed.buildBlacklistAddedEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ id: ENTRY_ID }),
      DISCORD_ID,
    );
    expect(payload(confirm, 'editReply')).toMatchObject({
      embeds: [mocks.embeds.added],
      components: [],
    });

    await handleBlacklistComponent(buttonInteraction(confirmId));
    expect(mocks.service.addBlacklist).toHaveBeenCalledTimes(1);
  });

  it('cancels without calling either mutation service', async () => {
    const { cancelId } = await startAdd();
    const cancel = buttonInteraction(cancelId);

    await handleBlacklistComponent(cancel);

    expect(mocks.service.addBlacklist).not.toHaveBeenCalled();
    expect(mocks.service.removeBlacklist).not.toHaveBeenCalled();
    expect(payload(cancel, 'editReply')).toMatchObject({
      content: 'Blacklist action cancelled.',
      embeds: [],
      components: [],
    });
  });

  it('rejects a confirmation pressed by a different moderator', async () => {
    const { confirmId } = await startAdd();
    const wrongActor = buttonInteraction(confirmId, OTHER_DISCORD_ID);

    await handleBlacklistComponent(wrongActor);

    expect(mocks.service.addBlacklist).not.toHaveBeenCalled();
    expect(payload(wrongActor, 'followUp')).toMatchObject({ ephemeral: true });
    expect(payload(wrongActor, 'followUp').content).toContain('another moderator');
  });

  it('rejects an expired confirmation', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const { confirmId } = await startAdd();
      now.mockReturnValue(1_000_000 + FIVE_MINUTES_MS + 1);
      const confirm = buttonInteraction(confirmId);

      await handleBlacklistComponent(confirm);

      expect(mocks.service.addBlacklist).not.toHaveBeenCalled();
      expect(payload(confirm, 'followUp').content).toContain('expired');
    } finally {
      now.mockRestore();
    }
  });

  it('applies a removal only after confirmation and preserves the original record in the preview', async () => {
    const interaction = chatInteraction('remove', { entry: ENTRY_ID, reason: '  appeal approved  ' });

    await handleBlacklist(interaction);

    expect(mocks.service.removeBlacklist).not.toHaveBeenCalled();
    const reply = payload(interaction, 'reply');
    expect(reply.ephemeral).toBe(true);
    expect(reply.embeds[0].toJSON().title).toBe('Confirm blacklist removal');
    expect(reply.embeds[0].toJSON().description).toContain('preserved');

    const confirmId = buttons(reply)[0]!.data.custom_id;
    const confirm = buttonInteraction(confirmId);
    await handleBlacklistComponent(confirm);

    expect(mocks.service.removeBlacklist).toHaveBeenCalledWith({
      discordUserId: DISCORD_ID,
      blacklistId: ENTRY_ID,
      reason: 'appeal approved',
    });
    expect(mocks.embed.buildBlacklistRemovedEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ id: ENTRY_ID }),
    );
    expect(payload(confirm, 'editReply')).toMatchObject({
      embeds: [mocks.embeds.removed],
      components: [],
    });
  });

  it('paginates the list and preserves the search in pagination custom IDs', async () => {
    const view = listView(7);
    mocks.service.listActiveBlacklists.mockResolvedValue(view);
    const list = chatInteraction('list', { search: 'abc' });

    await handleBlacklist(list);

    expect(mocks.service.listActiveBlacklists).toHaveBeenCalledWith(
      { search: 'abc' },
      { actorDiscordUserId: DISCORD_ID },
    );
    expect(mocks.embed.buildBlacklistListEmbed).toHaveBeenCalledWith(
      view,
      expect.objectContaining({ page: 1, pageCount: 2, total: 7 }),
      mocks.config,
    );
    const reply = payload(list, 'reply');
    expect(reply.ephemeral).toBe(true);
    expect(reply.embeds).toEqual([mocks.embeds.list]);
    expect(reply.components[0].components[0].data.custom_id).toBe('blacklist:page:2:abc');

    const button = buttonInteraction('blacklist:page:2:abc');
    await handleBlacklistComponent(button);

    expect(mocks.service.listActiveBlacklists).toHaveBeenCalledTimes(2);
    expect(mocks.service.listActiveBlacklists).toHaveBeenLastCalledWith(
      { search: 'abc' },
      { actorDiscordUserId: DISCORD_ID },
    );
    expect(mocks.embed.buildBlacklistListEmbed).toHaveBeenLastCalledWith(
      view,
      expect.objectContaining({ page: 2, pageCount: 2 }),
      mocks.config,
    );
    expect(payload(button, 'editReply').embeds).toEqual([mocks.embeds.list]);
  });

  it('returns at most 25 autocomplete choices and fails closed for unauthorized users', async () => {
    mocks.service.listActiveBlacklists.mockResolvedValue(listView(30));
    const autocomplete = autocompleteInteraction('entry', '');

    await handleBlacklistAutocomplete(autocomplete);

    const choices = (autocomplete.respond as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(choices).toHaveLength(25);
    expect(choices[0]).toEqual({ name: '#2C0Y — reason 0', value: 'entry-0' });
    expect(mocks.service.listActiveBlacklists).toHaveBeenCalledWith(
      { search: '' },
      { actorDiscordUserId: DISCORD_ID },
    );

    const ignored = autocompleteInteraction('player', '2C0Y');
    await handleBlacklistAutocomplete(ignored);
    expect((ignored.respond as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual([]);

    mocks.service.listActiveBlacklists.mockRejectedValue(
      new mocks.ModerationServiceError('forbidden', 'You do not have permission to manage blacklists.'),
    );
    const denied = autocompleteInteraction('entry', 'x');
    await handleBlacklistAutocomplete(denied);
    expect((denied.respond as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual([]);
  });
});
