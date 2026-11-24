import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Routes, type REST } from 'discord.js';

type Operation = 'select' | 'insert' | 'upsert' | 'delete' | 'update' | 'rpc';

interface LedgerRow {
  guild_id: string;
  report_type: string;
  period_key: string;
  channel_id: string;
  message_id: string;
}

interface Call {
  table: string;
  operation: Operation;
  payload: any;
  options: any;
  filters: Record<string, unknown>;
  orValue: string | null;
  mode: 'array' | 'maybeSingle';
}

type RpcHandler = (args: Record<string, unknown>) => {
  data?: unknown;
  error?: unknown;
};
type SelectHandler = (call: Call) => { data?: unknown; error?: unknown };

const fake = vi.hoisted(() => ({
  calls: [] as Call[],
  ledger: [] as LedgerRow[],
  rpcHandlers: {} as Record<string, RpcHandler | undefined>,
  selectHandlers: {} as Record<string, SelectHandler | undefined>,
  upsertFailures: 0,
  upsertErrorMessage: 'ledger down',
}));

function matches(row: LedgerRow, filters: Record<string, unknown>): boolean {
  return Object.entries(filters).every(([column, value]) => row[column as keyof LedgerRow] === value);
}

function ledgerKey(row: Pick<LedgerRow, 'guild_id' | 'report_type' | 'period_key'>): string {
  return `${row.guild_id}:${row.report_type}:${row.period_key}`;
}

vi.mock('@brawlhub/database', () => {
  class FakeQuery {
    private operation: Operation = 'select';
    private payload: unknown = undefined;
    private options: unknown = undefined;
    private filters: Record<string, unknown> = {};
    private orValue: string | null = null;
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

    or(value: string): this {
      this.orValue = value;
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
        orValue: this.orValue,
        mode: this.mode,
      };
      fake.calls.push(call);

      if (this.table === 'guild_report_posts') {
        return this.executeLedger(call);
      }
      if (this.operation === 'select') {
        const result = fake.selectHandlers[this.table]?.(call) ?? {};
        return {
          data: result.data === undefined ? (this.mode === 'maybeSingle' ? null : []) : result.data,
          error: result.error === undefined ? null : result.error,
        };
      }
      return { data: [], error: null };
    }

    async executeLedger(call: Call): Promise<{ data: unknown; error: unknown }> {
      if (call.operation === 'select') {
        const rows = fake.ledger.filter((row) => matches(row, call.filters));
        return { data: call.mode === 'maybeSingle' ? (rows[0] ?? null) : rows, error: null };
      }

      if (call.operation === 'upsert') {
        const payload = call.payload as LedgerRow;
        const options = (call.options ?? {}) as Record<string, unknown>;
        const index = fake.ledger.findIndex((row) => ledgerKey(row) === ledgerKey(payload));
        if (options['ignoreDuplicates'] === true) {
          if (index !== -1) return { data: [], error: null };
          fake.ledger.push({ ...payload });
          return { data: [{ ...payload }], error: null };
        }
        if (fake.upsertFailures > 0) {
          fake.upsertFailures -= 1;
          return { data: null, error: { message: fake.upsertErrorMessage } };
        }
        if (index === -1) fake.ledger.push({ ...payload });
        else fake.ledger[index] = { ...payload };
        return { data: [{ ...payload }], error: null };
      }

      if (call.operation === 'update') {
        const updates = call.payload as Partial<LedgerRow>;
        const updated: LedgerRow[] = [];
        fake.ledger = fake.ledger.map((row) => {
          if (!matches(row, call.filters)) return row;
          const next = { ...row, ...updates };
          updated.push(next);
          return next;
        });
        return { data: updated, error: null };
      }

      if (call.operation === 'delete') {
        fake.ledger = fake.ledger.filter((row) => !matches(row, call.filters));
        return { data: [], error: null };
      }
      return { data: [], error: null };
    }
  }

  return {
    createTrustedClient: () => ({
      from: (table: string) => new FakeQuery(table),
      rpc: async (name: string, args: Record<string, unknown>) => {
        const call: Call = {
          table: name,
          operation: 'rpc',
          payload: args,
          options: undefined,
          filters: {},
          orValue: null,
          mode: 'array',
        };
        fake.calls.push(call);
        const result = fake.rpcHandlers[name]?.(args) ?? {};
        return {
          data: result.data === undefined ? [] : result.data,
          error: result.error === undefined ? null : result.error,
        };
      },
    }),
  };
});

