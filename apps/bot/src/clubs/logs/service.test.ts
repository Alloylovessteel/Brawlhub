import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminActor } from '../../admin/types';

const GUILD_ID = '123456789012345678';
const OTHER_GUILD_ID = '876543210987654321';
const CLUB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_CLUB_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CHANNEL_ID = '111111111111111222';
const LOG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CREATED_AT = '2026-11-20T12:00:00.000Z';
const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const mocks = vi.hoisted(() => ({ recordAdminAudit: vi.fn() }));

vi.mock('@brawlhub/database', () => {
  class FakeQuery {
    private operation: Call['operation'] = 'select';
    private payload: unknown = undefined;
    private options: unknown = undefined;
    private filters: Record<string, unknown> = {};
    private inValues: Call['inValues'] = null;
    private orValue: string | null = null;
    private likeValue: Call['likeValue'] = null;
    private ltValue: Call['ltValue'] = null;
    private gteValue: Call['gteValue'] = null;
    private orderBy: Call['orderBy'] = null;
    private limitValue: number | null = null;
    private rangeValue: Call['range'] = null;
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

    delete(): this {
      this.operation = 'delete';
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

    or(value: string): this {
      this.orValue = value;
      return this;
    }

    gte(column: string, value: unknown): this {
      this.gteValue = { column, value };
      return this;
    }

    like(column: string, value: string): this {
      this.likeValue = { column, value };
      return this;
    }

    lt(column: string, value: unknown): this {
      this.ltValue = { column, value };
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

    range(from: number, to: number): this {
      this.rangeValue = { from, to };
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
        orValue: this.orValue,
        likeValue: this.likeValue,
        ltValue: this.ltValue,
        gteValue: this.gteValue,
        orderBy: this.orderBy,
        limit: this.limitValue,
        range: this.rangeValue,
        mode: this.mode,
      };
      fake.calls.push(call);
      const handler = fake.handlers[`${this.table}:${this.operation}`] ?? fake.handlers[this.table];
      const result = handler === undefined ? {} : await handler(call);
      return {
        data: result.data === undefined ? (this.mode === 'maybeSingle' ? null : []) : result.data,
        error: result.error ?? null,
      };
    }
  }

  return { createTrustedClient: () => ({ from: (table: string) => new FakeQuery(table) }) };
});

vi.mock('../../admin/service', () => {
  class MockAdminServiceError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'AdminServiceError';
      this.code = code;
    }
  }
  return { recordAdminAudit: mocks.recordAdminAudit, AdminServiceError: MockAdminServiceError };
});

import {
  addClubLog,
  claimClubLogDigestWindows,
  loadClubLogs,
  loadUndeliveredClubLogEvents,
  markClubLogDigestPosted,
  markClubLogEventsDelivered,
  readPostedClubLogDigests,
  releaseClubLogDigestClaims,
  removeClubLog,
} from './service';

interface Call {
  readonly table: string;
  readonly operation: 'select' | 'insert' | 'upsert' | 'delete';
  readonly payload: unknown;
  readonly options: unknown;
  readonly filters: Record<string, unknown>;
  readonly inValues: { column: string; values: unknown[] } | null;
  readonly orValue: string | null;
  readonly likeValue: { column: string; value: string } | null;
  readonly ltValue: { column: string; value: unknown } | null;
  readonly gteValue: { column: string; value: unknown } | null;
  readonly orderBy: { column: string; options: unknown } | null;
  readonly limit: number | null;
  readonly range: { from: number; to: number } | null;
  readonly mode: 'array' | 'maybeSingle';
}

type Handler = (call: Call) => { data?: unknown; error?: unknown } | Promise<{ data?: unknown; error?: unknown }>;

const fake = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler | undefined>,
  calls: [] as Call[],
}));

function actor(): AdminActor {
  return { profileId: PROFILE_ID, discordUserId: '999999999999999999', globalRole: 'admin' };
}

function logRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: LOG_ID,
    guild_id: GUILD_ID,
    club_id: CLUB_ID,
    channel_id: CHANNEL_ID,
    created_at: CREATED_AT,
    ...overrides,
  };
}

function clubRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CLUB_ID,
    guild_id: GUILD_ID,
    tag: 'ALPHA',
    name: 'Alpha',
    archived_at: null,
    ...overrides,
  };
}

function setHandler(key: string, handler: Handler): void {
  fake.handlers[key] = handler;
}

function callsFor(table: string, operation?: Call['operation']): Call[] {
  return fake.calls.filter(
    (call) => call.table === table && (operation === undefined || call.operation === operation),
  );
}

beforeEach(() => {
  fake.handlers = {};
  fake.calls = [];
  mocks.recordAdminAudit.mockReset();
  mocks.recordAdminAudit.mockResolvedValue(undefined);
});

describe('loadClubLogs', () => {
  it('scopes rows to this guild and excludes archived or foreign clubs', async () => {
    setHandler('guild_club_logs:select', (call) => {
      expect(call.filters['guild_id']).toBe(GUILD_ID);
      return {
        data: [
          logRow(),
          logRow({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', club_id: OTHER_CLUB_ID }),
        ],
      };
    });
    setHandler('clubs:select', (call) => {
      expect(call.filters['guild_id']).toBe(GUILD_ID);
      expect(call.filters['archived_at']).toBeNull();
      expect(call.inValues).toEqual({ column: 'id', values: [CLUB_ID, OTHER_CLUB_ID] });
      return {
        data: [
          clubRow(),
          clubRow({
            id: OTHER_CLUB_ID,
            tag: 'ARCHIVED',
            name: 'Archived',
            archived_at: '2026-11-19T00:00:00.000Z',
          }),
          clubRow({ id: OTHER_CLUB_ID, tag: 'FOREIGN', name: 'Foreign', guild_id: OTHER_GUILD_ID }),
        ],
      };
    });

    const logs = await loadClubLogs(GUILD_ID);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({
      id: LOG_ID,
      guildId: GUILD_ID,
      clubId: CLUB_ID,
      clubTag: 'ALPHA',
      clubName: 'Alpha',
      channelId: CHANNEL_ID,
      periods: ['today'],
    });
  });

  it('reads and orders only valid periods for this guild’s logs', async () => {
    setHandler('guild_club_logs:select', () => ({ data: [logRow()] }));
    setHandler('clubs:select', () => ({ data: [clubRow()] }));
    setHandler('guild_club_log_periods:select', (call) => {
      expect(call.filters['guild_id']).toBe(GUILD_ID);
      expect(call.inValues).toEqual({ column: 'log_id', values: [LOG_ID] });
      return {
        data: [
          { log_id: LOG_ID, period: 'season' },
          { log_id: LOG_ID, period: 'week' },
          { log_id: LOG_ID, period: 'unknown' },
          { log_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', period: 'today' },
        ],
      };
    });

    const logs = await loadClubLogs(GUILD_ID);

    expect(logs[0]?.periods).toEqual(['week', 'season']);
  });
});

describe('loadUndeliveredClubLogEvents', () => {
  beforeEach(() => {
    setHandler('guild_club_logs:select', () => ({ data: [logRow()] }));
    setHandler('clubs:select', () => ({ data: [clubRow()] }));
  });

  it('skips delivered events and maps membership, role and capacity descriptions', async () => {
    setHandler('guild_club_log_deliveries:select', (call) => {
      expect(call.filters['guild_id']).toBe(GUILD_ID);
      expect(call.filters['log_id']).toBe(LOG_ID);
      expect(call.filters['period']).toBe('today');
      return {
        data: [
          { event_kind: 'membership', event_id: 'm1' },
          { event_kind: 'role', event_id: 'r1' },
        ],
      };
    });
    setHandler('membership_events:select', (call) => {
      expect(call.orValue).toBe(`from_club_id.eq.${CLUB_ID},to_club_id.eq.${CLUB_ID}`);
      expect(call.gteValue).toBeNull();
      return {
        data: [
          {
            id: 'm1',
            event_type: 'join',
            detected_at: '2026-11-20T13:00:00.000Z',
            from_club_id: null,
            to_club_id: CLUB_ID,
            player: { tag: '#JOINER', name: 'Joiner' },
          },
          {
            id: 'm2',
            event_type: 'leave',
            detected_at: '2026-11-20T12:30:00.000Z',
            from_club_id: CLUB_ID,
            to_club_id: null,
            player: { tag: '#LEAVER', name: 'Leaver' },
          },
          {
            id: 'm3',
            event_type: 'transfer',
            detected_at: '2026-11-20T12:45:00.000Z',
            from_club_id: CLUB_ID,
            to_club_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            player: { tag: '#MOVER', name: 'Mover' },
          },
        ],
      };
    });
    setHandler('club_role_changes:select', (call) => {
      expect(call.filters['club_id']).toBe(CLUB_ID);
      return {
        data: [
          {
            id: 'r1',
            from_role: 'member',
            to_role: 'senior',
            detected_at: '2026-11-20T12:50:00.000Z',
            player: { tag: '#OLDROLE', name: 'Old Role' },
          },
          {
            id: 'r2',
            from_role: 'President',
            to_role: null,
            detected_at: '2026-11-20T12:55:00.000Z',
            player: { tag: '#NEWROLE', name: 'New Role', trophies: 48617 },
          },
        ],
      };
    });
    setHandler('club_capacity_events:select', () => ({
      data: [
        {
          id: 'c1',
          from_count: 29,
          to_count: 30,
          is_full: true,
          detected_at: '2026-11-20T12:10:00.000Z',
        },
        {
          id: 'c2',
          from_count: 30,
          to_count: 29,
          is_full: false,
          detected_at: '2026-11-20T12:20:00.000Z',
        },
      ],
    }));

    const groups = await loadUndeliveredClubLogEvents(GUILD_ID);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.log).toEqual({
      id: LOG_ID,
      guildId: GUILD_ID,
      clubId: CLUB_ID,
      clubTag: 'ALPHA',
      clubName: 'Alpha',
      channelId: CHANNEL_ID,
      periods: ['today'],
    });
    expect(groups[0]?.events.map((event) => event.description)).toEqual([
      'New Role (48,617 🏆) was demoted to none.',
      '#MOVER transferred from #ALPHA to another club',
      '#LEAVER left #ALPHA',
      'Club open (29/30)',
      'Club full (30/30)',
    ]);
    expect(groups[0]?.events.map((event) => event.kind)).toEqual([
      'role',
      'membership',
      'membership',
      'capacity',
      'capacity',
    ]);
  });

  it('includes stored events that predate the subscription so a new log can backfill history', async () => {
    setHandler('guild_club_log_deliveries:select', () => ({ data: [] }));
    setHandler('membership_events:select', (call) => {
      expect(call.gteValue).toBeNull();
      return {
        data: [
          {
            id: 'old1',
            event_type: 'join',
            detected_at: '2026-11-01T08:00:00.000Z',
            from_club_id: null,
            to_club_id: CLUB_ID,
            player: { tag: '#OLDMEMBER', name: 'Old Member' },
          },
        ],
      };
    });
    setHandler('club_role_changes:select', () => ({ data: [] }));
    setHandler('club_capacity_events:select', () => ({ data: [] }));

    const groups = await loadUndeliveredClubLogEvents(GUILD_ID);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.events.map((event) => event.description)).toEqual([
      '#OLDMEMBER joined #ALPHA',
    ]);
  });

  it('finds an undelivered event beyond the old 100-row query window', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      id: `c${index}`,
      from_count: 29,
      to_count: 30,
      is_full: true,
      detected_at: new Date(Date.parse('2026-11-20T12:00:00.000Z') + index * 60_000).toISOString(),
    }));
    setHandler('guild_club_log_deliveries:select', () => ({
      data: rows.slice(0, 100).map((row) => ({ event_kind: 'capacity', event_id: row.id })),
    }));
    setHandler('membership_events:select', () => ({ data: [] }));
    setHandler('club_role_changes:select', () => ({ data: [] }));
    setHandler('club_capacity_events:select', (call) => {
      expect(call.range).toEqual({ from: 0, to: 499 });
      return { data: rows };
    });

    const groups = await loadUndeliveredClubLogEvents(GUILD_ID);

    expect(groups[0]?.events.map((event) => event.id)).toEqual(['c100']);
  });

  it('loads changes once under the today key even when several trophy periods are subscribed', async () => {
    setHandler('guild_club_log_periods:select', () => ({
      data: [
        { log_id: LOG_ID, period: 'today' },
        { log_id: LOG_ID, period: 'week' },
        { log_id: LOG_ID, period: 'season' },
      ],
    }));
    setHandler('guild_club_log_deliveries:select', (call) => {
      expect(call.filters['period']).toBe('today');
      return { data: [] };
    });
    setHandler('membership_events:select', () => ({
      data: [
        {
          id: 'm1',
          event_type: 'join',
          detected_at: '2026-11-01T08:00:00.000Z',
          from_club_id: null,
          to_club_id: CLUB_ID,
          player: { tag: '#JOINER', name: 'Joiner' },
        },
      ],
    }));
    setHandler('club_role_changes:select', () => ({ data: [] }));
    setHandler('club_capacity_events:select', () => ({ data: [] }));

    const groups = await loadUndeliveredClubLogEvents(GUILD_ID);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.log.periods).toEqual(['today', 'week', 'season']);
    expect(groups[0]?.events.map((event) => event.id)).toEqual(['m1']);
    expect(callsFor('guild_club_log_deliveries', 'select')).toHaveLength(1);
  });

  it('caps each log at the 20 most recent events', async () => {
    setHandler('guild_club_log_deliveries:select', () => ({ data: [] }));
    setHandler('membership_events:select', () => ({ data: [] }));
    setHandler('club_role_changes:select', () => ({ data: [] }));
    setHandler('club_capacity_events:select', () => ({
      data: Array.from({ length: 25 }, (_, index) => ({
        id: `c${index}`,
        from_count: 29,
        to_count: 30,
        is_full: true,
        detected_at: new Date(Date.parse('2026-11-20T12:00:00.000Z') + index * 60_000).toISOString(),
      })),
    }));

    const groups = await loadUndeliveredClubLogEvents(GUILD_ID);

    expect(groups[0]?.events).toHaveLength(20);
    expect(groups[0]?.events[0]?.id).toBe('c24');
  });
});

