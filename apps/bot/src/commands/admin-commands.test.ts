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
      listGuildRoleMappings: vi.fn(),
      setGuildRoleMapping: vi.fn(),
      clearGuildRoleMapping: vi.fn(),
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
      buildRoleMappingsEmbed: vi.fn(),
      buildAuditPageEmbed: vi.fn(),
      buildClubRemovalUnavailableEmbed: vi.fn(),
      buildClubArchivePreviewEmbed: vi.fn(),
      buildClubArchivedEmbed: vi.fn(),
    },
    archival: {
      archiveGuildClub: vi.fn(),
    },
    sync: {
      previewClubRegistration: vi.fn(),
      registerClubs: vi.fn(),
      runSync: vi.fn(),
    },
    clubs: {
      getRegisteredClubs: vi.fn(),
      filterRegisteredClubs: vi.fn(),
    },
    guard: {
      runManagedSync: vi.fn(),
    },
    overview: {
      refreshOverviewNow: vi.fn(),
    },
    clubLogs: {
      refreshTodayClubLogDigest: vi.fn(),
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
vi.mock('../clubs/archival', () => mocks.archival);
vi.mock('../clubs/overview/service', () => mocks.overview);
vi.mock('../clubs/logs/poster', () => mocks.clubLogs);
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
  clearPendingClubArchives,
  handleRemoveClub,
  handleRemoveClubAutocomplete,
  handleRemoveClubComponent,
  removeClubCommandData,
} from './remove-club';
import {
  clearPendingSettingsChanges,
  handleSettings,
  handleSettingsComponent,
  settingsCommandData,
} from './settings';
import { handleSync, syncCommandData } from './sync';
import { handleSyncStatus } from './sync-status';

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
    announcementChannelId: null,
    verifiedRoleId: null,
    overviewChannelId: null,
    overviewMessageId: null,
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
    guild: { name: 'Test Guild', iconURL: vi.fn(() => 'https://example.test/icon.png') },
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
    guildId: GUILD_ID,
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
  clearPendingClubArchives();
  clearPendingSettingsChanges();
  mocks.rateLimit.clearBotRateLimits();

  mocks.config.getBotConfig.mockReturnValue({ guildId: GUILD_ID });
  mocks.service.requireGlobalPermission.mockReset();
  mocks.service.requireGlobalPermission.mockResolvedValue(actor());
  mocks.service.loadGuildSettings.mockReset();
  mocks.service.loadGuildSettings.mockResolvedValue(settings());
  mocks.service.updateGuildSettings.mockReset();
  mocks.service.updateGuildSettings.mockResolvedValue(settings());
  mocks.service.listGuildRoleMappings.mockReset();
  mocks.service.listGuildRoleMappings.mockResolvedValue([]);
  mocks.service.setGuildRoleMapping.mockReset();
  mocks.service.setGuildRoleMapping.mockResolvedValue([]);
  mocks.service.clearGuildRoleMapping.mockReset();
  mocks.service.clearGuildRoleMapping.mockResolvedValue([]);
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
  mocks.embeds.buildRoleMappingsEmbed.mockReturnValue({ kind: 'role-mappings' });
  mocks.embeds.buildAuditPageEmbed.mockReturnValue({ kind: 'audit-page' });
  mocks.embeds.buildClubRemovalUnavailableEmbed.mockReturnValue({ kind: 'remove-unavailable' });

  mocks.sync.previewClubRegistration.mockReset();
  mocks.sync.previewClubRegistration.mockResolvedValue(preview());
  mocks.sync.registerClubs.mockReset();
  mocks.sync.registerClubs.mockResolvedValue({ registered: 1, rejected: [] });
  mocks.sync.runSync.mockReset();
  mocks.sync.runSync.mockResolvedValue(syncResult());

  mocks.clubs.getRegisteredClubs.mockReset();
  mocks.clubs.getRegisteredClubs.mockResolvedValue([{ id: CLUB_ID, tag: '2UG9', name: 'Alpha' }]);
  mocks.clubs.filterRegisteredClubs.mockReset();
  mocks.clubs.filterRegisteredClubs.mockImplementation((clubs: unknown) => clubs as never);

  mocks.archival.archiveGuildClub.mockReset();
  mocks.archival.archiveGuildClub.mockResolvedValue({ kind: 'archived' });
  mocks.embeds.buildClubArchivePreviewEmbed.mockReset();
  mocks.embeds.buildClubArchivePreviewEmbed.mockReturnValue({ kind: 'archive-preview' });
  mocks.embeds.buildClubArchivedEmbed.mockReset();
  mocks.embeds.buildClubArchivedEmbed.mockReturnValue({ kind: 'archived' });

  mocks.guard.runManagedSync.mockReset();
  mocks.guard.runManagedSync.mockResolvedValue({ kind: 'ran', results: [syncResult()] });

  mocks.overview.refreshOverviewNow.mockReset();
  mocks.overview.refreshOverviewNow.mockResolvedValue({ posted: true, messageId: 'overview-1' });
  mocks.clubLogs.refreshTodayClubLogDigest.mockReset();
  mocks.clubLogs.refreshTodayClubLogDigest.mockResolvedValue(undefined);

  mocks.rateLimit.checkBotRateLimit.mockReset();
  mocks.rateLimit.checkBotRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
});