import {
  loadReportData,
  postScheduledReport,
  readMissingReportDeliveries,
} from './service';
import {
  currentReportPeriod,
  latestCompletedReportPeriod,
  previousCompletedReportPeriod,
  type ReportType,
} from './period';

const GUILD_ID = '111111111111111111';
const OTHER_GUILD_ID = '999999999999999999';
const CLUB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLUB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLUB_OTHER_GUILD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CHANNEL_ID = '222222222222222222';
const TOKEN = 'test-token-abcdef';

const PERIOD = currentReportPeriod(new Date('2026-11-20T00:00:05Z'), 'daily');

const ACTIVITY_ROWS = [
  {
    club_id: CLUB_A,
    joins: 1,
    leaves: 0,
    transfers: 1,
    role_changes: 2,
    capacity_opens: 1,
    capacity_closes: 0,
  },
  {
    club_id: CLUB_B,
    joins: 0,
    leaves: 1,
    transfers: 1,
    role_changes: 1,
    capacity_opens: 0,
    capacity_closes: 1,
  },
  // Guild totals are counted once even for transfers between two local clubs.
  {
    club_id: null,
    joins: 1,
    leaves: 1,
    transfers: 1,
    role_changes: 3,
    capacity_opens: 1,
    capacity_closes: 1,
  },
];

function ledgerRow(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    guild_id: GUILD_ID,
    report_type: PERIOD.type,
    period_key: PERIOD.periodKey,
    channel_id: CHANNEL_ID,
    message_id: '123456789',
    ...overrides,
  };
}

function setLedger(rows: readonly LedgerRow[]): void {
  fake.ledger = rows.map((row) => ({ ...row }));
}

function setRpc(name: string, handler: RpcHandler): void {
  fake.rpcHandlers[name] = handler;
}

function installAggregationHandlers(): void {
  setRpc('push_report_clubs', (args) => ({
    data: [
      { id: CLUB_A, tag: 'AAAA', name: 'Alpha' },
      { id: CLUB_B, tag: 'BBBB', name: 'Beta' },
    ].filter((club) => args['p_guild_id'] === GUILD_ID || club.id === CLUB_OTHER_GUILD),
  }));
  setRpc('push_report_activity', () => ({ data: ACTIVITY_ROWS }));
}

beforeEach(() => {
  fake.calls = [];
  fake.ledger = [];
  fake.rpcHandlers = {};
  fake.selectHandlers = {};
  fake.upsertFailures = 0;
  fake.upsertErrorMessage = 'ledger down';
  installAggregationHandlers();
});