describe('addClubLog', () => {
  it('rejects a club that is not active in this guild', async () => {
    setHandler('clubs:select', (call) => {
      expect(call.filters['guild_id']).toBe(GUILD_ID);
      expect(call.filters['id']).toBe(CLUB_ID);
      expect(call.filters['archived_at']).toBeNull();
      return { data: null };
    });

    await expect(
      addClubLog({ actor: actor(), guildId: GUILD_ID, clubId: CLUB_ID, channelId: CHANNEL_ID }),
    ).rejects.toMatchObject({ code: 'invalid_club' });
    expect(callsFor('guild_club_logs', 'upsert')).toHaveLength(0);
  });

  it('enforces the 25-log limit but allows an existing club/channel pair', async () => {
    setHandler('clubs:select', (call) =>
      call.mode === 'maybeSingle' ? { data: clubRow() } : { data: [clubRow()] },
    );
    const rows = Array.from({ length: 25 }, (_, index) =>
      logRow({
        id: `log-${index}`,
        channel_id: index === 24 ? CHANNEL_ID : `${111111111111111200 + index}`,
      }),
    );
    setHandler('guild_club_logs:select', () => ({ data: rows }));

    await expect(
      addClubLog({
        actor: actor(),
        guildId: GUILD_ID,
        clubId: CLUB_ID,
        channelId: '999999999999999999',
      }),
    ).rejects.toMatchObject({ code: 'log_limit' });

    await expect(
      addClubLog({ actor: actor(), guildId: GUILD_ID, clubId: CLUB_ID, channelId: CHANNEL_ID }),
    ).resolves.toHaveLength(25);
    expect(callsFor('guild_club_logs', 'upsert')).toHaveLength(1);
    expect(mocks.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'club_log.added', guildId: GUILD_ID }),
      expect.objectContaining({ db: expect.any(Object) }),
    );
  });

  it('stores the selected period and rejects unknown periods', async () => {
    setHandler('clubs:select', (call) =>
      call.mode === 'maybeSingle' ? { data: clubRow() } : { data: [clubRow()] },
    );
    setHandler('guild_club_logs:select', () => ({ data: [logRow()] }));
    setHandler('guild_club_log_periods:upsert', (call) => {
      expect(call.filters['guild_id']).toBeUndefined();
      expect(call.payload).toEqual({ guild_id: GUILD_ID, log_id: LOG_ID, period: 'week' });
      expect(call.options).toEqual({
        onConflict: 'guild_id,log_id,period',
        ignoreDuplicates: true,
      });
      return { data: [] };
    });
    setHandler('guild_club_log_periods:select', () => ({
      data: [{ log_id: LOG_ID, period: 'week' }],
    }));

    const logs = await addClubLog({
      actor: actor(),
      guildId: GUILD_ID,
      clubId: CLUB_ID,
      channelId: CHANNEL_ID,
      period: 'week',
    });

    expect(logs[0]?.periods).toEqual(['week']);
    expect(mocks.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'club_log.added',
        details: expect.objectContaining({ guildId: GUILD_ID, period: 'week' }),
      }),
      expect.any(Object),
    );

    await expect(
      addClubLog({
        actor: actor(),
        guildId: GUILD_ID,
        clubId: CLUB_ID,
        channelId: CHANNEL_ID,
        period: 'month',
      }),
    ).rejects.toMatchObject({ code: 'invalid_period' });
    expect(callsFor('guild_club_log_periods', 'upsert')).toHaveLength(1);
  });
});

