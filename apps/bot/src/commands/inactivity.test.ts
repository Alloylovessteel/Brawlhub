import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

const ACTOR_ID = '111111111111111111';
const GUILD_ID = '123456789012345678';
const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHANNEL_ID = '999999999999999999';
const OTHER_CHANNEL_ID = '888888888888888888';

const mocks = vi.hoisted(() => {
  class MockAdminServiceError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'AdminServiceError';
      this.code = code;
    }
  }
  return {
    AdminServiceError: MockAdminServiceError,
    adminService: { requireGlobalPermission: vi.fn() },
    adminErrors: { replyAdminError: vi.fn() },
    permissions: { getInteractionMemberRoleIds: vi.fn() },
    inactivity: {
      MIN_INACTIVITY_DAYS: 1,
      MAX_INACTIVITY_DAYS: 365,
      buildInactivitySettingsEmbed: vi.fn(),
      readInactivitySettings: vi.fn(),
      updateInactivitySettings: vi.fn(),
    },
  };
});

vi.mock('../admin/service', () => ({
  ...mocks.adminService,
  AdminServiceError: mocks.AdminServiceError,
}));
vi.mock('../admin/errors', () => mocks.adminErrors);
vi.mock('../discord/permissions.js', () => mocks.permissions);
vi.mock('../reports/inactivity.js', () => mocks.inactivity);

import { handleInactivity, inactivityCommandData } from './inactivity';

function actor() {
  return { profileId: PROFILE_ID, discordUserId: ACTOR_ID, globalRole: 'admin' as const };
}

function chat(subcommand: string, options: Record<string, unknown> = {}): ChatInputCommandInteraction {
  const interaction = {
    user: { id: ACTOR_ID, username: 'actor' },
    guildId: GUILD_ID,
    guild: { id: GUILD_ID, ownerId: '222222222222222222' },
    member: null,
    memberPermissions: null,
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getInteger: vi.fn((name: string) => options[name] ?? null),
      getChannel: vi.fn((name: string) =>
        options[name] === undefined ? null : { id: options[name] },
      ),
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

function payload(interaction: ChatInputCommandInteraction): Record<string, unknown> {
  return (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  mocks.adminService.requireGlobalPermission.mockReset();
  mocks.adminService.requireGlobalPermission.mockResolvedValue(actor());
  mocks.adminErrors.replyAdminError.mockReset();
  mocks.adminErrors.replyAdminError.mockImplementation(
    async (interaction: ChatInputCommandInteraction, error: unknown) => {
      await interaction.editReply({ content: error instanceof Error ? error.message : 'Unexpected' });
    },
  );
  mocks.permissions.getInteractionMemberRoleIds.mockReset();
  mocks.permissions.getInteractionMemberRoleIds.mockReturnValue(null);
  mocks.inactivity.buildInactivitySettingsEmbed.mockReset();
  mocks.inactivity.buildInactivitySettingsEmbed.mockReturnValue({ kind: 'inactivity-settings' });
  mocks.inactivity.readInactivitySettings.mockReset();
  mocks.inactivity.readInactivitySettings.mockResolvedValue({ days: null, channelId: null });
  mocks.inactivity.updateInactivitySettings.mockReset();
  mocks.inactivity.updateInactivitySettings.mockImplementation(
    async ({ days, channelId }: { days: number | null; channelId: string | null }) => ({
      days,
      channelId,
    }),
  );
});

describe('/inactivity command data', () => {
  it('registers view, set, clear-channel and disable with a 1-365 day option', () => {
    const json = inactivityCommandData.toJSON() as unknown as {
      name: string;
      options: Array<{ name: string; options?: Array<Record<string, unknown>> }>;
    };
    expect(json.name).toBe('inactivity');
    expect(json.options.map((option) => option.name)).toEqual([
      'view',
      'set',
      'clear-channel',
      'disable',
    ]);
    expect(json.options[1]?.options?.[0]).toMatchObject({
      name: 'days',
      required: true,
      min_value: 1,
      max_value: 365,
    });
  });
});

describe('/inactivity permission gating', () => {
  it('defers ephemerally and denies users without clubs:write', async () => {
    mocks.adminService.requireGlobalPermission.mockRejectedValueOnce(
      new mocks.AdminServiceError('forbidden', 'You do not have permission.'),
    );
    const interaction = chat('view');

    await handleInactivity(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(mocks.adminService.requireGlobalPermission).toHaveBeenCalledWith(
      ACTOR_ID,
      'clubs:write',
      expect.objectContaining({ guildId: GUILD_ID }),
    );
    expect(mocks.inactivity.readInactivitySettings).not.toHaveBeenCalled();
    expect(payload(interaction).content).toContain('permission');
    expect(mocks.adminErrors.replyAdminError).not.toHaveBeenCalled();
  });
});

describe('/inactivity configuration', () => {
  it('views only the current guild’s settings', async () => {
    mocks.inactivity.readInactivitySettings.mockResolvedValue({ days: 4, channelId: CHANNEL_ID });
    const interaction = chat('view');

    await handleInactivity(interaction);

    expect(mocks.inactivity.readInactivitySettings).toHaveBeenCalledWith(GUILD_ID);
    expect(mocks.inactivity.buildInactivitySettingsEmbed).toHaveBeenCalledWith(
      GUILD_ID,
      { days: 4, channelId: CHANNEL_ID },
    );
    expect(payload(interaction).embeds).toEqual([{ kind: 'inactivity-settings' }]);
  });

  it('sets a custom threshold and channel', async () => {
    const interaction = chat('set', { days: 4, channel: CHANNEL_ID });

    await handleInactivity(interaction);

    expect(mocks.inactivity.updateInactivitySettings).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      days: 4,
      channelId: CHANNEL_ID,
      actor: actor(),
    });
    expect(mocks.inactivity.buildInactivitySettingsEmbed).toHaveBeenCalledWith(
      GUILD_ID,
      { days: 4, channelId: CHANNEL_ID },
      expect.stringContaining('4+ day(s)'),
    );
  });

  it('preserves the existing channel when only the threshold changes', async () => {
    mocks.inactivity.readInactivitySettings.mockResolvedValue({
      days: 7,
      channelId: OTHER_CHANNEL_ID,
    });
    const interaction = chat('set', { days: 4 });

    await handleInactivity(interaction);

    expect(mocks.inactivity.updateInactivitySettings).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: OTHER_CHANNEL_ID, days: 4 }),
    );
  });

  it('clears the channel without disabling the report', async () => {
    mocks.inactivity.readInactivitySettings.mockResolvedValue({
      days: 4,
      channelId: CHANNEL_ID,
    });
    const interaction = chat('clear-channel');

    await handleInactivity(interaction);

    expect(mocks.inactivity.updateInactivitySettings).toHaveBeenCalledWith(
      expect.objectContaining({ days: 4, channelId: null }),
    );
  });

  it('disables the report without deleting the channel override', async () => {
    mocks.inactivity.readInactivitySettings.mockResolvedValue({
      days: 4,
      channelId: CHANNEL_ID,
    });
    const interaction = chat('disable');

    await handleInactivity(interaction);

    expect(mocks.inactivity.updateInactivitySettings).toHaveBeenCalledWith(
      expect.objectContaining({ days: null, channelId: CHANNEL_ID }),
    );
  });
});