describe('loadReportData', () => {
  it('uses scoped SQL aggregates so cross-club transfers count once for the guild', async () => {
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

    const rpcCalls = fake.calls.filter((call) => call.operation === 'rpc');
    expect(rpcCalls.map((call) => call.table)).toEqual([
      'push_report_clubs',
      'push_report_activity',
    ]);
    expect(rpcCalls[0]?.payload).toEqual({ p_guild_id: GUILD_ID });
    expect(rpcCalls[1]?.payload).toEqual({
      p_guild_id: GUILD_ID,
      p_start: PERIOD.start.toISOString(),
      p_end: PERIOD.end.toISOString(),
    });
    expect(fake.calls.some((call) => call.operation === 'select')).toBe(false);
  });

  it('does not impose a 25-club limit on report summaries', async () => {
    const clubs = Array.from({ length: 30 }, (_, index) => ({
      id: `club-${index}`,
      tag: `C${index}`,
      name: `Club ${index}`,
    }));
    setRpc('push_report_clubs', () => ({ data: clubs }));

    const data = await loadReportData(GUILD_ID, PERIOD);

    expect(data.clubSummaries).toHaveLength(30);
    expect(data.totals.clubs).toBe(30);
  });

  it('returns zeroed totals for a guild with no active clubs', async () => {
    setRpc('push_report_clubs', () => ({ data: [] }));
    setRpc('push_report_activity', () => ({ data: [] }));

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

  function callPost(
    rest: REST,
    messageId: string | null = null,
  ): Promise<Awaited<ReturnType<typeof postScheduledReport>>> {
    void messageId;
    return postScheduledReport({
      rest,
      guildId: GUILD_ID,
      period: PERIOD,
      channelId: CHANNEL_ID,
      token: TOKEN,
      guildLabel: 'Test Guild',
    });
  }

  function stagedUpdates(): Call[] {
    return fake.calls.filter(
      (call) => call.operation === 'update' && call.table === 'guild_report_posts',
    );
  }

  it('stages a fresh claim through reserved, loading and sending before posting', async () => {
    const patch = vi.fn(async () => ({ id: 'unused' }));
    const post = vi.fn(async () => ({ id: 'new-message' }));

    const result = await callPost(fakeRest(patch, post));

    expect(result).toEqual({ posted: true, messageId: 'new-message', claimed: true });
    expect(patch).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(Routes.channelMessages(CHANNEL_ID), {
      body: expect.objectContaining({
        allowed_mentions: { parse: [] },
        embeds: expect.any(Array),
      }),
    });
    const stages = stagedUpdates().map((call) =>
      String((call.payload as Record<string, unknown>)['message_id']).replace(/^claim:[^:]+:/, ''),
    );
    expect(stages).toEqual(['loading', 'sending']);
    expect(fake.ledger).toHaveLength(1);
    expect(fake.ledger[0]?.message_id).toBe('new-message');
  });

  it('edits an existing message and records the same message ID', async () => {
    setLedger([ledgerRow({ message_id: 'existing-message' })]);
    const patch = vi.fn(async () => ({ id: 'existing-message' }));
    const post = vi.fn(async () => ({ id: 'unused' }));

    const result = await callPost(fakeRest(patch, post));

    expect(result).toEqual({ posted: true, messageId: 'existing-message', claimed: false });
    expect(patch).toHaveBeenCalledWith(Routes.channelMessage(CHANNEL_ID, 'existing-message'), {
      body: expect.objectContaining({ embeds: expect.any(Array) }),
    });
    expect(post).not.toHaveBeenCalled();
    expect(fake.ledger[0]?.message_id).toBe('existing-message');
    expect(
      fake.calls.some(
        (call) => call.operation === 'upsert' && call.options?.['ignoreDuplicates'] !== true,
      ),
    ).toBe(true);
  });

  it('leaves a sending claim when the ledger write fails after a new post', async () => {
    fake.upsertFailures = 2;
    const patch = vi.fn(async () => ({ id: 'unused' }));
    const post = vi.fn(async () => ({ id: 'new-message' }));

    const result = await callPost(fakeRest(patch, post));

    expect(result).toMatchObject({
      posted: true,
      messageId: 'new-message',
      recorded: false,
      claimed: true,
      error: expect.stringContaining('ledger down'),
    });
    expect(fake.ledger[0]?.message_id).toMatch(/^claim:[^:]+:sending$/);
    // No prior Discord ID was persisted, so the outcome cannot be auto-reposted.
    expect(
      fake.calls.filter((call) => call.operation === 'upsert').at(-1)?.payload,
    ).toMatchObject({ message_id: 'new-message' });
  });

  it('keeps the edited message ID in a delivered sentinel when recording fails', async () => {
    setLedger([ledgerRow({ message_id: 'claim-delivered:old-claim:existing-message' })]);
    fake.upsertFailures = 2;
    const patch = vi.fn(async () => ({ id: 'edited-message' }));
    const post = vi.fn(async () => ({ id: 'unused' }));

    const result = await callPost(fakeRest(patch, post));

    expect(result).toMatchObject({ posted: true, messageId: 'edited-message', recorded: false });
    expect(post).not.toHaveBeenCalled();
    expect(fake.ledger[0]?.message_id).toMatch(/^claim-delivered:.*:edited-message$/);
  });

  it('posts a replacement when the stored message is unknown', async () => {
    setLedger([ledgerRow({ message_id: 'deleted-message' })]);
    const patch = vi.fn(async () => {
      throw { code: 10008, message: 'Unknown Message' };
    });
    const post = vi.fn(async () => ({ id: 'replacement-message' }));

    const result = await callPost(fakeRest(patch, post));

    expect(result).toEqual({ posted: true, messageId: 'replacement-message', claimed: false });
    expect(fake.ledger[0]?.message_id).toBe('replacement-message');
  });

  it('redacts the Discord token from errors', async () => {
    setLedger([ledgerRow({ message_id: 'existing-message' })]);
    const patch = vi.fn(async () => {
      throw new Error(`request failed for ${TOKEN}`);
    });
    const post = vi.fn(async () => ({ id: 'unused' }));

    const result = await callPost(fakeRest(patch, post));

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

  it('recovers a known pre-send claim instead of skipping the period', async () => {
    setLedger([ledgerRow({ message_id: 'claim:old-claim:reserved' })]);
    const patch = vi.fn(async () => ({ id: 'unused' }));
    const post = vi.fn(async () => ({ id: 'recovered-message' }));

    const result = await callPost(fakeRest(patch, post));

    expect(result).toEqual({ posted: true, messageId: 'recovered-message', claimed: true });
    const recoverCalls = stagedUpdates();
    expect(String((recoverCalls[0]?.payload as Record<string, unknown>)['message_id'])).toMatch(
      /^claim:[^:]+:reserved$/,
    );
    expect(post).toHaveBeenCalledOnce();
    expect(fake.ledger[0]?.message_id).toBe('recovered-message');
  });

  it('does not repost an uncertain sending claim', async () => {
    setLedger([ledgerRow({ message_id: 'claim:old-claim:sending' })]);
    const patch = vi.fn(async () => ({ id: 'unused' }));
    const post = vi.fn(async () => ({ id: 'unused' }));

    const result = await callPost(fakeRest(patch, post));

    expect(result).toEqual({ posted: false, messageId: null, skipped: true, uncertain: true });
    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(fake.ledger[0]?.message_id).toBe('claim:old-claim:sending');
  });

  it('does not auto-repost a legacy unstaged claim', async () => {
    setLedger([ledgerRow({ message_id: 'claim:old-worker' })]);
    const patch = vi.fn(async () => ({ id: 'unused' }));
    const post = vi.fn(async () => ({ id: 'unused' }));

    const result = await callPost(fakeRest(patch, post));

    expect(result).toEqual({ posted: false, messageId: null, skipped: true, uncertain: true });
    expect(post).not.toHaveBeenCalled();
  });

  it('edits a message recovered from a delivered sentinel', async () => {
    setLedger([ledgerRow({ message_id: 'claim-delivered:old-claim:recovered-message' })]);
    const patch = vi.fn(async () => ({ id: 'recovered-message' }));
    const post = vi.fn(async () => ({ id: 'unused' }));

    const result = await callPost(fakeRest(patch, post));

    expect(result).toEqual({ posted: true, messageId: 'recovered-message', claimed: false });
    expect(patch).toHaveBeenCalledWith(Routes.channelMessage(CHANNEL_ID, 'recovered-message'), {
      body: expect.objectContaining({ embeds: expect.any(Array) }),
    });
    expect(post).not.toHaveBeenCalled();
    expect(fake.ledger[0]?.message_id).toBe('recovered-message');
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
  const RETENTION: Readonly<Record<ReportType, number>> = { daily: 31, weekly: 8, monthly: 12 };

  function catchupKeys(type: ReportType): string[] {
    const keys: string[] = [];
    let period = latestCompletedReportPeriod(NOW, type);
    for (let index = 0; index < RETENTION[type]; index += 1) {
      keys.unshift(period.periodKey);
      period = previousCompletedReportPeriod(period);
    }
    return keys;
  }

  function catchupRows(guildId: string, messageId = '123'): LedgerRow[] {
    const rows: LedgerRow[] = [];
    for (const type of ['daily', 'weekly', 'monthly'] as const) {
      for (const periodKey of catchupKeys(type)) {
        rows.push(
          ledgerRow({
            guild_id: guildId,
            report_type: type,
            period_key: periodKey,
            message_id: messageId,
          }),
        );
      }
    }
    return rows;
  }

  beforeEach(() => {
    fake.selectHandlers['guild_settings'] = () => ({ data: SETTINGS });
    fake.selectHandlers['guild_inactivity_report_posts'] = () => ({ data: [] });
  });

  it('enumerates the full explicit retention window from durable delivery state', async () => {
    const missing = await readMissingReportDeliveries(NOW);

    expect(missing.periods.map((period) => period.periodKey)).toEqual([
      ...catchupKeys('daily'),
      ...catchupKeys('weekly'),
      ...catchupKeys('monthly'),
    ]);
    expect(missing.targets).toHaveLength(2 * (31 + 8 + 12));
    expect(missing.targets[0]).toEqual({
      guildId: GUILD_ID,
      period: expect.objectContaining({ type: 'daily', periodKey: catchupKeys('daily')[0] }),
    });
    expect(missing.targets.at(-1)).toEqual({
      guildId: OTHER_GUILD_ID,
      period: expect.objectContaining({ type: 'monthly', periodKey: catchupKeys('monthly').at(-1) }),
    });
    expect(missing.inactivityPeriodKey).toBe('2026-11-20');
  });

  it('treats delivered sentinels as durable but does not count staged or legacy claims', async () => {
    const rows = [...catchupRows(GUILD_ID), ...catchupRows(OTHER_GUILD_ID)];
    const replaceRow = (next: LedgerRow): void => {
      const index = rows.findIndex((row) => ledgerKey(row) === ledgerKey(next));
      if (index === -1) rows.push(next);
      else rows[index] = next;
    };
    replaceRow(
      ledgerRow({
        guild_id: GUILD_ID,
        report_type: 'weekly',
        period_key: catchupKeys('weekly')[7]!,
        message_id: 'claim:old-claim:reserved',
      }),
    );
    replaceRow(
      ledgerRow({
        guild_id: OTHER_GUILD_ID,
        report_type: 'monthly',
        period_key: catchupKeys('monthly')[7]!,
        message_id: 'claim-delivered:old:recovered',
      }),
    );
    setLedger(rows);
    fake.selectHandlers['guild_inactivity_report_posts'] = () => ({
      data: [
        { guild_id: GUILD_ID, period_key: '2026-11-20', message_id: '111' },
        { guild_id: OTHER_GUILD_ID, period_key: '2026-11-20', message_id: '222' },
      ],
    });

    const missing = await readMissingReportDeliveries(NOW);

    expect(missing.periods.map((period) => period.type)).toEqual(['weekly']);
    expect(missing.targets).toEqual([
      {
        guildId: GUILD_ID,
        period: expect.objectContaining({ type: 'weekly', periodKey: catchupKeys('weekly')[7] }),
      },
    ]);
    expect(missing.inactivityPeriodKey).toBeNull();
  });

  it('keeps an old period missing when only one configured guild has a ledger row', async () => {
    setLedger([...catchupRows(GUILD_ID), ...catchupRows(OTHER_GUILD_ID).slice(1)]);

    const missing = await readMissingReportDeliveries(NOW);

    expect(missing.targets).toEqual([
      {
        guildId: OTHER_GUILD_ID,
        period: expect.objectContaining({ type: 'daily', periodKey: catchupKeys('daily')[0] }),
      },
    ]);
    expect(missing.periods.map((period) => period.periodKey)).toEqual([catchupKeys('daily')[0]]);
  });

  it('keeps the inactivity day missing when only one configured guild has a ledger row', async () => {
    fake.selectHandlers['guild_inactivity_report_posts'] = () => ({
      data: [{ guild_id: GUILD_ID, period_key: '2026-11-20', message_id: '111' }],
    });

    const missing = await readMissingReportDeliveries(NOW);

    expect(missing.inactivityPeriodKey).toBe('2026-11-20');
  });
});
