import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';

const ACTOR_ID = '111111111111111111';
const OTHER_ID = '999999999999999999';
const GUILD_ID = '123456789012345678';
const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLUB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHANNEL_ID = '222222222222222222';
const ROLE_ID = '333333333333333333';

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
    config: {
      getBotConfig: vi.fn(),
    },
    service: {
      requireGlobalPermission: vi.fn(),
      loadGuildSettings: vi.fn(),
      updateGuildSettings: vi.fn(),
      recordAdminAudit: vi.fn(),
      recordSyncRunAudit: vi.fn(),
      loadSyncRun: vi.fn(),
      loadSyncStatus: vi.fn(),
      listAuditLogs: vi.fn(),
    },
    embeds: {
      buildClubRegistrationPreviewEmbed: vi.fn(),
      buildClubRegisteredEmbed: vi.fn(),
      buildSyncResultEmbed: vi.fn(),
      buildSyncStatusEmbed: vi.fn(),
      buildSettingsViewEmbed: vi.fn(),
      buildSettingsUpdatedEmbed: vi.fn(),
      buildAuditPageEmbed: vi.fn(),
      buildClubRemovalUnavailableEmbed: vi.fn(),
    },
    sync: {
      previewClubRegistration: vi.fn(),
      registerClubs: vi.fn(),
    },
    clubs: {
      getRegisteredClubs: vi.fn(),
      filterRegisteredClubs: vi.fn(),
    },
    guard: {
      runManagedSync: vi.fn(),
    },
    rateLimit: {
      checkBotRateLimit: vi.fn(),
      clearBotRateLimits: vi.fn(),
    },
  };
});

vi.mock('../config', () => mocks.config);
vi.mock('../admin/service', () => ({
  ...mocks.service,
  AdminServiceError: mocks.AdminServiceError,
}));
vi.mock('../admin/embed', () => mocks.embeds);
vi.mock('@brawlhub/sync', () => mocks.sync);
vi.mock('../clubs/service', () => mocks.clubs);
vi.mock('../sync/guard', () => mocks.guard);
vi.mock('../discord/rate-limit', () => mocks.rateLimit);

import {
  auditCommandData,
  handleAudit,
  handleAuditComponent,
} from './audit';
import {
  clearPendingClubRegistrations,
  handleRegisterClub,
  handleRegisterClubComponent,
  registerClubCommandData,
} from './register-club';
import {
  handleRemoveClub,
  handleRemoveClubAutocomplete,
  removeClubCommandData,
} from './remove-club';
import {
  clearPendingSettingsChanges,
  handleSettings,
  handleSettingsAutocomplete,
  handleSettingsComponent,
  settingsCommandData,
} from './settings';
import { handleSync, syncCommandData } from './sync';
import { handleSyncStatus, syncStatusCommandData } from './sync-status';

function actor(globalRole: 'owner' | 'admin' | 'staff' | 'member' | null = 'admin') {
  return { profileId: PROFILE_ID, discordUserId: ACTOR_ID, globalRole };
}

function preview() {
  return {
    tag: '2UG9',
    name: 'Alpha',
    description: 'A club',
    trophies: 100,
    memberCount: 20,
    guildId: GUILD_ID,
  };
}

function settings() {
  return {
    guildId: GUILD_ID,
    primaryClubId: CLUB_ID,
    primaryClubTag: '2UG9',
    primaryClubName: 'Alpha',
    announcementChannelId: null,
    verifiedRoleId: null,
    updatedAt: '2026-11-18T00:00:00.000Z',
  };
}

function syncResult(overrides: Record<string, unknown> = {}) {
  return {
    syncRunId: 'run-1',
    status: 'completed',
    clubsProcessed: 1,
    playersUpserted: 2,
    snapshotsWritten: 3,
    membershipEvents: 4,
    notificationsSent: 0,
    error: undefined,
    affectedClubIds: [CLUB_ID],
    ...overrides,
  };
}

function syncRun() {
  return {
    id: 'run-1',
    status: 'completed',
    periodStart: '2026-11-18T00:00:00.000Z',
    startedAt: '2026-11-18T00:00:01.000Z',
    finishedAt: '2026-11-18T00:05:00.000Z',
    error: null,
    lastError: null,
    recordsProcessed: 10,
    affectedClubIds: [CLUB_ID],
    clubTags: ['2UG9'],
  };
}

