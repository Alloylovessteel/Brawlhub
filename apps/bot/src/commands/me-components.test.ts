import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandComponentInteraction } from '../discord/interactions.js';

const GUILD_ID = '1488531664962326571';
const USER_ID = '983248496884875286';

const mocks = vi.hoisted(() => ({
  service: {
    loadPlayerProfile: vi.fn(),
    loadPlayerBrawlers: vi.fn(),
    loadPlayerHistory: vi.fn(),
    loadPlayerBattles: vi.fn(),
    loadPlayerClubs: vi.fn(),
  },
  verification: {
    findVerifiedPlayerForDiscordUser: vi.fn(),
  },
  resolvePlayerIconUrl: vi.fn(async () => null),
  resolveBrawlerPortraitUrl: vi.fn(async () => null),
}));

vi.mock('../config', () => ({ getBotConfig: () => ({}) }));
vi.mock('../players/service', () => mocks.service);
vi.mock('../verification/index', () => mocks.verification);
vi.mock('../metadata/assets.js', () => ({
  resolvePlayerIconUrl: mocks.resolvePlayerIconUrl,
  resolveBrawlerPortraitUrl: mocks.resolveBrawlerPortraitUrl,
}));
vi.mock('../players/embed', async () => {
  const { EmbedBuilder } = await import('discord.js');
  return {
    buildMeSummaryEmbed: vi.fn(() => new EmbedBuilder().setTitle('Summary')),
    buildMeBrawlersEmbed: vi.fn(() => new EmbedBuilder().setTitle('Brawlers')),
    buildMeMoreEmbed: vi.fn(() => new EmbedBuilder().setTitle('More')),
  };
});

import { handleMeComponent } from './me-components.js';
import { handleMe } from './player.js';

