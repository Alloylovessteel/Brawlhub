import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';

const ACTOR_ID = '111111111111111111';
const GUILD_ID = '123456789012345678';
const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLUB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHANNEL_ID = '999999999999999999';

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
    clubs: { getRegisteredClubs: vi.fn(), filterRegisteredClubs: vi.fn() },
    logsService: { addClubLog: vi.fn(), loadClubLogs: vi.fn(), removeClubLog: vi.fn() },
    logsEmbed: { buildClubLogsConfigEmbed: vi.fn() },
    permissions: { getInteractionMemberRoleIds: vi.fn() },
  };
});

vi.mock('../admin/service', () => ({
  ...mocks.adminService,
  AdminServiceError: mocks.AdminServiceError,
}));
vi.mock('../admin/errors', () => mocks.adminErrors);
vi.mock('../clubs/service', () => mocks.clubs);
vi.mock('../clubs/logs/service', () => mocks.logsService);
vi.mock('../clubs/logs/embed', () => mocks.logsEmbed);
vi.mock('../discord/permissions.js', () => mocks.permissions);

import {
  clubLogsCommandData,
  handleClubLogs,
  handleClubLogsAutocomplete,
  handleClubLogsComponent,
} from './clublogs';

function actor() {
  return { profileId: PROFILE_ID, discordUserId: ACTOR_ID, globalRole: 'admin' as const };
}

function forbidden(): InstanceType<typeof mocks.AdminServiceError> {
  return new mocks.AdminServiceError('forbidden', 'You do not have permission.');
}

