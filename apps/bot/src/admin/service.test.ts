import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import type { StaffActor } from '../staff/types';

interface Call {
  table: string;
  operation: 'select' | 'insert' | 'upsert' | 'update';
  payload: any;
  options: any;
  filters: Record<string, unknown>;
  inValues: { column: string; values: unknown[] } | null;
  orderBy: { column: string; options: unknown } | null;
  limit: number | null;
  mode: 'array' | 'maybeSingle';
}

type Handler = (call: Call) => { data?: unknown; error?: unknown } | Promise<{ data?: unknown; error?: unknown }>;

const staffMocks = vi.hoisted(() => {
  class MockStaffServiceError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'StaffServiceError';
      this.code = code;
    }
  }
  return {
    resolveStaffActor: vi.fn(),
    StaffServiceError: MockStaffServiceError,
  };
});

const verificationMocks = vi.hoisted(() => ({
  ensureBotProfileForDiscordUser: vi.fn(),
  resolveProfileId: vi.fn(),
}));

const fake = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler | undefined>,
  calls: [] as Call[],
}));

vi.mock('@brawlhub/database', () => {
  class FakeQuery {
    private operation: Call['operation'] = 'select';
    private payload: unknown = undefined;
    private options: unknown = undefined;
    private filters: Record<string, unknown> = {};
    private inValues: Call['inValues'] = null;
    private orderBy: Call['orderBy'] = null;
    private limitValue: number | null = null;
    private mode: Call['mode'] = 'array';

    constructor(private readonly table: string) {}

    select(): this {
      return this;
    }

    insert(payload: unknown, options?: unknown): this {
      this.operation = 'insert';
      this.payload = payload;
      this.options = options;
      return this;
    }

    upsert(payload: unknown, options?: unknown): this {
      this.operation = 'upsert';
      this.payload = payload;
      this.options = options;
      return this;
    }

    update(payload: unknown): this {
      this.operation = 'update';
      this.payload = payload;
      return this;
    }

    eq(column: string, value: unknown): this {
      this.filters[column] = value;
      return this;
    }

    is(column: string, value: unknown): this {
      this.filters[column] = value;
      return this;
    }

    in(column: string, values: unknown[]): this {
      this.inValues = { column, values };
      return this;
    }

    order(column: string, options?: unknown): this {
      this.orderBy = { column, options };
      return this;
    }

    limit(value: number): this {
      this.limitValue = value;
      return this;
    }

    maybeSingle(): this {
      this.mode = 'maybeSingle';
      return this;
    }

    then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown): Promise<unknown> {
      return this.execute().then(resolve, reject);
    }

    async execute(): Promise<{ data: unknown; error: unknown }> {
      const call: Call = {
        table: this.table,
        operation: this.operation,
        payload: this.payload,
        options: this.options,
        filters: { ...this.filters },
        inValues: this.inValues,
        orderBy: this.orderBy,
        limit: this.limitValue,
        mode: this.mode,
      };
      fake.calls.push(call);
      const handler = fake.handlers[`${this.table}:${this.operation}`] ?? fake.handlers[this.table];
      const result = handler === undefined ? {} : await handler(call);
      return {
        data: result.data === undefined ? (this.mode === 'maybeSingle' ? null : []) : result.data,
        error: result.error === undefined ? null : result.error,
      };
    }
  }

  return { createTrustedClient: () => ({ from: (table: string) => new FakeQuery(table) }) };
});

vi.mock('../staff/service', () => ({
  resolveStaffActor: staffMocks.resolveStaffActor,
  StaffServiceError: staffMocks.StaffServiceError,
}));

vi.mock('../verification/service.js', () => verificationMocks);

import {
  AdminServiceError,
  listAuditLogs,
  loadGuildSettings,
  loadSyncStatus,
  requireGlobalPermission,
  sanitizeAuditDetails,
  updateGuildOverviewFields,
  updateGuildSettings,
} from './service';

const GUILD_ID = '123456789012345678';
const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLUB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function actor(globalRole: StaffActor['globalRole'] = 'admin'): StaffActor {
  return { profileId: PROFILE_ID, discordUserId: '111111111111111111', globalRole };
}