describe('removeClubLog and delivery marking', () => {
  it('deletes only this guild’s rows for the club and audits the change', async () => {
    setHandler('guild_club_logs:delete', (call) => {
      expect(call.filters['guild_id']).toBe(GUILD_ID);
      expect(call.filters['club_id']).toBe(CLUB_ID);
      return { data: [{ id: LOG_ID }] };
    });
    setHandler('guild_club_logs:select', () => ({ data: [] }));

    await expect(
      removeClubLog({ actor: actor(), guildId: GUILD_ID, clubId: CLUB_ID }),
    ).resolves.toEqual([]);
    expect(mocks.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'club_log.removed', targetId: CLUB_ID }),
      expect.any(Object),
    );
  });

  it('removes only the selected period and keeps a log that still has another period', async () => {
    setHandler('guild_club_logs:select', () => ({ data: [logRow()] }));
    setHandler('clubs:select', () => ({ data: [clubRow()] }));
    setHandler('guild_club_log_periods:delete', (call) => {
      expect(call.filters['guild_id']).toBe(GUILD_ID);
      expect(call.filters['period']).toBe('today');
      expect(call.inValues).toEqual({ column: 'log_id', values: [LOG_ID] });
      return { data: [{ log_id: LOG_ID }] };
    });
    setHandler('guild_club_log_periods:select', () => ({
      data: [{ log_id: LOG_ID, period: 'season' }],
    }));

    const logs = await removeClubLog({
      actor: actor(),
      guildId: GUILD_ID,
      clubId: CLUB_ID,
      period: 'today',
    });

    expect(callsFor('guild_club_logs', 'delete')).toHaveLength(0);
    expect(logs[0]?.periods).toEqual(['season']);
    expect(mocks.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'club_log.removed',
        details: expect.objectContaining({ period: 'today' }),
      }),
      expect.any(Object),
    );
  });

  it('deletes the parent log when its last period is removed', async () => {
    setHandler('guild_club_logs:select', () => ({ data: [logRow()] }));
    setHandler('guild_club_logs:delete', (call) => {
      expect(call.filters['guild_id']).toBe(GUILD_ID);
      expect(call.filters['club_id']).toBe(CLUB_ID);
      expect(call.inValues).toEqual({ column: 'id', values: [LOG_ID] });
      return { data: [{ id: LOG_ID }] };
    });
    setHandler('guild_club_log_periods:delete', () => ({ data: [{ log_id: LOG_ID }] }));
    setHandler('guild_club_log_periods:select', () => ({ data: [] }));

    await expect(
      removeClubLog({
        actor: actor(),
        guildId: GUILD_ID,
        clubId: CLUB_ID,
        period: 'today',
      }),
    ).resolves.toEqual([]);
    expect(callsFor('guild_club_logs', 'delete')).toHaveLength(1);
  });

  it('writes delivery rows with the guild id and ignores foreign log ids', async () => {
    setHandler('guild_club_logs:select', () => ({ data: [logRow()] }));
    setHandler('clubs:select', () => ({ data: [clubRow()] }));
    setHandler('guild_club_log_deliveries:upsert', (call) => {
      expect(call.options).toEqual({
        onConflict: 'guild_id,log_id,period,event_kind,event_id',
        ignoreDuplicates: true,
      });
      expect(call.payload).toEqual([
        {
          guild_id: GUILD_ID,
          log_id: LOG_ID,
          period: 'week',
          event_kind: 'role',
          event_id: 'r1',
        },
      ]);
      return { data: [] };
    });

    await markClubLogEventsDelivered(GUILD_ID, [
      { logId: LOG_ID, period: 'week', kind: 'role', eventId: 'r1' },
      {
        logId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        period: 'today',
        kind: 'membership',
        eventId: 'm1',
      },
    ]);
    expect(callsFor('guild_club_log_deliveries', 'upsert')).toHaveLength(1);
  });
});

