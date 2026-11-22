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
    logsService: {
      addClubLog: vi.fn(),
      loadClubLogs: vi.fn(),
      loadRecentClubLogEvents: vi.fn(),
      removeClubLog: vi.fn(),
    },
    logsEmbed: { buildClubLogsConfigEmbed: vi.fn() },
    pageView: {
      CLUB_LOG_PERIOD_LABELS: { today: 'Today', week: 'This Week', season: 'This Season' },
      isClubLogPeriod: vi.fn((value: string) => ['today', 'week', 'season'].includes(value)),
      loadClubLogView: vi.fn(),
    },
    image: { buildClubLogPageImage: vi.fn() },
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
vi.mock('../clubs/logs/page-view', () => mocks.pageView);
vi.mock('../clubs/logs/image', () => mocks.image);
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

function payload(
  interaction: ChatInputCommandInteraction,
  method: 'editReply' | 'reply' | 'followUp',
): Record<string, unknown> {
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
  mocks.logsService.loadRecentClubLogEvents.mockReset();
  mocks.logsService.loadRecentClubLogEvents.mockResolvedValue([]);
  mocks.logsService.removeClubLog.mockReset();
  mocks.logsService.removeClubLog.mockResolvedValue([]);
  mocks.logsEmbed.buildClubLogsConfigEmbed.mockReset();
  mocks.logsEmbed.buildClubLogsConfigEmbed.mockReturnValue({ kind: 'club-logs-config' });
  mocks.pageView.loadClubLogView.mockReset();
  mocks.pageView.loadClubLogView.mockResolvedValue({
    kind: 'ok',
    value: {
      club: {
        id: CLUB_ID,
        tag: 'ALPHA',
        name: 'Alpha',
        description: null,
        trophies: null,
        requiredTrophies: null,
        memberCount: null,
        lastSyncedAt: null,
      },
      period: 'today',
      rows: [],
      unavailable: 0,
      latestSnapshotAt: null,
      latestSyncAt: null,
    },
  });
  mocks.image.buildClubLogPageImage.mockReset();
  mocks.image.buildClubLogPageImage.mockResolvedValue(Buffer.from('fake-png'));
  mocks.permissions.getInteractionMemberRoleIds.mockReset();
  mocks.permissions.getInteractionMemberRoleIds.mockReturnValue(null);
});

describe('/clubs clublogs command data', () => {
  it('registers add, remove, list and preview with the expected options', () => {
    const json = clubLogsCommandData.toJSON() as unknown as {
      name: string;
      options: Array<{ name: string; options?: Array<Record<string, unknown>> }>;
    };

    expect(json.name).toBe('clublogs');
    expect(json.options.map((option) => option.name)).toEqual(['add', 'remove', 'list', 'preview']);
    const add = json.options[0]?.options ?? [];
    expect(add[0]).toMatchObject({ name: 'club', autocomplete: true, required: true });
    expect(add[1]).toMatchObject({ name: 'channel', required: true, channel_types: [0] });
    expect(json.options[1]?.options?.[0]).toMatchObject({
      name: 'club',
      autocomplete: true,
      required: true,
    });
    expect(json.options[2]?.options ?? []).toHaveLength(0);
    const preview = json.options[3]?.options ?? [];
    expect(preview[0]).toMatchObject({ name: 'club', autocomplete: true, required: true });
    expect(preview[1]).toMatchObject({ name: 'period' });
    expect((preview[1]?.['choices'] as unknown[] | undefined)?.length).toBe(3);
  });
});

describe('/clubs clublogs permission gating', () => {
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

describe('/clubs clublogs configuration', () => {
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

describe('/clubs clublogs preview', () => {
  const configuredLog = {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    guildId: GUILD_ID,
    clubId: CLUB_ID,
    clubTag: 'ALPHA',
    clubName: 'Alpha',
    channelId: CHANNEL_ID,
  };

  it('posts a public PNG follow-up with no components and a private acknowledgement', async () => {
    mocks.logsService.loadClubLogs.mockResolvedValue([configuredLog]);
    mocks.logsService.loadRecentClubLogEvents.mockResolvedValue([
      {
        log: configuredLog,
        events: [
          {
            kind: 'membership',
            id: 'm1',
            clubId: CLUB_ID,
            playerTag: 'PLAYER',
            playerName: 'Player',
            description: '#PLAYER joined',
            detectedAt: '2026-11-21T08:00:00.000Z',
          },
        ],
      },
    ]);
    const interaction = chat('preview', { club: CLUB_ID, period: 'today' });

    await handleClubLogs(interaction);

    expect(mocks.pageView.loadClubLogView).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      tag: 'ALPHA',
      period: 'today',
    });
    expect(mocks.logsService.loadRecentClubLogEvents).toHaveBeenCalledWith(GUILD_ID, configuredLog.id);
    expect(mocks.image.buildClubLogPageImage).toHaveBeenCalledWith(
      expect.objectContaining({ club: expect.objectContaining({ tag: 'ALPHA' }) }),
      expect.arrayContaining([expect.objectContaining({ id: 'm1' })]),
    );
    const followUp = payload(interaction, 'followUp');
    expect(followUp['content']).toBe('Alpha • Club Logs / Trophy Progression / Today');
    expect(followUp['allowedMentions']).toEqual({ parse: [] });
    expect(followUp['components']).toBeUndefined();
    const files = followUp['files'] as Array<{ name: string }>;
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('club-log-preview-alpha.png');
    const acknowledgement = payload(interaction, 'editReply');
    expect(acknowledgement['content']).toContain('preview posted publicly');
    expect(acknowledgement['components']).toEqual([]);
  });

  it('rejects a club without a log configured in this guild', async () => {
    const interaction = chat('preview', { club: CLUB_ID });

    await handleClubLogs(interaction);

    expect(mocks.pageView.loadClubLogView).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(payload(interaction, 'editReply').content).toContain('not configured');
  });

  it('does not add components on a stored-data lookup failure', async () => {
    mocks.logsService.loadClubLogs.mockResolvedValue([configuredLog]);
    mocks.pageView.loadClubLogView.mockResolvedValue({ kind: 'no-default' });
    const interaction = chat('preview', { club: CLUB_ID });

    await handleClubLogs(interaction);

    const acknowledgement = payload(interaction, 'editReply');
    expect(acknowledgement['components']).toEqual([]);
    expect(interaction.followUp).not.toHaveBeenCalled();
  });
});

describe('/clubs clublogs autocomplete', () => {
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

describe('/clubs clublogs components', () => {
  it('has no component handling', async () => {
    await expect(handleClubLogsComponent({} as never)).resolves.toBeUndefined();
  });
});