describe('/clubs register', () => {
  it('validates and previews official club data without registering', async () => {
    const interaction = chat(null, { tag: '#2ug9' });

    await handleRegisterClub(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.sync.previewClubRegistration).toHaveBeenCalledWith('#2ug9', GUILD_ID);
    expect(mocks.sync.registerClubs).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    const reply = payload(interaction, 'editReply');
    expect(buttons(reply)).toHaveLength(2);
  });

  it('rejects unauthorized users before the API call', async () => {
    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const interaction = chat(null, { tag: '2UG9' });

    await handleRegisterClub(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.sync.previewClubRegistration).not.toHaveBeenCalled();
    expect(payload(interaction, 'editReply').content).toContain('permission');
  });

  it('reports API failures without creating a club', async () => {
    mocks.sync.previewClubRegistration.mockRejectedValueOnce(new Error('API unavailable'));
    const interaction = chat(null, { tag: '2UG9' });

    await handleRegisterClub(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(payload(interaction, 'editReply').content).toContain('could not validate');
    expect(mocks.sync.registerClubs).not.toHaveBeenCalled();
  });

  it('registers on confirmation and records the actor', async () => {
    const start = chat(null, { tag: '2UG9' });
    await handleRegisterClub(start);
    const confirmId = buttons(payload(start, 'editReply'))[0]!.data.custom_id;

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
    const confirmId = buttons(payload(start, 'editReply'))[0]!.data.custom_id;

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
    const confirmId = buttons(payload(start, 'editReply'))[0]!.data.custom_id;

    await handleRegisterClubComponent(button(confirmId));
    const replay = button(confirmId);
    await handleRegisterClubComponent(replay);

    expect(mocks.sync.registerClubs).toHaveBeenCalledOnce();
    expect(payload(replay, 'editReply').content).toContain('no longer valid');
  });

  it('rejects a confirmation pressed by another user', async () => {
    const start = chat(null, { tag: '2UG9' });
    await handleRegisterClub(start);
    const confirmId = buttons(payload(start, 'editReply'))[0]!.data.custom_id;

    const wrongActor = button(confirmId, OTHER_ID);
    await handleRegisterClubComponent(wrongActor);

    expect(mocks.sync.registerClubs).not.toHaveBeenCalled();
    expect(payload(wrongActor, 'editReply').content).toContain('another user');
  });

  it('reports duplicate registration without writing an audit event', async () => {
    mocks.sync.registerClubs.mockResolvedValueOnce({
      registered: 0,
      rejected: [{ tag: '2UG9', reason: 'Club is already registered' }],
    });
    const start = chat(null, { tag: '2UG9' });
    await handleRegisterClub(start);
    const confirmId = buttons(payload(start, 'editReply'))[0]!.data.custom_id;

    const confirmation = button(confirmId);
    await handleRegisterClubComponent(confirmation);

    expect(payload(confirmation, 'editReply').content).toContain('already registered');
    expect(mocks.service.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('surfaces a non-duplicate registration failure reason', async () => {
    mocks.sync.registerClubs.mockResolvedValueOnce({
      registered: 0,
      rejected: [{ tag: '2UG9', reason: 'Brawl Stars API request failed (500).' }],
    });
    const start = chat(null, { tag: '2UG9' });
    await handleRegisterClub(start);
    const confirmId = buttons(payload(start, 'editReply'))[0]!.data.custom_id;

    const confirmation = button(confirmId);
    await handleRegisterClubComponent(confirmation);

    expect(payload(confirmation, 'editReply').content).toContain('Brawl Stars API request failed (500).');
    expect(mocks.service.recordAdminAudit).not.toHaveBeenCalled();
  });
});

describe('/sync', () => {
  it('registers run and status subcommands', () => {
    const json = syncCommandData.toJSON() as any;
    expect(json.name).toBe('sync');
    expect(json.options.map((option: any) => option.name)).toEqual(['run', 'status']);
    expect(json.options[0].options.map((option: any) => option.name)).toEqual(['force']);
  });

  it('passes force through to a fresh guild sync', async () => {
    const interaction = chat(null);

    await handleSync(interaction, true);

    const runner = mocks.guard.runManagedSync.mock.calls[0]?.[0]?.run as
      | (() => Promise<unknown>)
      | undefined;
    if (runner === undefined) throw new Error('sync runner was not configured');
    mocks.sync.runSync.mockResolvedValueOnce(syncResult({ status: 'completed' }));

    await runner();

    expect(mocks.sync.runSync).toHaveBeenCalledWith({ guildId: GUILD_ID, force: true });
  });

  it('rejects unauthorized users', async () => {
    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const interaction = chat(null);

    await handleSync(interaction);

    expect(mocks.guard.runManagedSync).not.toHaveBeenCalled();
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
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

    expect(mocks.service.recordSyncRunAudit).toHaveBeenCalledWith(actor(), failed, { guildId: GUILD_ID });
    expect(mocks.service.loadSyncRun).toHaveBeenCalledWith('run-1');
    expect(mocks.embeds.buildSyncResultEmbed).toHaveBeenCalledWith(failed, syncRun());
    expect(mocks.overview.refreshOverviewNow).not.toHaveBeenCalled();
    expect(mocks.clubLogs.refreshTodayClubLogDigest).not.toHaveBeenCalled();
    expect(payload(interaction, 'editReply').embeds).toEqual([{ kind: 'sync-result' }]);
  });

  it('refreshes the club overview immediately after a completed sync', async () => {
    const interaction = chat(null);

    await handleSync(interaction);

    expect(mocks.overview.refreshOverviewNow).toHaveBeenCalledWith(GUILD_ID, {
      label: 'Test Guild',
      iconUrl: 'https://example.test/icon.png',
    });
    expect(mocks.clubLogs.refreshTodayClubLogDigest).toHaveBeenCalledWith(GUILD_ID);
    expect(payload(interaction, 'editReply').embeds).toEqual([{ kind: 'sync-result' }]);
  });

  it('refreshes the overview when the current period was already synced', async () => {
    mocks.guard.runManagedSync.mockResolvedValueOnce({
      kind: 'ran',
      results: [syncResult({ status: 'skipped', error: 'Sync already completed for this period' })],
    });
    const interaction = chat(null);

    await handleSync(interaction);

    expect(mocks.overview.refreshOverviewNow).toHaveBeenCalledOnce();
    expect(mocks.clubLogs.refreshTodayClubLogDigest).toHaveBeenCalledWith(GUILD_ID);
    expect(payload(interaction, 'editReply').embeds).toEqual([{ kind: 'sync-result' }]);
  });

  it('keeps the sync reply when the daily club log refresh fails', async () => {
    mocks.clubLogs.refreshTodayClubLogDigest.mockRejectedValueOnce(new Error('Discord unavailable'));
    const interaction = chat(null);

    await handleSync(interaction);

    expect(mocks.clubLogs.refreshTodayClubLogDigest).toHaveBeenCalledWith(GUILD_ID);
    expect(payload(interaction, 'editReply').embeds).toEqual([{ kind: 'sync-result' }]);
  });

  it('keeps the sync reply when the overview refresh fails', async () => {
    mocks.overview.refreshOverviewNow.mockRejectedValueOnce(new Error('Discord unavailable'));
    const interaction = chat(null);

    await handleSync(interaction);

    expect(mocks.overview.refreshOverviewNow).toHaveBeenCalledOnce();
    expect(payload(interaction, 'editReply').embeds).toEqual([{ kind: 'sync-result' }]);
  });

  it('sends the sync reply without waiting for slow club log refreshes', async () => {
    let releaseRefresh!: () => void;
    const slowRefresh = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    mocks.clubLogs.refreshTodayClubLogDigest.mockReturnValueOnce(slowRefresh);
    const interaction = chat(null);

    const pending = handleSync(interaction);
    await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalledOnce());
    expect(payload(interaction, 'editReply').embeds).toEqual([{ kind: 'sync-result' }]);

    releaseRefresh();
    await pending;
  });
});

describe('/sync status', () => {
  it('uses stored sync data and requires permission', async () => {
    const interaction = chat(null);

    await handleSyncStatus(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(mocks.service.requireGlobalPermission).toHaveBeenCalledWith(
      ACTOR_ID,
      'sync:run',
      expect.objectContaining({ guildId: GUILD_ID }),
    );
    expect(mocks.service.loadSyncStatus).toHaveBeenCalledWith(GUILD_ID);
    expect(payload(interaction, 'editReply').embeds).toEqual([{ kind: 'sync-status' }]);
  });

  it('rejects unauthorized readers', async () => {
    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const interaction = chat(null);

    await handleSyncStatus(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(mocks.service.loadSyncStatus).not.toHaveBeenCalled();
    expect(payload(interaction, 'editReply').content).toContain('permission');
  });
});

describe('/settings', () => {
  it('registers view and supported setting subcommands', () => {
    const json = settingsCommandData.toJSON() as any;
    expect(json.options.map((option: any) => option.name)).toEqual([
      'view',
      'setup',
      'roles-view',
      'set-role-mapping',
      'clear-role-mapping',
      'set-announcement-channel',
      'clear-announcement-channel',
      'set-overview-channel',
      'clear-overview-channel',
      'set-report-channel',
      'clear-report-channel',
    ]);
  });

  it('rejects unauthorized viewers', async () => {
    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const interaction = chat('view');

    await handleSettings(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(mocks.service.loadGuildSettings).not.toHaveBeenCalled();
    expect(payload(interaction, 'editReply').content).toContain('permission');
  });

  it('views the configured guild settings', async () => {
    const interaction = chat('view');

    await handleSettings(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(mocks.service.loadGuildSettings).toHaveBeenCalledWith(GUILD_ID);
    expect(payload(interaction, 'editReply').embeds).toEqual([{ kind: 'settings-view' }]);
  });

  it('requires confirmation before changing a setting', async () => {
    const start = chat('set-announcement-channel', { channel: { id: CHANNEL_ID } });
    await handleSettings(start);
    expect(start.deferReply).toHaveBeenCalledWith({ flags: 64 });
    const confirmId = buttons(payload(start, 'editReply'))[0]!.data.custom_id;

    expect(mocks.service.updateGuildSettings).not.toHaveBeenCalled();

    const confirmation = button(confirmId);
    await handleSettingsComponent(confirmation);

    expect(mocks.service.requireGlobalPermission).toHaveBeenCalledTimes(2);
    expect(mocks.service.updateGuildSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: GUILD_ID,
        field: 'announcementChannelId',
        value: CHANNEL_ID,
      }),
    );
    expect(payload(confirmation, 'editReply').embeds).toEqual([{ kind: 'settings-updated' }]);
  });

  it('passes null to clear a supported setting', async () => {
    const start = chat('clear-announcement-channel');
    await handleSettings(start);
    const confirmId = buttons(payload(start, 'editReply'))[0]!.data.custom_id;

    await handleSettingsComponent(button(confirmId));

    expect(mocks.service.updateGuildSettings).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'announcementChannelId', value: null }),
    );
  });

  it('sets a per-report channel for the selected report type', async () => {
    const start = chat('set-report-channel', {
      report_type: 'weekly',
      channel: { id: CHANNEL_ID },
    });
    await handleSettings(start);
    const confirmId = buttons(payload(start, 'editReply'))[0]!.data.custom_id;

    await handleSettingsComponent(button(confirmId));

    expect(mocks.service.updateGuildSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: GUILD_ID,
        field: 'reportWeeklyChannelId',
        value: CHANNEL_ID,
      }),
    );
  });

  it('clears a per-report channel back to the overview fallback', async () => {
    const start = chat('clear-report-channel', { report_type: 'daily' });
    await handleSettings(start);
    const confirmId = buttons(payload(start, 'editReply'))[0]!.data.custom_id;

    await handleSettingsComponent(button(confirmId));

    expect(mocks.service.updateGuildSettings).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'reportDailyChannelId', value: null }),
    );
  });

  it('shows validation errors from the settings service', async () => {
    mocks.service.updateGuildSettings.mockRejectedValueOnce(
      new mocks.AdminServiceError('invalid_role', 'That role is not registered with BrawlHub.'),
    );
    const start = chat('set-verified-role', { role: { id: ROLE_ID } });
    await handleSettings(start);
    const confirmId = buttons(payload(start, 'editReply'))[0]!.data.custom_id;

    const confirmation = button(confirmId);
    await handleSettingsComponent(confirmation);

    expect(payload(confirmation, 'editReply').content).toContain('not registered');
  });

  it('prevents replay of a settings confirmation', async () => {
    const start = chat('set-verified-role', { role: { id: ROLE_ID } });
    await handleSettings(start);
    const confirmId = buttons(payload(start, 'editReply'))[0]!.data.custom_id;

    await handleSettingsComponent(button(confirmId));
    const replay = button(confirmId);
    await handleSettingsComponent(replay);

    expect(mocks.service.updateGuildSettings).toHaveBeenCalledOnce();
    expect(payload(replay, 'editReply').content).toContain('no longer valid');
  });

});