function chat(subcommand: string, options: Record<string, unknown> = {}): ChatInputCommandInteraction {
  const interaction = {
    user: { id: ACTOR_ID, username: 'actor' },
    guildId: GUILD_ID,
    guild: { id: GUILD_ID, name: 'Test Guild', ownerId: '222222222222222222' },
    member: null,
    memberPermissions: null,
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getString: vi.fn((name: string) => options[name] ?? null),
      getChannel: vi.fn(() => ({ id: CHANNEL_ID })),
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

function autocomplete(value = ''): AutocompleteInteraction {
  return {
    user: { id: ACTOR_ID, username: 'actor' },
    guildId: GUILD_ID,
    guild: { id: GUILD_ID, ownerId: '222222222222222222' },
    member: null,
    memberPermissions: null,
    options: { getFocused: vi.fn(() => ({ name: 'club', value })) },
    respond: vi.fn(async () => undefined),
  } as unknown as AutocompleteInteraction;
}

function payload(interaction: ChatInputCommandInteraction, method: 'editReply' | 'reply'): Record<string, unknown> {
  return (interaction[method] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
}

function choices(interaction: AutocompleteInteraction): unknown {
  return (interaction.respond as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
}

beforeEach(() => {
  mocks.adminService.requireGlobalPermission.mockReset();
  mocks.adminService.requireGlobalPermission.mockResolvedValue(actor());
  mocks.adminErrors.replyAdminError.mockReset();
  mocks.adminErrors.replyAdminError.mockImplementation(async (interaction: ChatInputCommandInteraction, error: unknown) => {
    await interaction.editReply({ content: error instanceof Error ? error.message : 'Unexpected error' });
  });
  mocks.clubs.getRegisteredClubs.mockReset();
  mocks.clubs.getRegisteredClubs.mockResolvedValue([]);
  mocks.clubs.filterRegisteredClubs.mockReset();
  mocks.clubs.filterRegisteredClubs.mockReturnValue([]);
  mocks.logsService.addClubLog.mockReset();
  mocks.logsService.addClubLog.mockResolvedValue([]);
  mocks.logsService.loadClubLogs.mockReset();
  mocks.logsService.loadClubLogs.mockResolvedValue([]);
  mocks.logsService.removeClubLog.mockReset();
  mocks.logsService.removeClubLog.mockResolvedValue([]);
  mocks.logsEmbed.buildClubLogsConfigEmbed.mockReset();
  mocks.logsEmbed.buildClubLogsConfigEmbed.mockReturnValue({ kind: 'club-logs-config' });
  mocks.permissions.getInteractionMemberRoleIds.mockReset();
  mocks.permissions.getInteractionMemberRoleIds.mockReturnValue(null);
});

describe('/clublogs command data', () => {
  it('registers add, remove and list with the expected options', () => {
    const json = clubLogsCommandData.toJSON() as unknown as {
      name: string;
      options: Array<{ name: string; options?: Array<Record<string, unknown>> }>;
    };

    expect(json.name).toBe('clublogs');
    expect(json.options.map((option) => option.name)).toEqual(['add', 'remove', 'list']);
    const add = json.options[0]?.options ?? [];
    expect(add[0]).toMatchObject({ name: 'club', autocomplete: true, required: true });
    expect(add[1]).toMatchObject({ name: 'channel', required: true, channel_types: [0] });
    expect(json.options[1]?.options?.[0]).toMatchObject({
      name: 'club',
      autocomplete: true,
      required: true,
    });
    expect(json.options[2]?.options ?? []).toHaveLength(0);
  });
});

describe('/clublogs permission gating', () => {
  it('defers ephemerally and denies users without clubs:write', async () => {
    mocks.adminService.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const interaction = chat('list');

    await handleClubLogs(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(mocks.adminService.requireGlobalPermission).toHaveBeenCalledWith(
      ACTOR_ID,
      'clubs:write',
      expect.objectContaining({ guildId: GUILD_ID }),
    );
    expect(mocks.logsService.loadClubLogs).not.toHaveBeenCalled();
    expect(payload(interaction, 'editReply').content).toContain('permission');
    expect(mocks.adminErrors.replyAdminError).not.toHaveBeenCalled();
  });
});

describe('/clublogs configuration', () => {
  it('adds a club log and replies with the updated configuration embed', async () => {
    const interaction = chat('add', { club: CLUB_ID });

    await handleClubLogs(interaction);

    expect(mocks.logsService.addClubLog).toHaveBeenCalledWith({
      actor: actor(),
      guildId: GUILD_ID,
      clubId: CLUB_ID,
      channelId: CHANNEL_ID,
    });
    expect(mocks.logsEmbed.buildClubLogsConfigEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: GUILD_ID, notice: expect.stringContaining(CHANNEL_ID) }),
    );
    expect(payload(interaction, 'editReply').embeds).toEqual([{ kind: 'club-logs-config' }]);
  });

  it('lists only this guild’s logs', async () => {
    const interaction = chat('list');

    await handleClubLogs(interaction);

    expect(mocks.logsService.loadClubLogs).toHaveBeenCalledWith(GUILD_ID);
    expect(mocks.logsEmbed.buildClubLogsConfigEmbed).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      logs: [],
    });
  });
});

describe('/clublogs autocomplete', () => {
  it('requires permission and suggests this guild’s active clubs by UUID', async () => {
    const club = { id: CLUB_ID, tag: 'ALPHA', name: 'Alpha' };
    mocks.clubs.getRegisteredClubs.mockResolvedValue([club]);
    mocks.clubs.filterRegisteredClubs.mockReturnValue([club]);
    const interaction = autocomplete('alp');

    await handleClubLogsAutocomplete(interaction);

    expect(mocks.adminService.requireGlobalPermission).toHaveBeenCalledWith(
      ACTOR_ID,
      'clubs:write',
      expect.objectContaining({ guildId: GUILD_ID }),
    );
    expect(mocks.clubs.getRegisteredClubs).toHaveBeenCalledWith(GUILD_ID);
    expect(choices(interaction)).toEqual([{ name: 'Alpha (#ALPHA)', value: CLUB_ID }]);
  });

  it('returns no choices to users without permission', async () => {
    mocks.adminService.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const interaction = autocomplete();

    await handleClubLogsAutocomplete(interaction);

    expect(mocks.clubs.getRegisteredClubs).not.toHaveBeenCalled();
    expect(choices(interaction)).toEqual([]);
  });
});

describe('/clublogs components', () => {
  it('has no component handling', async () => {
    await expect(handleClubLogsComponent({} as never)).resolves.toBeUndefined();
  });
});
