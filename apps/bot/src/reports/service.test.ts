import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Routes, type REST } from 'discord.js';

interface Call {
  table: string;
  operation: 'select' | 'insert' | 'upsert' | 'delete';
  payload: any;
  options: any;
  filters: Record<string, unknown>;
  inValues: { column: string; values: unknown[] } | null;
  range: { gte: string | null; lt: string | null };
  orValue: string | null;
  orderBy: { column: string; options: unknown } | null;
  limit: number | null;
  mode: 'array' | 'maybeSingle';
}

type Handler = (call: Call) => { data?: unknown; error?: unknown } | Promise<{ data?: unknown; error?: unknown }>;

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
    private range: Call['range'] = { gte: null, lt: null };
    private orValue: string | null = null;
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

    gte(column: string, value: string): this {
      expect(column).toBe('detected_at');
      this.range.gte = value;
      return this;
    }

    lt(column: string, value: string): this {
      expect(column).toBe('detected_at');
      this.range.lt = value;
      return this;
    }

    or(value: string): this {
      this.orValue = value;
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
        range: { ...this.range },
        orValue: this.orValue,
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

import { loadReportData, postScheduledReport, readMissingReportDeliveries } from './service';
import { currentReportPeriod } from './period';

const GUILD_ID = '111111111111111111';
const OTHER_GUILD_ID = '999999999999999999';
const CLUB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLUB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLUB_OTHER_GUILD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CLUB_ARCHIVED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CHANNEL_ID = '222222222222222222';
const TOKEN = 'test-token-abcdef';

const PERIOD = currentReportPeriod(new Date('2026-11-20T00:00:05Z'), 'daily');

const CLUB_ROWS: Record<string, unknown>[] = [
  { id: CLUB_A, tag: 'AAAA', name: 'Alpha', guild_id: GUILD_ID, archived_at: null },
  { id: CLUB_B, tag: 'BBBB', name: 'Beta', guild_id: GUILD_ID, archived_at: null },
  { id: CLUB_OTHER_GUILD, tag: 'CCCC', name: 'Other Guild', guild_id: OTHER_GUILD_ID, archived_at: null },
  { id: CLUB_ARCHIVED, tag: 'DDDD', name: 'Archived', guild_id: GUILD_ID, archived_at: '2026-10-01T00:00:00Z' },
];

const MEMBERSHIP_ROWS: Record<string, unknown>[] = [
  { id: 'e1', event_type: 'join', from_club_id: null, to_club_id: CLUB_A, detected_at: '2026-11-19T12:00:00Z' },
  { id: 'e2', event_type: 'leave', from_club_id: CLUB_B, to_club_id: null, detected_at: '2026-11-19T13:00:00Z' },
  { id: 'e3', event_type: 'transfer', from_club_id: CLUB_B, to_club_id: CLUB_A, detected_at: '2026-11-19T14:00:00Z' },
  { id: 'e4', event_type: 'join', from_club_id: null, to_club_id: CLUB_OTHER_GUILD, detected_at: '2026-11-19T15:00:00Z' },
  { id: 'e5', event_type: 'join', from_club_id: null, to_club_id: CLUB_A, detected_at: '2026-11-18T23:59:59Z' },
];

const ROLE_ROWS: Record<string, unknown>[] = [
  { club_id: CLUB_A, detected_at: '2026-11-19T08:00:00Z' },
  { club_id: CLUB_A, detected_at: '2026-11-19T09:00:00Z' },
  { club_id: CLUB_B, detected_at: '2026-11-19T10:00:00Z' },
  { club_id: CLUB_OTHER_GUILD, detected_at: '2026-11-19T11:00:00Z' },
  { club_id: CLUB_A, detected_at: '2026-11-18T23:00:00Z' },
];

const CAPACITY_ROWS: Record<string, unknown>[] = [
  { club_id: CLUB_A, is_full: false, detected_at: '2026-11-19T08:30:00Z' },
  { club_id: CLUB_B, is_full: true, detected_at: '2026-11-19T09:30:00Z' },
  { club_id: CLUB_OTHER_GUILD, is_full: false, detected_at: '2026-11-19T10:30:00Z' },
  { club_id: CLUB_A, is_full: false, detected_at: '2026-11-18T23:30:00Z' },
];

function setHandler(key: string, handler: Handler): void {
  fake.handlers[key] = handler;
}

function inWindow(call: Call, value: unknown): boolean {
  const timestamp = Date.parse(String(value));
  const start = call.range.gte === null ? Number.NEGATIVE_INFINITY : Date.parse(call.range.gte);
  const end = call.range.lt === null ? Number.POSITIVE_INFINITY : Date.parse(call.range.lt);
  return timestamp >= start && timestamp < end;
}

function installHistoryHandlers(): void {
  setHandler('clubs:select', (call) => ({
    data: CLUB_ROWS.filter(
      (row) =>
        row['guild_id'] === call.filters['guild_id'] &&
        (call.filters['archived_at'] === null ? row['archived_at'] === null : true),
    ),
  }));

  setHandler('membership_events:select', (call) => {
    const column = call.inValues?.column;
    const allowed = new Set((call.inValues?.values ?? []).map(String));
    return {
      data: MEMBERSHIP_ROWS.filter((row) => {
        const clubId = column === 'to_club_id' ? row['to_club_id'] : row['from_club_id'];
        return typeof clubId === 'string' && allowed.has(clubId) && inWindow(call, row['detected_at']);
      }),
    };
  });

  setHandler('club_role_changes:select', (call) => {
    const allowed = new Set((call.inValues?.values ?? []).map(String));
    return {
      data: ROLE_ROWS.filter(
        (row) => allowed.has(String(row['club_id'])) && inWindow(call, row['detected_at']),
      ),
    };
  });

  setHandler('club_capacity_events:select', (call) => {
    const allowed = new Set((call.inValues?.values ?? []).map(String));
    return {
      data: CAPACITY_ROWS.filter(
        (row) => allowed.has(String(row['club_id'])) && inWindow(call, row['detected_at']),
      ),
    };
  });
}

beforeEach(() => {
  fake.handlers = {};
  fake.calls = [];
  installHistoryHandlers();
});

describe('loadReportData', () => {
  it('counts stored events once for the guild even when both transfer clubs are local', async () => {
    const data = await loadReportData(GUILD_ID, PERIOD);

    expect(data.period).toBe(PERIOD);
    expect(data.clubSummaries).toEqual([
      {
        clubId: CLUB_A,
        tag: 'AAAA',
        name: 'Alpha',
        joins: 1,
        leaves: 0,
        transfers: 1,
        roleChanges: 2,
        capacityOpens: 1,
        capacityCloses: 0,
      },
      {
        clubId: CLUB_B,
        tag: 'BBBB',
        name: 'Beta',
        joins: 0,
        leaves: 1,
        transfers: 1,
        roleChanges: 1,
        capacityOpens: 0,
        capacityCloses: 1,
      },
    ]);
    expect(data.totals).toEqual({
      clubs: 2,
      joins: 1,
      leaves: 1,
      transfers: 1,
      roleChanges: 3,
      capacityOpens: 1,
      capacityCloses: 1,
    });

    const clubCall = fake.calls.find((call) => call.table === 'clubs');
    expect(clubCall?.filters).toMatchObject({ guild_id: GUILD_ID, archived_at: null });
    expect(clubCall?.orderBy?.column).toBe('name');
    expect(clubCall?.limit).toBe(25);

    for (const call of fake.calls.filter(
      (entry) =>
        entry.table === 'membership_events' ||
        entry.table === 'club_role_changes' ||
        entry.table === 'club_capacity_events',
    )) {
      expect(call.inValues?.values).toEqual([CLUB_A, CLUB_B]);
      expect(call.range).toEqual({
        gte: PERIOD.start.toISOString(),
        lt: PERIOD.end.toISOString(),
      });
    }
  });

  it('returns zeroed totals for a guild with no active clubs', async () => {
    setHandler('clubs:select', () => ({ data: [] }));

    const data = await loadReportData(GUILD_ID, PERIOD);
    expect(data.clubSummaries).toEqual([]);
    expect(data.totals).toEqual({
      clubs: 0,
      joins: 0,
      leaves: 0,
      transfers: 0,
      roleChanges: 0,
      capacityOpens: 0,
      capacityCloses: 0,
    });
  });
});

describe('postScheduledReport', () => {
  function fakeRest(
    patch: ReturnType<typeof vi.fn>,
    post: ReturnType<typeof vi.fn>,
  ): REST {
    return { patch, post } as unknown as REST;
  }

  /** Simulate an atomic reserve: null existing means this caller wins. */
  function installReservation(
    existingMessageId: string | null,
    finalUpsert: Handler = () => ({ data: null }),
  ): void {
    let insertedClaim: string | null = null;
    setHandler('guild_report_posts:upsert', (call) => {
      const options = call.options as Record<string, unknown> | undefined;
      if (options?.['ignoreDuplicates'] !== true) return finalUpsert(call);
      const payload = call.payload as Record<string, unknown>;
      insertedClaim = typeof payload['message_id'] === 'string' ? payload['message_id'] : null;
      return {
        data: existingMessageId === null ? [{ message_id: insertedClaim }] : [],
      };
    });
    setHandler('guild_report_posts:select', () => ({
      data:
        existingMessageId === null
          ? insertedClaim === null
            ? null
            : { message_id: insertedClaim, channel_id: CHANNEL_ID }
          : { message_id: existingMessageId, channel_id: CHANNEL_ID },
    }));
  }

  it('edits the existing message and records the same message ID', async () => {
    const upsert = vi.fn(() => ({ data: null }));
    installReservation('existing-message', upsert);
    const patch = vi.fn(async () => ({ id: 'existing-message' }));
    const post = vi.fn(async () => ({ id: 'unused' }));

    const result = await postScheduledReport({
      rest: fakeRest(patch, post),
      guildId: GUILD_ID,
      period: PERIOD,
      channelId: CHANNEL_ID,
      token: TOKEN,
      guildLabel: 'Test Guild',
    });

    expect(result).toEqual({ posted: true, messageId: 'existing-message', claimed: false });
    const reserve = fake.calls.find(
      (call) =>
        call.table === 'guild_report_posts' &&
        call.operation === 'upsert' &&
        (call.options as Record<string, unknown> | undefined)?.['ignoreDuplicates'] === true,
    );
    expect(reserve?.options).toEqual({
      onConflict: 'guild_id,report_type,period_key',
      ignoreDuplicates: true,
    });
    expect(patch).toHaveBeenCalledWith(Routes.channelMessage(CHANNEL_ID, 'existing-message'), {
      body: expect.objectContaining({ embeds: expect.any(Array) }),
    });
    expect(post).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledOnce();
    const upsertCall = fake.calls.find(
      (call) =>
        call.table === 'guild_report_posts' &&
        call.operation === 'upsert' &&
        (call.options as Record<string, unknown> | undefined)?.['ignoreDuplicates'] !== true,
    );
    expect(upsertCall?.payload).toMatchObject({
      guild_id: GUILD_ID,
      report_type: 'daily',
      period_key: PERIOD.periodKey,
      channel_id: CHANNEL_ID,
      message_id: 'existing-message',
    });
    expect(upsertCall?.options).toEqual({ onConflict: 'guild_id,report_type,period_key' });
  });

  it('posts a new message and upserts the ledger row when none exists', async () => {
    const upsert = vi.fn(() => ({ data: null }));
    installReservation(null, upsert);
    const patch = vi.fn(async () => ({ id: 'unused' }));
    const post = vi.fn(async () => ({ id: 'new-message' }));

    const result = await postScheduledReport({
      rest: fakeRest(patch, post),
      guildId: GUILD_ID,
      period: PERIOD,
      channelId: CHANNEL_ID,
      token: TOKEN,
      guildLabel: null,
    });

    expect(result).toEqual({ posted: true, messageId: 'new-message', claimed: true });
    expect(patch).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(Routes.channelMessages(CHANNEL_ID), {
      body: expect.objectContaining({ embeds: expect.any(Array) }),
    });
    expect(upsert).toHaveBeenCalledOnce();
    expect(
      fake.calls.find(
        (call) =>
          call.operation === 'upsert' &&
          (call.options as Record<string, unknown> | undefined)?.['ignoreDuplicates'] !== true,
      )?.payload,
    ).toMatchObject({
      message_id: 'new-message',
      channel_id: CHANNEL_ID,
      guild_id: GUILD_ID,
      report_type: 'daily',
      period_key: PERIOD.periodKey,
    });
  });

  it('reports an unrecorded post and keeps the recovered ID in the sentinel', async () => {
    const upsert = vi.fn(() => ({ data: null, error: { message: 'ledger down' } }));
    installReservation(null, upsert);
    const patch = vi.fn(async () => ({ id: 'unused' }));
    const post = vi.fn(async () => ({ id: 'new-message' }));

    const result = await postScheduledReport({
      rest: fakeRest(patch, post),
      guildId: GUILD_ID,
      period: PERIOD,
      channelId: CHANNEL_ID,
      token: TOKEN,
      guildLabel: null,
    });

    expect(result).toMatchObject({
      posted: true,
      messageId: 'new-message',
      recorded: false,
      claimed: true,
      error: expect.stringContaining('ledger down'),
    });
    expect(upsert).toHaveBeenCalledTimes(3);
    const sentinelWrite = fake.calls.filter(
      (call) => call.table === 'guild_report_posts' && call.operation === 'upsert',
    ).at(-1);
    expect((sentinelWrite?.payload as Record<string, unknown>)['message_id']).toMatch(
      /^claim-delivered:.*:new-message$/,
    );
  });

  it('keeps the edited message ID when recording an existing report fails', async () => {
    const upsert = vi.fn(() => ({ data: null, error: { message: 'ledger down' } }));
    installReservation('existing-message', upsert);
    const patch = vi.fn(async () => ({ id: 'edited-message' }));
    const post = vi.fn(async () => ({ id: 'unused' }));

    const result = await postScheduledReport({
      rest: fakeRest(patch, post),
      guildId: GUILD_ID,
      period: PERIOD,
      channelId: CHANNEL_ID,
      token: TOKEN,
      guildLabel: null,
    });

    expect(result).toMatchObject({ posted: true, messageId: 'edited-message', recorded: false });
    expect(post).not.toHaveBeenCalled();
    const sentinelWrite = fake.calls.filter(
      (call) => call.table === 'guild_report_posts' && call.operation === 'upsert',
    ).at(-1);
    expect((sentinelWrite?.payload as Record<string, unknown>)['message_id']).toMatch(
      /^claim-delivered:.*:edited-message$/,
    );
  });

  it('posts a replacement when the stored message is unknown', async () => {
    const upsert = vi.fn(() => ({ data: null }));
    installReservation('deleted-message', upsert);
    const patch = vi.fn(async () => {
      throw { code: 10008, message: 'Unknown Message' };
    });
    const post = vi.fn(async () => ({ id: 'replacement-message' }));

    const result = await postScheduledReport({
      rest: fakeRest(patch, post),
      guildId: GUILD_ID,
      period: PERIOD,
      channelId: CHANNEL_ID,
      token: TOKEN,
      guildLabel: null,
    });

    expect(result).toEqual({ posted: true, messageId: 'replacement-message', claimed: false });
    expect(upsert).toHaveBeenCalledOnce();
    expect(
      fake.calls.find(
        (call) =>
          call.operation === 'upsert' &&
          (call.options as Record<string, unknown> | undefined)?.['ignoreDuplicates'] !== true,
      )?.payload,
    ).toMatchObject({
      message_id: 'replacement-message',
      channel_id: CHANNEL_ID,
    });
  });

  it('redacts the Discord token from errors', async () => {
    installReservation('existing-message');
    const patch = vi.fn(async () => {
      throw new Error(`request failed for ${TOKEN}`);
    });
    const post = vi.fn(async () => ({ id: 'unused' }));

    const result = await postScheduledReport({
      rest: fakeRest(patch, post),
      guildId: GUILD_ID,
      period: PERIOD,
      channelId: CHANNEL_ID,
      token: TOKEN,
      guildLabel: null,
    });

    expect(result.posted).toBe(false);
    expect(result.error).not.toContain(TOKEN);
    expect(result.error).toContain('[REDACTED]');
    expect(post).not.toHaveBeenCalled();
  });

  it('never posts when the channel is blank', async () => {
    const patch = vi.fn(async () => ({ id: 'unused' }));
    const post = vi.fn(async () => ({ id: 'unused' }));

    const result = await postScheduledReport({
      rest: fakeRest(patch, post),
      guildId: GUILD_ID,
      period: PERIOD,
      channelId: '   ',
      token: TOKEN,
      guildLabel: null,
    });

    expect(result.posted).toBe(false);
    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it('skips a period already claimed by another worker', async () => {
    installReservation('claim:other-worker');
    const patch = vi.fn(async () => ({ id: 'unused' }));
    const post = vi.fn(async () => ({ id: 'unused' }));

    const result = await postScheduledReport({
      rest: fakeRest(patch, post),
      guildId: GUILD_ID,
      period: PERIOD,
      channelId: CHANNEL_ID,
      token: TOKEN,
      guildLabel: null,
    });

    expect(result).toEqual({ posted: false, messageId: null, skipped: true });
    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(
      fake.calls.some(
        (call) =>
          call.operation === 'upsert' &&
          (call.options as Record<string, unknown> | undefined)?.['ignoreDuplicates'] !== true,
      ),
    ).toBe(false);
  });

  it('edits a message recovered from a delivered sentinel', async () => {
    const upsert = vi.fn(() => ({ data: null }));
    installReservation('claim-delivered:old-claim:recovered-message', upsert);
    const patch = vi.fn(async () => ({ id: 'recovered-message' }));
    const post = vi.fn(async () => ({ id: 'unused' }));

    const result = await postScheduledReport({
      rest: fakeRest(patch, post),
      guildId: GUILD_ID,
      period: PERIOD,
      channelId: CHANNEL_ID,
      token: TOKEN,
      guildLabel: null,
    });

    expect(result).toEqual({ posted: true, messageId: 'recovered-message', claimed: false });
    expect(patch).toHaveBeenCalledWith(Routes.channelMessage(CHANNEL_ID, 'recovered-message'), {
      body: expect.objectContaining({ embeds: expect.any(Array) }),
    });
    expect(post).not.toHaveBeenCalled();
    const finalUpsert = fake.calls.find(
      (call) =>
        call.operation === 'upsert' &&
        (call.options as Record<string, unknown> | undefined)?.['ignoreDuplicates'] !== true,
    );
    expect((finalUpsert?.payload as Record<string, unknown>)['message_id']).toBe(
      'recovered-message',
    );
  });
});

describe('readMissingReportDeliveries', () => {
  const NOW = new Date('2026-11-20T17:00:00.000Z');
  const SETTINGS = [
    {
      guild_id: GUILD_ID,
      overview_channel_id: CHANNEL_ID,
      report_daily_channel_id: null,
      report_weekly_channel_id: null,
      report_monthly_channel_id: null,
      report_inactivity_days: 1,
      report_inactivity_channel_id: null,
    },
    {
      guild_id: OTHER_GUILD_ID,
      overview_channel_id: CHANNEL_ID,
      report_daily_channel_id: null,
      report_weekly_channel_id: null,
      report_monthly_channel_id: null,
      report_inactivity_days: 1,
      report_inactivity_channel_id: null,
    },
  ];

  beforeEach(() => {
    setHandler('guild_settings:select', () => ({ data: SETTINGS }));
    setHandler('guild_report_posts:select', () => ({ data: [] }));
    setHandler('guild_inactivity_report_posts:select', () => ({ data: [] }));
  });

  it('returns the latest completed periods when no durable messages exist', async () => {
    const missing = await readMissingReportDeliveries(NOW);

    expect(missing.periods.map((period) => period.periodKey)).toEqual([
      '2026-11-19',
      '2026-W46',
      '2026-10',
    ]);
    expect(missing.inactivityPeriodKey).toBe('2026-11-20');
  });

  it('treats real and delivered-sentinel messages as durable but ignores plain claims', async () => {
    setHandler('guild_report_posts:select', () => ({
      data: [
        { guild_id: GUILD_ID, report_type: 'daily', period_key: '2026-11-19', message_id: '123' },
        { guild_id: OTHER_GUILD_ID, report_type: 'daily', period_key: '2026-11-19', message_id: '456' },
        { guild_id: GUILD_ID, report_type: 'weekly', period_key: '2026-W46', message_id: 'claim:claim-1' },
        {
          guild_id: OTHER_GUILD_ID,
          report_type: 'weekly',
          period_key: '2026-W46',
          message_id: 'claim-delivered:c:recovered',
        },
        {
          guild_id: GUILD_ID,
          report_type: 'monthly',
          period_key: '2026-10',
          message_id: 'claim-delivered:c:recovered',
        },
        { guild_id: OTHER_GUILD_ID, report_type: 'monthly', period_key: '2026-10', message_id: '789' },
      ],
    }));
    setHandler('guild_inactivity_report_posts:select', () => ({
      data: [
        { guild_id: GUILD_ID, period_key: '2026-11-20', message_id: '111' },
        { guild_id: OTHER_GUILD_ID, period_key: '2026-11-20', message_id: '222' },
      ],
    }));

    const missing = await readMissingReportDeliveries(NOW);

    expect(missing.periods.map((period) => period.type)).toEqual(['weekly']);
    expect(missing.inactivityPeriodKey).toBeNull();
  });

  it('keeps a period missing when only one configured guild has a ledger row', async () => {
    setHandler('guild_report_posts:select', () => ({
      data: [
        { guild_id: GUILD_ID, report_type: 'daily', period_key: '2026-11-19', message_id: '123' },
      ],
    }));

    const missing = await readMissingReportDeliveries(NOW);

    expect(missing.periods.map((period) => period.type)).toEqual(['daily', 'weekly', 'monthly']);
  });

  it('keeps the inactivity day missing when only one configured guild has a ledger row', async () => {
    setHandler('guild_inactivity_report_posts:select', () => ({
      data: [{ guild_id: GUILD_ID, period_key: '2026-11-20', message_id: '111' }],
    }));

    const missing = await readMissingReportDeliveries(NOW);

    expect(missing.inactivityPeriodKey).toBe('2026-11-20');
  });
});