function chatInteraction(
  options: Record<string, string | null> = { tag: '#2c0y' },
  guildId: string | null = GUILD_ID,
): ChatInputCommandInteraction {
  const interaction = {
    guildId,
    user: { id: USER_ID, username: 'alpha' },
    options: {
      getSubcommand: vi.fn(() => 'profile'),
      getString: vi.fn((name: string) => options[name] ?? null),
      getFocused: vi.fn(() => ({ name: 'tag', value: '' })),
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

function componentInteraction(
  customId: string,
  options: { readonly guildId?: string | null; readonly userId?: string } = {},
): CommandComponentInteraction {
  const interaction = {
    customId,
    guildId: options.guildId === undefined ? GUILD_ID : options.guildId,
    user: { id: options.userId ?? USER_ID },
    deferred: false,
    replied: false,
    isStringSelectMenu: () => false,
    deferUpdate: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
  };
  return interaction as unknown as CommandComponentInteraction;
}

interface ReplyPayload {
  readonly content?: string | null;
  readonly embeds?: unknown[];
  readonly components?: Array<{ components: Array<{ data: { custom_id?: string } }> }>;
}

function editPayload(interaction: ChatInputCommandInteraction | CommandComponentInteraction): ReplyPayload {
  return (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ReplyPayload;
}

function customIds(payload: ReplyPayload): string[] {
  return (payload.components ?? [])
    .flatMap((row) => row.components.map((component) => component.data.custom_id))
    .filter((id): id is string => id !== undefined);
}

function nonceFrom(payload: ReplyPayload): string {
  const id = customIds(payload).find((customId) => customId.startsWith('me:section:'));
  expect(id).toBeDefined();
  return (id as string).split(':').at(-1) as string;
}

const okProfile = () => ({
  kind: 'ok',
  value: { player: { iconId: 28000003 } },
});

const okBrawlers = (count = 12) => ({
  kind: 'ok',
  value: {
    brawlers: Array.from({ length: count }, (_, index) => ({ name: `Brawler ${index}` })),
  },
});

const okStored = () => ({ kind: 'ok', value: { player: { iconId: 28000003 } } });

beforeEach(() => {
  for (const fn of Object.values(mocks.service)) fn.mockReset();
  mocks.resolvePlayerIconUrl.mockReset().mockResolvedValue(null);
  mocks.resolveBrawlerPortraitUrl.mockReset().mockResolvedValue(null);
  mocks.verification.findVerifiedPlayerForDiscordUser.mockReset().mockResolvedValue(null);
  mocks.service.loadPlayerProfile.mockResolvedValue(okProfile());
  mocks.service.loadPlayerBrawlers.mockResolvedValue(okBrawlers());
  mocks.service.loadPlayerHistory.mockResolvedValue(okStored());
  mocks.service.loadPlayerBattles.mockResolvedValue(okStored());
  mocks.service.loadPlayerClubs.mockResolvedValue(okStored());
});

describe('interactive /me', () => {
  it('creates an actor-bound session and rotates the nonce after a section switch', async () => {
    const command = chatInteraction();
    await handleMe(command);

    const firstPayload = editPayload(command);
    expect(firstPayload.embeds).toHaveLength(1);
    const firstNonce = nonceFrom(firstPayload);

    const brawlersClick = componentInteraction(`me:section:brawlers:${firstNonce}`);
    await handleMeComponent(brawlersClick);

    expect(mocks.service.loadPlayerBrawlers).toHaveBeenCalledWith({
      tag: '#2c0y',
      guildId: GUILD_ID,
    });
    expect(mocks.resolveBrawlerPortraitUrl).toHaveBeenCalledWith('Brawler 0');
    const secondNonce = nonceFrom(editPayload(brawlersClick));
    expect(secondNonce).not.toBe(firstNonce);

    const replay = componentInteraction(`me:section:summary:${firstNonce}`);
    await handleMeComponent(replay);
    expect(editPayload(replay).content).toContain('expired');
    expect(mocks.service.loadPlayerProfile).toHaveBeenCalledTimes(1);

    const rotatedClick = componentInteraction(`me:section:summary:${secondNonce}`);
    await handleMeComponent(rotatedClick);
    expect(mocks.service.loadPlayerProfile).toHaveBeenCalledTimes(2);
    expect(editPayload(rotatedClick).content).toBeNull();
  });

  it('never embeds the player tag in component custom IDs', async () => {
    const command = chatInteraction();
    await handleMe(command);

    const sectionIds = customIds(editPayload(command));
    expect(sectionIds.length).toBeGreaterThan(0);
    expect(sectionIds.every((id) => !id.toLowerCase().includes('2c0y'))).toBe(true);
    expect(nonceFrom(editPayload(command))).toMatch(/^[a-f0-9]{16}$/);

    const brawlersClick = componentInteraction(`me:section:brawlers:${nonceFrom(editPayload(command))}`);
    await handleMeComponent(brawlersClick);
    const allIds = [...sectionIds, ...customIds(editPayload(brawlersClick))];
    expect(allIds.every((id) => !id.toLowerCase().includes('2c0y'))).toBe(true);
  });

  it('ignores an identical double-click without expiring the view', async () => {
    const command = chatInteraction();
    await handleMe(command);
    const firstNonce = nonceFrom(editPayload(command));
    const customId = `me:section:brawlers:${firstNonce}`;

    const firstClick = componentInteraction(customId);
    await handleMeComponent(firstClick);
    expect(mocks.service.loadPlayerBrawlers).toHaveBeenCalledTimes(1);
    expect((firstClick.editReply as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    const doubleClick = componentInteraction(customId);
    await handleMeComponent(doubleClick);
    expect(doubleClick.deferUpdate).toHaveBeenCalledOnce();
    expect(editPayload(doubleClick).content).toBe(
      'That button was already handled. Run /me profile again for a fresh view.',
    );
    expect(editPayload(doubleClick).components).toEqual([]);
    expect(mocks.service.loadPlayerBrawlers).toHaveBeenCalledTimes(1);
  });

  it('does not let another user replay a consumed click', async () => {
    const command = chatInteraction();
    await handleMe(command);
    const firstNonce = nonceFrom(editPayload(command));
    const customId = `me:section:brawlers:${firstNonce}`;

    await handleMeComponent(componentInteraction(customId));
    const replay = componentInteraction(customId, { userId: 'someone-else' });
    await handleMeComponent(replay);

    expect(editPayload(replay).content).toContain('expired');
    expect(mocks.service.loadPlayerBrawlers).toHaveBeenCalledTimes(1);
  });

  it('rejects another user and another guild without consuming the live session', async () => {
    const command = chatInteraction();
    await handleMe(command);
    const nonce = nonceFrom(editPayload(command));

    const otherUser = componentInteraction(`me:section:brawlers:${nonce}`, { userId: 'someone-else' });
    await handleMeComponent(otherUser);
    expect(editPayload(otherUser).content).toContain('expired');
    expect(mocks.service.loadPlayerBrawlers).not.toHaveBeenCalled();

    const otherGuild = componentInteraction(`me:section:brawlers:${nonce}`, { guildId: 'guild-2' });
    await handleMeComponent(otherGuild);
    expect(editPayload(otherGuild).content).toContain('expired');
    expect(mocks.service.loadPlayerBrawlers).not.toHaveBeenCalled();

    const owner = componentInteraction(`me:section:brawlers:${nonce}`);
    await handleMeComponent(owner);
    expect(mocks.service.loadPlayerBrawlers).toHaveBeenCalledTimes(1);
  });

  it('omits buttons and component handlers in DMs', async () => {
    const command = chatInteraction({ tag: '#2c0y' }, null);
    await handleMe(command);

    expect(editPayload(command).components).toEqual([]);
    expect(editPayload(command).embeds).toHaveLength(1);

    const click = componentInteraction('me:section:brawlers:dm', { guildId: null });
    await handleMeComponent(click);
    expect(editPayload(click).content).toContain('expired');
    expect(mocks.service.loadPlayerBrawlers).not.toHaveBeenCalled();
  });

  it('loads every stored section from the click-time guild', async () => {
    const command = chatInteraction();
    await handleMe(command);
    const firstNonce = nonceFrom(editPayload(command));

    const moreClick = componentInteraction(`me:section:more:${firstNonce}`);
    await handleMeComponent(moreClick);

    expect(mocks.service.loadPlayerHistory).toHaveBeenCalledWith({
      tag: '#2c0y',
      period: '30d',
      guildId: GUILD_ID,
    });
    expect(mocks.service.loadPlayerBattles).toHaveBeenCalledWith({
      tag: '#2c0y',
      period: '30d',
      guildId: GUILD_ID,
    });
    expect(mocks.service.loadPlayerClubs).toHaveBeenCalledWith({
      tag: '#2c0y',
      guildId: GUILD_ID,
    });
    expect(mocks.resolvePlayerIconUrl).toHaveBeenCalledWith(28000003);
  });

  it('keeps brawler pagination guild-bound and single-use', async () => {
    const command = chatInteraction();
    await handleMe(command);
    const firstNonce = nonceFrom(editPayload(command));

    const brawlersClick = componentInteraction(`me:section:brawlers:${firstNonce}`);
    await handleMeComponent(brawlersClick);
    const brawlersPayload = editPayload(brawlersClick);
    const brawlersNonce = nonceFrom(brawlersPayload);
    const nextPageId = customIds(brawlersPayload).find((id) => id.startsWith('me:page:2:'));
    expect(nextPageId).toBeDefined();

    const pageClick = componentInteraction(nextPageId as string);
    await handleMeComponent(pageClick);

    expect(mocks.service.loadPlayerBrawlers).toHaveBeenCalledTimes(2);
    const pageNonce = nonceFrom(editPayload(pageClick));
    expect(pageNonce).not.toBe(brawlersNonce);
    expect(customIds(editPayload(pageClick))).toContain(`me:page:1:${pageNonce}`);

    const duplicatePage = componentInteraction(nextPageId as string);
    await handleMeComponent(duplicatePage);
    expect(duplicatePage.deferUpdate).toHaveBeenCalledOnce();
    expect(editPayload(duplicatePage).content).toBe(
      'That button was already handled. Run /me profile again for a fresh view.',
    );
    expect(mocks.service.loadPlayerBrawlers).toHaveBeenCalledTimes(2);
  });
});
