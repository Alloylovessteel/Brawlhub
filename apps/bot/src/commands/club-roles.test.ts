import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction, Guild } from 'discord.js';

const GUILD_ID = '1488531664962326571';
const USER_ID = '983248496884875286';
const ROLE_ID = '111111111111111111';
const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const mocks = vi.hoisted(() => ({
  adminService: { requireGlobalPermission: vi.fn() },
  adminErrors: { replyAdminError: vi.fn() },
  permissions: { getInteractionMemberRoleIds: vi.fn() },
  service: {
    CLUB_ROLE_RANKS: ['president', 'vicePresident', 'senior'],
    clubRoleLabel: vi.fn((rank: string) => rank),
    loadGuildClubRoleState: vi.fn(),
    ensureClubRoles: vi.fn(),
    saveGuildClubRoleMapping: vi.fn(),
    refreshGuildClubRoles: vi.fn(),
    refreshMemberClubRoles: vi.fn(),
  },
}));

vi.mock('../admin/service', () => mocks.adminService);
vi.mock('../admin/errors', () => mocks.adminErrors);
vi.mock('../discord/permissions.js', () => mocks.permissions);
vi.mock('../club-roles/service.js', () => mocks.service);

import { clubRolesCommandData, handleClubRoles } from './club-roles.js';

function actor() {
  return { profileId: PROFILE_ID, discordUserId: USER_ID, globalRole: 'admin' as const };
}

function chat(
  subcommand: string,
  options: Record<string, unknown> = {},
): ChatInputCommandInteraction {
  const guild = { id: GUILD_ID, ownerId: '222222222222222222' } as unknown as Guild;
  const interaction = {
    user: { id: USER_ID, username: 'actor' },
    guildId: GUILD_ID,
    guild,
    member: null,
    memberPermissions: null,
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getString: vi.fn((name: string) => options[name] ?? null),
      getRole: vi.fn((name: string) => options[name] ?? null),
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

const refreshResult = {
  configured: true,
  planned: 2,
  processed: 2,
  membersNotFound: 0,
  cleanedMembers: 1,
};

beforeEach(() => {
  mocks.service.clubRoleLabel.mockReset();
  mocks.service.clubRoleLabel.mockImplementation(
    (rank: string) =>
      ({ president: 'President', vicePresident: 'Vice President', senior: 'Senior' })[rank] ?? rank,
  );
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
  mocks.service.loadGuildClubRoleState.mockReset();
  mocks.service.loadGuildClubRoleState.mockResolvedValue({ guildId: GUILD_ID, mapping: {} });
  mocks.service.ensureClubRoles.mockReset();
  mocks.service.ensureClubRoles.mockResolvedValue({ president: ROLE_ID });
  mocks.service.saveGuildClubRoleMapping.mockReset();
  mocks.service.saveGuildClubRoleMapping.mockImplementation(
    async ({ mapping }: { mapping: Record<string, string> }) => ({
      guildId: GUILD_ID,
      mapping,
    }),
  );
  mocks.service.refreshGuildClubRoles.mockReset();
  mocks.service.refreshGuildClubRoles.mockResolvedValue(refreshResult);
  mocks.service.refreshMemberClubRoles.mockReset();
  mocks.service.refreshMemberClubRoles.mockResolvedValue({ kind: 'ok', rank: 'president' });
});

describe('/club-roles command data', () => {
  it('registers view, setup, set, clear, refresh and me', () => {
    const json = clubRolesCommandData.toJSON() as unknown as {
      name: string;
      options: Array<{ name: string }>;
    };
    expect(json.name).toBe('club-roles');
    expect(json.options.map((option) => option.name)).toEqual([
      'view',
      'setup',
      'set',
      'clear',
      'refresh',
      'me',
    ]);
  });
});

describe('/club-roles read commands', () => {
  it('views only the current guild’s mapping without requiring staff permission', async () => {
    const interaction = chat('view');

    await handleClubRoles(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith();
    expect(mocks.adminService.requireGlobalPermission).not.toHaveBeenCalled();
    expect(mocks.service.loadGuildClubRoleState).toHaveBeenCalledWith(GUILD_ID);
    expect(payload(interaction).embeds).toBeTypeOf('object');
  });

  it('refreshes only the invoking user’s own role', async () => {
    const interaction = chat('me');

    await handleClubRoles(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(mocks.adminService.requireGlobalPermission).not.toHaveBeenCalled();
    expect(mocks.service.refreshMemberClubRoles).toHaveBeenCalledWith(expect.anything(), USER_ID);
    expect(payload(interaction).content).toContain('President');
  });
});

describe('/club-roles configuration commands', () => {
  it('sets one rank and refreshes without a second audit', async () => {
    const interaction = chat('set', {
      rank: 'senior',
      role: { id: ROLE_ID, managed: false },
    });

    await handleClubRoles(interaction);

    expect(mocks.adminService.requireGlobalPermission).toHaveBeenCalledWith(
      USER_ID,
      'clubs:write',
      expect.objectContaining({ guildId: GUILD_ID }),
    );
    expect(mocks.service.saveGuildClubRoleMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: GUILD_ID,
        mapping: { senior: ROLE_ID },
        actor: actor(),
      }),
    );
    expect(mocks.service.refreshGuildClubRoles).toHaveBeenCalledWith(expect.anything(), {
      actor: null,
    });
  });

  it('rejects integration-managed roles', async () => {
    const interaction = chat('set', {
      rank: 'senior',
      role: { id: ROLE_ID, managed: true },
    });

    await handleClubRoles(interaction);

    expect(mocks.service.saveGuildClubRoleMapping).not.toHaveBeenCalled();
    expect(payload(interaction).content).toContain('Integration-managed');
  });

  it('audits a manual full refresh', async () => {
    const interaction = chat('refresh');

    await handleClubRoles(interaction);

    expect(mocks.service.refreshGuildClubRoles).toHaveBeenCalledWith(expect.anything(), {
      actor: actor(),
    });
    expect(JSON.stringify(payload(interaction).embeds)).toContain('Stale roles cleared');
  });

  it('creates or reuses roles during setup and refreshes the guild', async () => {
    const interaction = chat('setup');

    await handleClubRoles(interaction);

    expect(mocks.service.ensureClubRoles).toHaveBeenCalledWith(expect.anything(), {});
    expect(mocks.service.saveGuildClubRoleMapping).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'guild.club_roles.setup' }),
    );
    expect(mocks.service.refreshGuildClubRoles).toHaveBeenCalled();
  });
});