describe('digest post ledger', () => {
  it('reads only this guild’s posted windows and ignores invalid rows', async () => {
    setHandler('guild_club_log_digest_posts:select', (call) => {
      expect(call.filters['guild_id']).toBe(GUILD_ID);
      return {
        data: [
          { log_id: LOG_ID, period: 'today', period_key: '2026-11-21', message_id: 'message-1' },
          { log_id: LOG_ID, period: 'week', period_key: '2026-11-16', message_id: 'message-2' },
          { log_id: LOG_ID, period: 'today', period_key: '2026-11-22', message_id: 'claim:abc' },
          { log_id: LOG_ID, period: 'month', period_key: '2026-11-01', message_id: 'message-3' },
          { log_id: LOG_ID, period: 'nonsense', period_key: '2026-11-01', message_id: 'message-4' },
          { period: 'today', period_key: '2026-11-20', message_id: 'message-5' },
        ],
      };
    });

    const posted = await readPostedClubLogDigests(GUILD_ID);

    expect([...posted]).toEqual([
      `${LOG_ID}:today:2026-11-21`,
      `${LOG_ID}:week:2026-11-16`,
    ]);
  });

  it('writes digest rows with the guild id and ignores foreign logs', async () => {
    setHandler('guild_club_logs:select', () => ({ data: [logRow()] }));
    setHandler('clubs:select', () => ({ data: [clubRow()] }));
    setHandler('guild_club_log_periods:select', () => ({ data: [] }));
    setHandler('guild_club_log_digest_posts:upsert', (call) => {
      expect(call.options).toEqual({
        onConflict: 'guild_id,log_id,period,period_key',
        ignoreDuplicates: false,
      });
      expect(call.payload).toEqual([
        {
          guild_id: GUILD_ID,
          log_id: LOG_ID,
          period: 'season',
          period_key: '2026-12-03',
          channel_id: CHANNEL_ID,
          message_id: 'message-1',
        },
      ]);
      return { data: [] };
    });

    await markClubLogDigestPosted(GUILD_ID, [
      {
        logId: LOG_ID,
        period: 'season',
        periodKey: '2026-12-03',
        channelId: CHANNEL_ID,
        messageId: 'message-1',
      },
      {
        logId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        period: 'today',
        periodKey: '2026-11-21',
        channelId: CHANNEL_ID,
        messageId: 'message-2',
      },
    ]);

    expect(callsFor('guild_club_log_digest_posts', 'upsert')).toHaveLength(1);
  });

  it('claims only winning windows with invisible sentinels and reclaims stale ones', async () => {
    setHandler('guild_club_logs:select', () => ({ data: [logRow()] }));
    setHandler('clubs:select', () => ({ data: [clubRow()] }));
    setHandler('guild_club_log_periods:select', () => ({ data: [] }));
    setHandler('guild_club_log_digest_posts:delete', () => ({ data: [] }));
    setHandler('guild_club_log_digest_posts:upsert', (call) => ({
      data: (call.payload as Array<Record<string, unknown>>).map((row) => ({ ...row })),
    }));

    const result = await claimClubLogDigestWindows(
      GUILD_ID,
      [
        { logId: LOG_ID, period: 'today', periodKey: '2026-11-21', channelId: CHANNEL_ID },
        { logId: LOG_ID, period: 'week', periodKey: '2026-11-16', channelId: CHANNEL_ID },
        {
          logId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          period: 'today',
          periodKey: '2026-11-21',
          channelId: CHANNEL_ID,
        },
      ],
      { now: new Date('2026-11-22T00:10:00.000Z') },
    );

    expect(result.claimId).not.toBe('');
    expect([...result.keys].sort()).toEqual([
      `${LOG_ID}:today:2026-11-21`,
      `${LOG_ID}:week:2026-11-16`,
    ]);
    const stale = callsFor('guild_club_log_digest_posts', 'delete')[0];
    expect(stale?.filters['guild_id']).toBe(GUILD_ID);
    expect(stale?.likeValue).toEqual({ column: 'message_id', value: 'claim:%' });
    expect(stale?.ltValue).toEqual({
      column: 'created_at',
      value: '2026-11-22T00:00:00.000Z',
    });
    const insert = callsFor('guild_club_log_digest_posts', 'upsert')[0];
    expect(insert?.options).toEqual({
      onConflict: 'guild_id,log_id,period,period_key',
      ignoreDuplicates: true,
    });
    const rows = insert?.payload as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => String(row['message_id']).startsWith('claim:'))).toBe(true);
    expect(rows.every((row) => row['guild_id'] === GUILD_ID)).toBe(true);
  });

  it('returns only keys this caller actually inserted', async () => {
    setHandler('guild_club_logs:select', () => ({ data: [logRow()] }));
    setHandler('clubs:select', () => ({ data: [clubRow()] }));
    setHandler('guild_club_log_periods:select', () => ({ data: [] }));
    setHandler('guild_club_log_digest_posts:delete', () => ({ data: [] }));
    setHandler('guild_club_log_digest_posts:upsert', (call) => ({
      data: (call.payload as Array<Record<string, unknown>>)
        .slice(0, 1)
        .map((row) => ({ ...row })),
    }));

    const result = await claimClubLogDigestWindows(GUILD_ID, [
      { logId: LOG_ID, period: 'today', periodKey: '2026-11-21', channelId: CHANNEL_ID },
      { logId: LOG_ID, period: 'week', periodKey: '2026-11-16', channelId: CHANNEL_ID },
    ]);

    expect([...result.keys]).toEqual([`${LOG_ID}:today:2026-11-21`]);
  });

  it('releases only the exact sentinels owned by this claim', async () => {
    setHandler('guild_club_log_digest_posts:delete', () => ({ data: [] }));
    const firstKey = `${LOG_ID}:today:2026-11-21`;
    const secondKey = `${LOG_ID}:week:2026-11-16`;

    await releaseClubLogDigestClaims(GUILD_ID, 'claim-1', [firstKey, secondKey]);

    const released = callsFor('guild_club_log_digest_posts', 'delete')[0];
    expect(released?.filters['guild_id']).toBe(GUILD_ID);
    expect(released?.inValues).toEqual({
      column: 'message_id',
      values: [`claim:claim-1:${firstKey}`, `claim:claim-1:${secondKey}`],
    });
  });
});
