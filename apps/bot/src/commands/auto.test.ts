import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';

const mocks = vi.hoisted(() => ({
  requireGlobalPermission: vi.fn(),
  setupGuildAutomation: vi.fn(),
  setupGuildAutoRoles: vi.fn(),
  buildVerificationMessage: vi.fn(),
  replyAdminError: vi.fn(),
}));

vi.mock('../admin/service', () => ({
  AdminServiceError: class extends Error {},
  requireGlobalPermission: mocks.requireGlobalPermission,
}));

vi.mock('../admin/errors', () => ({ replyAdminError: mocks.replyAdminError }));

vi.mock('../ranked-roles/service', () => ({
  buildVerificationMessage: mocks.buildVerificationMessage,
  setupGuildAutomation: mocks.setupGuildAutomation,
}));

vi.mock('../role-automation/service', () => ({
  setupGuildAutoRoles: mocks.setupGuildAutoRoles,
}));

import { autoCommandData, handleAuto, handleAutoComponent } from './auto.js';

const GUILD_ID = '1488531664962326571';
const OTHER_GUILD_ID = '1488531664962326572';
const CHANNEL_ID = '1488531664962326999';

interface InteractionCalls {
  readonly deferReply: ReturnType<typeof vi.fn>;
  readonly editReply: ReturnType<typeof vi.fn>;
  readonly reply: ReturnType<typeof vi.fn>;
}

function chatInput(): ChatInputCommandInteraction & {
  readonly calls: InteractionCalls;
} {
  const calls = {
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  };
  return {
    guild: { id: GUILD_ID, ownerId: '983248496884875286' },
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    user: { id: '983248496884875286', username: 'staff' },
    member: null,
    memberPermissions: null,
    options: { getChannel: () => null },
    calls,
    ...calls,
  } as unknown as ChatInputCommandInteraction & { readonly calls: InteractionCalls };
}

function button(customId: string, guildId: string | null): ButtonInteraction & {
  readonly calls: InteractionCalls;
} {
  const calls = {
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  };
  return {
    customId,
    guildId,
    guild: guildId === null ? null : { id: guildId },
    user: { id: '983248496884875286', username: 'staff' },
    member: null,
    memberPermissions: null,
    calls,
    ...calls,
  } as unknown as ButtonInteraction & { readonly calls: InteractionCalls };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireGlobalPermission.mockResolvedValue({
    profileId: 'profile-1',
    discordUserId: '983248496884875286',
    globalRole: 'admin',
  });
  mocks.setupGuildAutomation.mockResolvedValue({
    guildId: GUILD_ID,
    mapping: {},
    verificationChannelId: CHANNEL_ID,
    verificationMessageId: 'message-1',
  });
  mocks.setupGuildAutoRoles.mockResolvedValue({
    guildId: GUILD_ID,
    configuredRoles: 43,
    createdRoles: 43,
    reusedRoles: 0,
    managedRoles: 43,
    kinds: [
      'Verify',
      'Trophy',
      'Solo Win',
      'Duo Win',
      '3vs3 Win',
      'Brawler',
      'Level',
      'Ranked League',
      'Club',
      'Fame',
    ],
    tiers: {},
    channelId: CHANNEL_ID,
  });
  mocks.buildVerificationMessage.mockReturnValue({
    embeds: [],
    components: [],
    allowedMentions: { parse: [] },
  });
});

describe('/auto setup command data', () => {
  it('lists all supported role kinds without adding new commands', () => {
    const json = autoCommandData.toJSON() as {
      name: string;
      options?: readonly { name: string; description: string }[];
    };
    expect(json.name).toBe('auto');
    expect(json.options).toHaveLength(1);
    const setup = json.options?.[0];
    expect(setup?.name).toBe('setup');
    for (const label of [
      'Verify',
      'Trophy',
      'Solo Win',
      'Duo Win',
      '3vs3 Win',
      'Brawler',
      'Level',
      'Ranked League',
      'Club',
      'Fame',
    ]) {
      expect(setup?.description).toContain(label);
    }
    expect(setup?.description.length ?? 0).toBeLessThanOrEqual(100);
  });
});

describe('/auto setup handler', () => {
  it('runs both verification setup and declarative role setup', async () => {
    const interaction = chatInput();
    await handleAuto(interaction);

    expect(mocks.setupGuildAutomation).toHaveBeenCalledOnce();
    expect(mocks.setupGuildAutoRoles).toHaveBeenCalledOnce();
    const payload = interaction.calls.editReply.mock.calls[0]?.[0] as {
      embeds: readonly { data: { description?: string; fields?: readonly { name: string }[] } }[];
    };
    const description = payload.embeds[0]?.data.description ?? '';
    expect(description).toContain('Ranked League');
    expect(payload.embeds[0]?.data.fields?.map((field) => field.name)).toContain(
      'Supported role kinds',
    );
  });
});

describe('auto guide component guild isolation', () => {
  it('replies ephemerally when the guide belongs to another guild', async () => {
    const interaction = button(`auto:guide:${GUILD_ID}`, OTHER_GUILD_ID);
    await handleAutoComponent(interaction);

    expect(interaction.calls.deferReply).not.toHaveBeenCalled();
    expect(interaction.calls.reply).toHaveBeenCalledOnce();
    const payload = interaction.calls.reply.mock.calls[0]?.[0] as { flags: unknown };
    expect(payload.flags).toBeDefined();
    expect(mocks.buildVerificationMessage).not.toHaveBeenCalled();
  });

  it('shows the guide in the matching guild', async () => {
    const interaction = button(`auto:guide:${GUILD_ID}`, GUILD_ID);
    await handleAutoComponent(interaction);

    expect(interaction.calls.deferReply).toHaveBeenCalledOnce();
    expect(mocks.buildVerificationMessage).toHaveBeenCalledOnce();
    expect(interaction.calls.editReply).toHaveBeenCalledOnce();
  });
});