function auditEntries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `entry-${index}`,
    actorProfileId: PROFILE_ID,
    actorLabel: '<@111111111111111111>',
    action: 'club.registered',
    targetType: 'club',
    targetId: '2UG9',
    details: { clubTag: '2UG9' },
    createdAt: '2026-11-18T00:00:00.000Z',
  }));
}

function chat(subcommand: string | null, options: Record<string, unknown> = {}, userId = ACTOR_ID) {
  const interaction = {
    user: { id: userId },
    guildId: GUILD_ID,
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getString: vi.fn((name: string) => options[name] ?? null),
      getChannel: vi.fn((name: string) => options[name] ?? null),
      getRole: vi.fn((name: string) => options[name] ?? null),
      getFocused: vi.fn(),
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

function button(customId: string, userId = ACTOR_ID) {
  const interaction = {
    customId,
    user: { id: userId },
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

function autocomplete(name: string, value: string, userId = ACTOR_ID) {
  return {
    user: { id: userId },
    guildId: GUILD_ID,
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

function buttons(reply: any): Array<{ data: { custom_id: string } }> {
  return reply.components[0].components as Array<{ data: { custom_id: string } }>;
}

function forbidden(): InstanceType<typeof mocks.AdminServiceError> {
  return new mocks.AdminServiceError('forbidden', 'You do not have permission.');
}

beforeEach(() => {
  clearPendingClubRegistrations();
  clearPendingSettingsChanges();
  mocks.rateLimit.clearBotRateLimits();

  mocks.config.getBotConfig.mockReturnValue({ guildId: GUILD_ID });
  mocks.service.requireGlobalPermission.mockReset();
  mocks.service.requireGlobalPermission.mockResolvedValue(actor());
  mocks.service.loadGuildSettings.mockReset();
  mocks.service.loadGuildSettings.mockResolvedValue(settings());
  mocks.service.updateGuildSettings.mockReset();
  mocks.service.updateGuildSettings.mockResolvedValue(settings());
  mocks.service.recordAdminAudit.mockReset();
  mocks.service.recordAdminAudit.mockResolvedValue(undefined);
  mocks.service.recordSyncRunAudit.mockReset();
  mocks.service.recordSyncRunAudit.mockResolvedValue(undefined);
  mocks.service.loadSyncRun.mockReset();
  mocks.service.loadSyncRun.mockResolvedValue(syncRun());
  mocks.service.loadSyncStatus.mockReset();
  mocks.service.loadSyncStatus.mockResolvedValue({
    latestRun: syncRun(),
    lock: { scope: 'all-clubs', lockedBy: null, lockedAt: null, lockedUntil: null, active: false },
    generatedAt: new Date(),
  });
  mocks.service.listAuditLogs.mockReset();
  mocks.service.listAuditLogs.mockResolvedValue({
    entries: auditEntries(7),
    generatedAt: new Date(),
  });

  for (const [name, embed] of Object.entries(mocks.embeds)) {
    embed.mockReset();
    embed.mockReturnValue({ kind: name });
  }
  mocks.embeds.buildClubRegistrationPreviewEmbed.mockReturnValue({ kind: 'preview' });
  mocks.embeds.buildClubRegisteredEmbed.mockReturnValue({ kind: 'registered' });
  mocks.embeds.buildSyncResultEmbed.mockReturnValue({ kind: 'sync-result' });
  mocks.embeds.buildSyncStatusEmbed.mockReturnValue({ kind: 'sync-status' });
  mocks.embeds.buildSettingsViewEmbed.mockReturnValue({ kind: 'settings-view' });
  mocks.embeds.buildSettingsUpdatedEmbed.mockReturnValue({ kind: 'settings-updated' });
  mocks.embeds.buildAuditPageEmbed.mockReturnValue({ kind: 'audit-page' });
  mocks.embeds.buildClubRemovalUnavailableEmbed.mockReturnValue({ kind: 'remove-unavailable' });

  mocks.sync.previewClubRegistration.mockReset();
  mocks.sync.previewClubRegistration.mockResolvedValue(preview());
  mocks.sync.registerClubs.mockReset();
  mocks.sync.registerClubs.mockResolvedValue({ registered: 1, rejected: [] });

  mocks.clubs.getRegisteredClubs.mockReset();
  mocks.clubs.getRegisteredClubs.mockResolvedValue([{ id: CLUB_ID, tag: '2UG9', name: 'Alpha' }]);
  mocks.clubs.filterRegisteredClubs.mockReset();
  mocks.clubs.filterRegisteredClubs.mockImplementation((clubs: unknown) => clubs as never);

  mocks.guard.runManagedSync.mockReset();
  mocks.guard.runManagedSync.mockResolvedValue({ kind: 'ran', results: [syncResult()] });

  mocks.rateLimit.checkBotRateLimit.mockReset();
  mocks.rateLimit.checkBotRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
});

describe('/register-club', () => {
  it('validates and previews official club data without registering', async () => {
    const interaction = chat(null, { tag: '#2ug9' });

    await handleRegisterClub(interaction);

    expect(mocks.sync.previewClubRegistration).toHaveBeenCalledWith('#2ug9', GUILD_ID);
    expect(mocks.sync.registerClubs).not.toHaveBeenCalled();
    const reply = payload(interaction, 'reply');
    expect(reply.ephemeral).toBe(true);
    expect(buttons(reply)).toHaveLength(2);
  });

  it('rejects unauthorized users before the API call', async () => {
    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const interaction = chat(null, { tag: '2UG9' });

    await handleRegisterClub(interaction);

    expect(mocks.sync.previewClubRegistration).not.toHaveBeenCalled();
    expect(payload(interaction, 'reply').content).toContain('permission');
  });

  it('reports API failures without creating a club', async () => {
    mocks.sync.previewClubRegistration.mockRejectedValueOnce(new Error('API unavailable'));
    const interaction = chat(null, { tag: '2UG9' });

    await handleRegisterClub(interaction);

    expect(payload(interaction, 'reply').content).toContain('could not validate');
    expect(mocks.sync.registerClubs).not.toHaveBeenCalled();
  });

  it('registers on confirmation and records the actor', async () => {
    const start = chat(null, { tag: '2UG9' });
    await handleRegisterClub(start);
    const confirmId = buttons(payload(start, 'reply'))[0]!.data.custom_id;

    const confirmation = button(confirmId);
    await handleRegisterClubComponent(confirmation);

    expect(mocks.sync.registerClubs).toHaveBeenCalledWith(['2UG9'], GUILD_ID);
    expect(mocks.service.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: actor(),
        action: 'club.registered',
        targetId: '2UG9',
      }),
    );
    expect(payload(confirmation, 'editReply').embeds).toEqual([{ kind: 'registered' }]);
  });

  it('still reports a successful registration if audit logging fails', async () => {
    mocks.service.recordAdminAudit.mockRejectedValueOnce(
      new mocks.AdminServiceError('audit_failed', 'Audit logging failed.'),
    );
    const start = chat(null, { tag: '2UG9' });
    await handleRegisterClub(start);
    const confirmId = buttons(payload(start, 'reply'))[0]!.data.custom_id;

    const confirmation = button(confirmId);
    await handleRegisterClubComponent(confirmation);

    expect(payload(confirmation, 'editReply')).toMatchObject({
      content: expect.stringContaining('audit logging failed'),
      embeds: [{ kind: 'registered' }],
    });
  });

  it('prevents replay of a confirmation', async () => {
    const start = chat(null, { tag: '2UG9' });
    await handleRegisterClub(start);
    const confirmId = buttons(payload(start, 'reply'))[0]!.data.custom_id;

    await handleRegisterClubComponent(button(confirmId));
    const replay = button(confirmId);
    await handleRegisterClubComponent(replay);

    expect(mocks.sync.registerClubs).toHaveBeenCalledOnce();
    expect(payload(replay, 'followUp').content).toContain('no longer valid');
  });

  it('rejects a confirmation pressed by another user', async () => {
    const start = chat(null, { tag: '2UG9' });
    await handleRegisterClub(start);
    const confirmId = buttons(payload(start, 'reply'))[0]!.data.custom_id;

    const wrongActor = button(confirmId, OTHER_ID);
    await handleRegisterClubComponent(wrongActor);

    expect(mocks.sync.registerClubs).not.toHaveBeenCalled();
    expect(payload(wrongActor, 'followUp').content).toContain('another user');
  });

  it('reports duplicate registration without writing an audit event', async () => {
    mocks.sync.registerClubs.mockResolvedValueOnce({
      registered: 0,
      rejected: [{ tag: '2UG9', reason: 'Club is already registered' }],
    });
    const start = chat(null, { tag: '2UG9' });
    await handleRegisterClub(start);
    const confirmId = buttons(payload(start, 'reply'))[0]!.data.custom_id;

    const confirmation = button(confirmId);
    await handleRegisterClubComponent(confirmation);

    expect(payload(confirmation, 'editReply').content).toContain('already registered');
    expect(mocks.service.recordAdminAudit).not.toHaveBeenCalled();
  });
});

describe('/sync', () => {
  it('registers with the expected command name', () => {
    expect(syncCommandData.toJSON().name).toBe('sync');
  });

  it('rejects unauthorized users', async () => {
    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const interaction = chat(null);

    await handleSync(interaction);

    expect(mocks.guard.runManagedSync).not.toHaveBeenCalled();
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(payload(interaction, 'editReply').content).toContain('permission');
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('enforces the existing three-per-minute rate limit', async () => {
    mocks.rateLimit.checkBotRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 12 });
    const interaction = chat(null);

    await handleSync(interaction);

    expect(mocks.guard.runManagedSync).not.toHaveBeenCalled();
    expect(payload(interaction, 'editReply').content).toContain('12 second');
  });

  it('refuses an overlapping sync run', async () => {
    mocks.guard.runManagedSync.mockResolvedValueOnce({ kind: 'overlap' });
    const interaction = chat(null);

    await handleSync(interaction);

    expect(payload(interaction, 'editReply').content).toContain('already running');
    expect(mocks.service.recordSyncRunAudit).not.toHaveBeenCalled();
  });

  it('reports failed partial results with stored timestamps', async () => {
    const failed = syncResult({
      status: 'failed',
      clubsProcessed: 2,
      error: 'API timeout',
    });
    mocks.guard.runManagedSync.mockResolvedValueOnce({ kind: 'ran', results: [failed] });
    const interaction = chat(null);

    await handleSync(interaction);

    expect(mocks.service.recordSyncRunAudit).toHaveBeenCalledWith(actor(), failed);
    expect(mocks.service.loadSyncRun).toHaveBeenCalledWith('run-1');
    expect(mocks.embeds.buildSyncResultEmbed).toHaveBeenCalledWith(failed, syncRun());
    expect(payload(interaction, 'editReply').embeds).toEqual([{ kind: 'sync-result' }]);
  });
});

describe('/sync-status', () => {
  it('uses stored sync data and requires permission', async () => {
    expect(syncStatusCommandData.toJSON().name).toBe('sync-status');
    const interaction = chat(null);

    await handleSyncStatus(interaction);

    expect(mocks.service.requireGlobalPermission).toHaveBeenCalledWith(ACTOR_ID, 'sync:run');
    expect(mocks.service.loadSyncStatus).toHaveBeenCalledOnce();
    expect(payload(interaction, 'reply').embeds).toEqual([{ kind: 'sync-status' }]);
  });

  it('rejects unauthorized readers', async () => {
    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const interaction = chat(null);

    await handleSyncStatus(interaction);

    expect(mocks.service.loadSyncStatus).not.toHaveBeenCalled();
  });
});

describe('/settings', () => {
  it('registers view and supported setting subcommands', () => {
    const json = settingsCommandData.toJSON() as any;
    expect(json.options.map((option: any) => option.name)).toEqual([
      'view',
      'set-primary-club',
      'clear-primary-club',
      'set-announcement-channel',
      'clear-announcement-channel',
      'set-verified-role',
      'clear-verified-role',
    ]);
  });

  it('rejects unauthorized viewers', async () => {
    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const interaction = chat('view');

    await handleSettings(interaction);

    expect(mocks.service.loadGuildSettings).not.toHaveBeenCalled();
    expect(payload(interaction, 'reply').content).toContain('permission');
  });

  it('views the configured guild settings', async () => {
    const interaction = chat('view');

    await handleSettings(interaction);

    expect(mocks.service.loadGuildSettings).toHaveBeenCalledWith(GUILD_ID);
    expect(payload(interaction, 'reply').embeds).toEqual([{ kind: 'settings-view' }]);
  });

  it('requires confirmation before changing a setting', async () => {
    const start = chat('set-primary-club', { club: CLUB_ID });
    await handleSettings(start);
    const confirmId = buttons(payload(start, 'reply'))[0]!.data.custom_id;

    expect(mocks.service.updateGuildSettings).not.toHaveBeenCalled();

    const confirmation = button(confirmId);
    await handleSettingsComponent(confirmation);

    expect(mocks.service.requireGlobalPermission).toHaveBeenCalledTimes(2);
    expect(mocks.service.updateGuildSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: GUILD_ID,
        field: 'primaryClubId',
        value: CLUB_ID,
      }),
    );
    expect(payload(confirmation, 'editReply').embeds).toEqual([{ kind: 'settings-updated' }]);
  });

  it('passes null to clear a supported setting', async () => {
    const start = chat('clear-announcement-channel');
    await handleSettings(start);
    const confirmId = buttons(payload(start, 'reply'))[0]!.data.custom_id;

    await handleSettingsComponent(button(confirmId));

    expect(mocks.service.updateGuildSettings).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'announcementChannelId', value: null }),
    );
  });

  it('shows validation errors from the settings service', async () => {
    mocks.service.updateGuildSettings.mockRejectedValueOnce(
      new mocks.AdminServiceError('invalid_club', 'That club is not registered with BrawlHub.'),
    );
    const start = chat('set-primary-club', { club: CLUB_ID });
    await handleSettings(start);
    const confirmId = buttons(payload(start, 'reply'))[0]!.data.custom_id;

    const confirmation = button(confirmId);
    await handleSettingsComponent(confirmation);

    expect(payload(confirmation, 'editReply').content).toContain('not registered');
  });

  it('prevents replay of a settings confirmation', async () => {
    const start = chat('set-verified-role', { role: { id: ROLE_ID } });
    await handleSettings(start);
    const confirmId = buttons(payload(start, 'reply'))[0]!.data.custom_id;

    await handleSettingsComponent(button(confirmId));
    const replay = button(confirmId);
    await handleSettingsComponent(replay);

    expect(mocks.service.updateGuildSettings).toHaveBeenCalledOnce();
    expect(payload(replay, 'editReply').content).toContain('no longer valid');
  });

  it('provides registered club autocomplete only to authorised users', async () => {
    const interaction = autocomplete('club', '2UG');

    await handleSettingsAutocomplete(interaction);

    expect((interaction.respond as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual([
      { name: 'Alpha (#2UG9)', value: CLUB_ID },
    ]);

    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const unauthorized = autocomplete('club', '2UG');
    await handleSettingsAutocomplete(unauthorized);
    expect((unauthorized.respond as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual([]);
  });
});

describe('/audit', () => {
  it('rejects users without audit:read', async () => {
    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const interaction = chat(null);

    await handleAudit(interaction);

    expect(mocks.service.listAuditLogs).not.toHaveBeenCalled();
  });

  it('checks audit:read and paginates stored entries', async () => {
    const interaction = chat(null);

    await handleAudit(interaction);

    expect(mocks.service.requireGlobalPermission).toHaveBeenCalledWith(ACTOR_ID, 'audit:read');
    expect(mocks.service.listAuditLogs).toHaveBeenCalledWith(200);
    const reply = payload(interaction, 'reply');
    expect(reply.ephemeral).toBe(true);
    expect(buttons(reply)[0]!.data.custom_id).toBe('audit:page:2');
  });

  it('rechecks permission on pagination buttons', async () => {
    const start = chat(null);
    await handleAudit(start);
    const nextId = buttons(payload(start, 'reply'))[0]!.data.custom_id;

    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const page = button(nextId);
    await handleAuditComponent(page);

    expect(payload(page, 'editReply').content).toContain('permission');
    expect(mocks.service.listAuditLogs).toHaveBeenCalledOnce();
  });

  it('renders the second page without mutating audit records', async () => {
    const page = button('audit:page:2');

    await handleAuditComponent(page);

    expect(mocks.service.listAuditLogs).toHaveBeenCalledWith(200);
    expect(payload(page, 'editReply').embeds).toEqual([{ kind: 'audit-page' }]);
    expect(mocks.service.recordAdminAudit).not.toHaveBeenCalled();
  });
});

describe('/remove-club blocker', () => {
  it('explains that safe archival is unavailable and performs no deletion', async () => {
    const interaction = chat(null, { club: CLUB_ID });

    await handleRemoveClub(interaction);

    expect(mocks.embeds.buildClubRemovalUnavailableEmbed).toHaveBeenCalledOnce();
    expect(payload(interaction, 'reply').embeds).toEqual([{ kind: 'remove-unavailable' }]);
    expect(mocks.service.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('requires permission for club autocomplete', async () => {
    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const interaction = autocomplete('club', '2UG');

    await handleRemoveClubAutocomplete(interaction);

    expect(mocks.clubs.getRegisteredClubs).not.toHaveBeenCalled();
    expect((interaction.respond as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual([]);
    expect(removeClubCommandData.toJSON().name).toBe('remove-club');
  });

  it('does not register a destructive component handler', () => {
    expect(auditCommandData.toJSON().name).toBe('audit');
    expect(registerClubCommandData.toJSON().name).toBe('register-club');
  });
});