describe('/audit', () => {
  it('rejects users without audit:read', async () => {
    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const interaction = chat(null);

    await handleAudit(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.service.listAuditLogs).not.toHaveBeenCalled();
    expect(payload(interaction, 'editReply').content).toContain('permission');
  });

  it('checks audit:read and paginates stored entries', async () => {
    const interaction = chat(null);

    await handleAudit(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.service.requireGlobalPermission).toHaveBeenCalledWith(
      ACTOR_ID,
      'audit:read',
      expect.objectContaining({ guildId: GUILD_ID }),
    );
    expect(mocks.service.listAuditLogs).toHaveBeenCalledWith(200, { guildId: GUILD_ID });
    const reply = payload(interaction, 'editReply');
    expect(buttons(reply)[0]!.data.custom_id).toBe('audit:page:2');
  });

  it('rechecks permission on pagination buttons', async () => {
    const start = chat(null);
    await handleAudit(start);
    const nextId = buttons(payload(start, 'editReply'))[0]!.data.custom_id;

    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const page = button(nextId);
    await handleAuditComponent(page);

    expect(payload(page, 'editReply').content).toContain('permission');
    expect(mocks.service.listAuditLogs).toHaveBeenCalledOnce();
  });

  it('renders the second page without mutating audit records', async () => {
    const page = button('audit:page:2');

    await handleAuditComponent(page);

    expect(mocks.service.listAuditLogs).toHaveBeenCalledWith(200, { guildId: GUILD_ID });
    expect(payload(page, 'editReply').embeds).toEqual([{ kind: 'audit-page' }]);
    expect(mocks.service.recordAdminAudit).not.toHaveBeenCalled();
  });
});