function setHandler(key: string, handler: Handler): void {
  fake.handlers[key] = handler;
}

beforeEach(() => {
  fake.handlers = {};
  fake.calls = [];
  setHandler('guild_role_mappings:select', () => ({ data: [] }));
  staffMocks.resolveStaffActor.mockReset();
  staffMocks.resolveStaffActor.mockResolvedValue(actor());
  verificationMocks.ensureBotProfileForDiscordUser.mockReset();
  verificationMocks.resolveProfileId.mockReset();
  verificationMocks.resolveProfileId.mockResolvedValue(null);
});

function discordPerms(bits: bigint[] = []) {
  const set = new Set(bits);
  return { has: (permission: bigint) => set.has(permission) };
}

describe('requireGlobalPermission', () => {
  it('accepts a global role with the shared permission', async () => {
    staffMocks.resolveStaffActor.mockResolvedValue(actor('admin'));
    await expect(requireGlobalPermission('111111111111111111', 'sync:run')).resolves.toEqual(actor('admin'));
  });

  it('rejects global staff for owner-only audit access', async () => {
    staffMocks.resolveStaffActor.mockResolvedValue(actor('staff'));
    await expect(requireGlobalPermission('111111111111111111', 'audit:read')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('rejects users with no global role, including club-role holders', async () => {
    staffMocks.resolveStaffActor.mockResolvedValue(actor(null));
    await expect(requireGlobalPermission('111111111111111111', 'clubs:write')).rejects.toBeInstanceOf(
      AdminServiceError,
    );
  });

  it('accepts Discord guild administrators for admin actions', async () => {
    staffMocks.resolveStaffActor.mockResolvedValue(actor(null));
    await expect(
      requireGlobalPermission('111111111111111111', 'clubs:write', {
        guildId: GUILD_ID,
        memberPermissions: discordPerms([PermissionFlagsBits.Administrator]),
      }),
    ).resolves.toEqual(actor('owner'));
  });

  it('accepts the Discord guild owner for admin actions', async () => {
    staffMocks.resolveStaffActor.mockResolvedValue(actor(null));
    await expect(
      requireGlobalPermission('111111111111111111', 'sync:run', {
        guildId: GUILD_ID,
        isGuildOwner: true,
      }),
    ).resolves.toEqual(actor('owner'));
  });

  it('accepts Discord Manage Guild for configuration permissions', async () => {
    staffMocks.resolveStaffActor.mockResolvedValue(actor(null));
    await expect(
      requireGlobalPermission('111111111111111111', 'clubs:write', {
        guildId: GUILD_ID,
        memberPermissions: discordPerms([PermissionFlagsBits.ManageGuild]),
      }),
    ).resolves.toEqual(actor('admin'));
  });

  it('does not grant owner-only audit access via Manage Guild', async () => {
    staffMocks.resolveStaffActor.mockResolvedValue(actor('member'));
    await expect(
      requireGlobalPermission('111111111111111111', 'audit:read', {
        guildId: GUILD_ID,
        memberPermissions: discordPerms([PermissionFlagsBits.ManageGuild]),
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('provisions an actor when a Discord admin has no linked profile', async () => {
    staffMocks.resolveStaffActor.mockRejectedValue(
      new staffMocks.StaffServiceError('profile_not_linked', 'not linked'),
    );
    verificationMocks.ensureBotProfileForDiscordUser.mockResolvedValue('cccccccc-cccc-4ccc-8ccc-cccccccccccc');

    await expect(
      requireGlobalPermission('111111111111111111', 'clubs:write', {
        guildId: GUILD_ID,
        memberPermissions: discordPerms([PermissionFlagsBits.Administrator]),
        discordUsername: 'AdminUser',
      }),
    ).resolves.toEqual({
      profileId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      discordUserId: '111111111111111111',
      globalRole: 'owner',
    });
    expect(verificationMocks.ensureBotProfileForDiscordUser).toHaveBeenCalledWith(
      '111111111111111111',
      'AdminUser',
    );
  });
});

describe('guild settings service', () => {
  it('rejects an invalid configured guild ID', async () => {
    await expect(loadGuildSettings('not-a-snowflake')).rejects.toMatchObject({ code: 'invalid_guild' });
  });

  it('returns empty settings when the guild has no row', async () => {
    setHandler('guild_settings:select', () => ({ data: null }));

    const settings = await loadGuildSettings(GUILD_ID);
    expect(settings).toMatchObject({
      guildId: GUILD_ID,
      announcementChannelId: null,
      verifiedRoleId: null,
    });
  });

  it('rejects invalid Discord channel IDs without writing', async () => {
    setHandler('guild_settings:select', () => ({ data: null }));

    await expect(
      updateGuildSettings({
        actor: actor(),
        guildId: GUILD_ID,
        field: 'announcementChannelId',
        value: 'not-an-id',
      }),
    ).rejects.toMatchObject({ code: 'invalid_channel' });
    expect(fake.calls.some((call) => call.operation === 'upsert')).toBe(false);
  });

  it('upserts the supported field and writes an audit event', async () => {
    setHandler('guild_settings:select', () => ({
      data: {
        guild_id: GUILD_ID,
        announcement_channel_id: null,
        verified_role_id: null,
        updated_at: '2026-11-18T00:00:00.000Z',
      },
    }));
    let settingsReadCount = 0;
    fake.handlers['guild_settings:select'] = () => {
      settingsReadCount += 1;
      return {
        data: {
          guild_id: GUILD_ID,
            announcement_channel_id: settingsReadCount > 1 ? '999999999999999999' : null,
          verified_role_id: null,
          updated_at: '2026-11-18T00:00:00.000Z',
        },
      };
    };
    const upsert = vi.fn(() => ({ data: null }));
    const audit = vi.fn(() => ({ data: null }));
    setHandler('guild_settings:upsert', upsert);
    setHandler('audit_logs:insert', audit);

    const settings = await updateGuildSettings({
      actor: actor(),
      guildId: GUILD_ID,
      field: 'announcementChannelId',
      value: '999999999999999999',
    });

    expect(upsert).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledOnce();
    expect(settings.announcementChannelId).toBe('999999999999999999');
    const auditPayload = (audit.mock.calls[0] as any[])[0].payload;
    expect(auditPayload).toMatchObject({
      actor_profile_id: PROFILE_ID,
      action: 'guild.settings.updated',
      target_id: GUILD_ID,
    });
    expect(auditPayload.details.changedFields).toEqual(['announcementChannelId']);
  });

  it('clears a supported field with null', async () => {
    setHandler('guild_settings:select', () => ({
      data: {
        guild_id: GUILD_ID,
        announcement_channel_id: '999999999999999999',
        verified_role_id: null,
        updated_at: null,
      },
    }));
    setHandler('guild_settings:upsert', () => ({ data: null }));
    setHandler('audit_logs:insert', () => ({ data: null }));

    await updateGuildSettings({
      actor: actor(),
      guildId: GUILD_ID,
      field: 'announcementChannelId',
      value: null,
    });

    const call = fake.calls.find((entry) => entry.operation === 'upsert');
    expect((call?.payload as any).announcement_channel_id).toBeNull();
  });

  it('returns all default overview fields and null report overrides for a new guild', async () => {
    setHandler('guild_settings:select', () => ({ data: null }));

    const settings = await loadGuildSettings(GUILD_ID);
    expect(settings.overviewFields).toContain('clubTrophies');
    expect(settings.overviewFields).toContain('megaPigEstimate');
    expect(settings.reportDailyChannelId).toBeNull();
    expect(settings.reportWeeklyChannelId).toBeNull();
    expect(settings.reportMonthlyChannelId).toBeNull();
  });

  it('saves a per-report channel override and audits the changed field', async () => {
    setHandler('guild_settings:select', () => ({
      data: {
        guild_id: GUILD_ID,
        announcement_channel_id: null,
        verified_role_id: null,
        updated_at: '2026-11-18T00:00:00.000Z',
      },
    }));
    setHandler('guild_settings:upsert', () => ({ data: null }));
    const audit = vi.fn(() => ({ data: null }));
    setHandler('audit_logs:insert', audit);

    await updateGuildSettings({
      actor: actor(),
      guildId: GUILD_ID,
      field: 'reportWeeklyChannelId',
      value: '777777777777777777',
    });

    const call = fake.calls.find((entry) => entry.operation === 'upsert');
    expect((call?.payload as any).report_weekly_channel_id).toBe('777777777777777777');
    expect((audit.mock.calls[0] as any[])[0].payload.details.changedFields).toEqual([
      'reportWeeklyChannelId',
    ]);
  });

  it('normalizes and audits an overview field selection', async () => {
    setHandler('guild_settings:select', () => ({
      data: {
        guild_id: GUILD_ID,
        overview_fields: ['members', 'bogus', 'members'],
        announcement_channel_id: null,
        verified_role_id: null,
        updated_at: null,
      },
    }));
    const update = vi.fn(() => ({ data: [{ guild_id: GUILD_ID }] }));
    setHandler('guild_settings:update', update);
    const audit = vi.fn(() => ({ data: null }));
    setHandler('audit_logs:insert', audit);

    await updateGuildOverviewFields({
      actor: actor(),
      guildId: GUILD_ID,
      fields: ['members', 'bogus', 'members'] as any,
    });

    expect((update.mock.calls[0] as any[])[0].payload).toEqual({ overview_fields: ['members'] });
    expect((audit.mock.calls[0] as any[])[0].payload.action).toBe('guild.overview_fields.updated');
  });
});

describe('sync status service', () => {
  it('parses the latest run and active lock', async () => {
    setHandler('sync_runs:select', () => ({
      data: {
        id: 'run-1',
        status: 'completed',
        period_start: '2026-11-18T00:00:00.000Z',
        started_at: '2026-11-18T00:00:01.000Z',
        finished_at: '2026-11-18T00:05:00.000Z',
        error: null,
        last_error: 'previous failure',
        records_processed: 12,
        affected_club_ids: [CLUB_ID],
        club_tags: ['2UG9'],
      },
    }));
    setHandler('sync_locks:select', () => ({
      data: [
        {
          scope: 'all-clubs',
          locked_by: 'token-1',
          locked_at: '2026-11-18T00:04:00.000Z',
          locked_until: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }));

    const status = await loadSyncStatus();
    expect(status.latestRun).toMatchObject({
      id: 'run-1',
      status: 'completed',
      recordsProcessed: 12,
      clubTags: ['2UG9'],
    });
    expect(status.lock.active).toBe(true);
  });

  it('treats an expired lock as inactive', async () => {
    setHandler('sync_runs:select', () => ({ data: null }));
    setHandler('sync_locks:select', () => ({
      data: [
        {
          scope: 'all-clubs',
          locked_by: 'token-1',
          locked_at: null,
          locked_until: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    }));

    const status = await loadSyncStatus();
    expect(status.latestRun).toBeNull();
    expect(status.lock.active).toBe(false);
  });
});

describe('audit service', () => {
  it('sanitises details to an allowlist and redacts unknown values', () => {
    const safe = sanitizeAuditDetails({
      reason: 'cheating',
      changedFields: ['announcementChannelId'],
      clubsProcessed: 3,
      apiToken: 'super-secret',
      nested: { password: 'secret' },
    });

    expect(safe).toEqual({
      reason: 'cheating',
      changedFields: ['announcementChannelId'],
      clubsProcessed: 3,
    });
    expect(JSON.stringify(safe)).not.toContain('super-secret');
  });

  it('maps actor profiles and sanitises each entry', async () => {
    setHandler('audit_logs:select', () => ({
      data: [
        {
          id: 'entry-1',
          actor_profile_id: PROFILE_ID,
          action: 'club.registered',
          target_type: 'club',
          target_id: '2UG9',
          details: { clubTag: '2UG9', apiToken: 'secret' },
          created_at: '2026-11-18T00:00:00.000Z',
        },
      ],
    }));
    setHandler('profiles:select', () => ({
      data: [{ id: PROFILE_ID, discord_user_id: '111111111111111111', username: 'Admin' }],
    }));

    const view = await listAuditLogs(500);
    expect(view.entries).toEqual([
      expect.objectContaining({
        actorLabel: '<@111111111111111111>',
        action: 'club.registered',
        details: { clubTag: '2UG9' },
      }),
    ]);
    const auditCall = fake.calls.find((call) => call.table === 'audit_logs');
    expect(auditCall?.limit).toBe(200);
  });
});