describe('/clubs remove archival', () => {
  it('previews archival without changing club data', async () => {
    const interaction = chat(null, { club: CLUB_ID });

    await handleRemoveClub(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(mocks.embeds.buildClubArchivePreviewEmbed).toHaveBeenCalledWith('Alpha', '2UG9');
    expect(payload(interaction, 'editReply').embeds).toEqual([{ kind: 'archive-preview' }]);
    expect(mocks.archival.archiveGuildClub).not.toHaveBeenCalled();
    expect(mocks.service.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('archives the guild club on confirmation', async () => {
    const start = chat(null, { club: CLUB_ID });
    await handleRemoveClub(start);
    const confirmId = buttons(payload(start, 'editReply'))[0]!.data.custom_id;
    const confirmation = button(confirmId);

    await handleRemoveClubComponent(confirmation);

    expect(mocks.archival.archiveGuildClub).toHaveBeenCalledWith(
      expect.objectContaining({
        clubId: CLUB_ID,
        guildId: GUILD_ID,
        clubTag: '2UG9',
        clubName: 'Alpha',
        actor: actor(),
      }),
    );
    expect(mocks.embeds.buildClubArchivedEmbed).toHaveBeenCalledWith('Alpha', '2UG9');
    expect(payload(confirmation, 'editReply').embeds).toEqual([{ kind: 'archived' }]);
  });

  it('rechecks permission at confirmation time', async () => {
    const start = chat(null, { club: CLUB_ID });
    await handleRemoveClub(start);
    const confirmId = buttons(payload(start, 'editReply'))[0]!.data.custom_id;
    const confirmation = button(confirmId);
    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());

    await handleRemoveClubComponent(confirmation);

    expect(mocks.archival.archiveGuildClub).not.toHaveBeenCalled();
    expect(payload(confirmation, 'editReply').content).toContain('You do not have permission.');
  });

  it('cancels archival without calling the archive service', async () => {
    const start = chat(null, { club: CLUB_ID });
    await handleRemoveClub(start);
    const cancelId = buttons(payload(start, 'editReply'))[1]!.data.custom_id;
    const cancellation = button(cancelId);

    await handleRemoveClubComponent(cancellation);

    expect(mocks.archival.archiveGuildClub).not.toHaveBeenCalled();
    expect(payload(cancellation, 'editReply').content).toBe(
      'Club archival cancelled. Nothing was changed.',
    );
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
