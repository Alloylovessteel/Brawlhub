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

interface InactivityLedgerRow {
  guild_id: string;
  period_key: string;
  channel_id: string;
  message_id: string;
}

interface DiscordCall {
  method: 'post' | 'patch';
  route: string;
  options: unknown;
}

interface SettingsRow {
  guild_id: string;
  overview_channel_id: string | null;
  report_daily_channel_id: string | null;
  report_weekly_channel_id: string | null;
  report_monthly_channel_id: string | null;
  report_inactivity_days: number | null;
  report_inactivity_channel_id: string | null;
  reports_enabled_at: string | null;
}

interface RequestedPeriod {
  type: string;
  period_key: string;
  period_start: string;
  period_end: string;
}

interface MissingDeliveryRow {
  guild_id: string;
  channel_id: string;
  report_type: string;
  period_key: string;
  period_start: string;
  period_end: string;
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
  inactivityLedger: [] as InactivityLedgerRow[],
  discordCalls: [] as DiscordCall[],
  discordToken: undefined as string | undefined,
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

vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeRest {
    setToken(): this {
      return this;
    }

    async post(route: string, options: unknown): Promise<{ id: string }> {
      fake.discordCalls.push({ method: 'post', route, options });
      return { id: 'scheduled-message' };
    }

    async patch(route: string, options: unknown): Promise<{ id: string }> {
      fake.discordCalls.push({ method: 'patch', route, options });
      return { id: 'scheduled-message' };
    }
  }
  return { ...actual, REST: FakeRest };
});

import {
  loadReportData,
  postScheduledReport,
  readMissingReportDeliveries,
  runScheduledReports,
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

const OVERRIDE_CHANNEL_ID = '333333333333333333';

const ALL_CLUBS = [
  { id: CLUB_A, tag: 'AAAA', name: 'Alpha' },
  { id: CLUB_B, tag: 'BBBB', name: 'Beta' },
  { id: CLUB_OTHER_GUILD, tag: 'CCCC', name: 'Other Guild' },
];

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
];

// Guild totals come from their own RPC and count cross-club transfers once.
const TOTALS_ROW = {
  joins: 1,
  leaves: 1,
  transfers: 1,
  role_changes: 3,
  capacity_opens: 1,
  capacity_closes: 1,
};

let clubFixture: Array<{ id: string; tag: string; name: string }> = [];
let activityFixture: Array<(typeof ACTIVITY_ROWS)[number]> = [];

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

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function pageLimit(args: Record<string, unknown>): number {
  const value = Number(args['p_limit'] ?? 1000);
  return Math.min(1000, Math.max(1, Number.isFinite(value) ? value : 1000));
}

function setClubFixture(rows: readonly { id: string; tag: string; name: string }[]): void {
  clubFixture = rows.map((row) => ({ ...row }));
}

function setActivityFixture(rows: readonly (typeof ACTIVITY_ROWS)[number][]): void {
  activityFixture = rows.map((row) => ({ ...row }));
}

function installAggregationHandlers(): void {
  setClubFixture(ALL_CLUBS);
  setActivityFixture(ACTIVITY_ROWS);

  setRpc('push_report_clubs', (args) => {
    const afterName = optionalString(args['p_after_name']);
    const afterId = optionalString(args['p_after_id']);
    const rows = clubFixture
      .filter((club) =>
        args['p_guild_id'] === GUILD_ID
          ? club.id !== CLUB_OTHER_GUILD
          : club.id === CLUB_OTHER_GUILD,
      )
      .filter(
        (club) =>
          afterName === null ||
          club.name > afterName ||
          (club.name === afterName && afterId !== null && club.id > afterId),
      )
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : left.id < right.id ? -1 : 1,
      )
      .slice(0, pageLimit(args));
    return { data: rows };
  });
  setRpc('push_report_activity_totals', () => ({ data: [TOTALS_ROW] }));
  setRpc('push_report_activity', (args) => {
    const afterId = optionalString(args['p_after_id']);
    const rows = activityFixture
      .filter((row) => afterId === null || row.club_id > afterId)
      .sort((left, right) => (left.club_id < right.club_id ? -1 : 1))
      .slice(0, pageLimit(args));
    return { data: rows };
  });
}

beforeEach(() => {
  fake.calls = [];
  fake.ledger = [];
  fake.inactivityLedger = [];
  fake.discordCalls = [];
  fake.discordToken = undefined;
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
      'push_report_activity_totals',
      'push_report_activity',
    ]);
    expect(rpcCalls[0]?.payload).toEqual({ p_guild_id: GUILD_ID, p_limit: 1000 });
    expect(rpcCalls[1]?.payload).toEqual({
      p_guild_id: GUILD_ID,
      p_start: PERIOD.start.toISOString(),
      p_end: PERIOD.end.toISOString(),
    });
    expect(rpcCalls[2]?.payload).toEqual({
      p_guild_id: GUILD_ID,
      p_start: PERIOD.start.toISOString(),
      p_end: PERIOD.end.toISOString(),
      p_limit: 1000,
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

  it('pages past 1000 clubs by name and id without dropping the tail', async () => {
    const clubs = Array.from({ length: 1005 }, (_, index) => {
      const suffix = String(index).padStart(4, '0');
      return { id: `club-${suffix}`, tag: `C${suffix}`, name: `Club ${suffix}` };
    });
    setClubFixture(clubs);

    const data = await loadReportData(GUILD_ID, PERIOD);

    expect(data.clubSummaries).toHaveLength(1005);
    expect(data.clubSummaries[0]?.clubId).toBe(clubs[0]?.id);
    expect(data.clubSummaries.at(-1)?.clubId).toBe(clubs.at(-1)?.id);
    expect(data.totals.clubs).toBe(1005);
    const clubCalls = fake.calls.filter(
      (call) => call.operation === 'rpc' && call.table === 'push_report_clubs',
    );
    expect(clubCalls).toHaveLength(2);
    expect(clubCalls[0]?.payload).toEqual({ p_guild_id: GUILD_ID, p_limit: 1000 });
    expect(clubCalls[1]?.payload).toEqual({
      p_guild_id: GUILD_ID,
      p_limit: 1000,
      p_after_name: clubs[999]?.name,
      p_after_id: clubs[999]?.id,
    });
  });

  it('pages past 1000 activity rows by club id without dropping the tail', async () => {
    const clubs = Array.from({ length: 1005 }, (_, index) => {
      const suffix = String(index).padStart(4, '0');
      return { id: `club-${suffix}`, tag: `C${suffix}`, name: `Club ${suffix}` };
    });
    const rows = clubs.map((club) => ({
      club_id: club.id,
      joins: 1,
      leaves: 0,
      transfers: 0,
      role_changes: 0,
      capacity_opens: 0,
      capacity_closes: 0,
    }));
    setClubFixture(clubs);
    setActivityFixture(rows);

    const data = await loadReportData(GUILD_ID, PERIOD);

    expect(data.clubSummaries).toHaveLength(1005);
    expect(data.clubSummaries.every((summary) => summary.joins === 1)).toBe(true);
    expect(data.totals).toEqual({
      clubs: 1005,
      joins: TOTALS_ROW.joins,
      leaves: TOTALS_ROW.leaves,
      transfers: TOTALS_ROW.transfers,
      roleChanges: TOTALS_ROW.role_changes,
      capacityOpens: TOTALS_ROW.capacity_opens,
      capacityCloses: TOTALS_ROW.capacity_closes,
    });
    const activityCalls = fake.calls.filter(
      (call) => call.operation === 'rpc' && call.table === 'push_report_activity',
    );
    expect(activityCalls).toHaveLength(2);
    expect(activityCalls[0]?.payload).toMatchObject({ p_limit: 1000 });
    expect(activityCalls[0]?.payload).not.toHaveProperty('p_after_id');
    expect(activityCalls[1]?.payload).toMatchObject({
      p_limit: 1000,
      p_after_id: clubs[999]?.id,
    });
  });

  it('returns zeroed totals for a guild with no active clubs', async () => {
    setRpc('push_report_clubs', () => ({ data: [] }));
    setRpc('push_report_activity_totals', () => ({
      data: [
        {
          joins: 0,
          leaves: 0,
          transfers: 0,
          role_changes: 0,
          capacity_opens: 0,
          capacity_closes: 0,
        },
      ],
    }));
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
        embeds: [],
        attachments: [expect.objectContaining({ id: '0', filename: expect.stringMatching(/\.png$/) })],
      }),
      files: [expect.objectContaining({ key: 'files[0]', contentType: 'image/png' })],
    });
    const [, payload] = post.mock.calls[0] as unknown as [string, { files: { data: Buffer }[] }];
    expect(payload.files[0]?.data.subarray(0, 8)).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'));
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
      body: expect.objectContaining({ embeds: [], attachments: [expect.objectContaining({ id: '0' })] }),
      files: [expect.objectContaining({ key: 'files[0]', contentType: 'image/png' })],
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

  it('releases a fresh claim when Discord definitively rejects the post', async () => {
    const patch = vi.fn(async () => ({ id: 'unused' }));
    const post = vi.fn(async () => {
      throw Object.assign(new Error('Missing Access'), { status: 403, code: 50001 });
    });

    const result = await callPost(fakeRest(patch, post));

    expect(result.posted).toBe(false);
    expect(result.uncertain).toBeUndefined();
    expect(result.error).toContain('Missing Access');
    expect(fake.ledger).toEqual([]);
  });

  it('keeps a fresh claim when the post outcome is ambiguous', async () => {
    const patch = vi.fn(async () => ({ id: 'unused' }));
    const post = vi.fn(async () => {
      throw new Error('request timed out');
    });

    const result = await callPost(fakeRest(patch, post));

    expect(result.posted).toBe(false);
    expect(result.uncertain).toBe(true);
    expect(fake.ledger[0]?.message_id).toMatch(/^claim:[^:]+:sending$/);
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
      body: expect.objectContaining({ embeds: [] }),
      files: [expect.objectContaining({ contentType: 'image/png' })],
    });
    expect(post).not.toHaveBeenCalled();
    expect(fake.ledger[0]?.message_id).toBe('recovered-message');
  });
});

describe('readMissingReportDeliveries', () => {
  const NOW = new Date('2026-11-20T17:00:00.000Z');
  const INACTIVITY_KEY = '2026-11-20';
  const ENABLED_AT = '2025-01-01T00:00:00.000Z';
  const THIRD_GUILD_ID = '888888888888888888';
  const RETENTION: Readonly<Record<ReportType, number>> = { daily: 31, weekly: 8, monthly: 12 };
  let settingsFixture: SettingsRow[] = [];

  function defaultSettings(): SettingsRow[] {
    return [GUILD_ID, OTHER_GUILD_ID].map((guildId) => ({
      guild_id: guildId,
      overview_channel_id: CHANNEL_ID,
      report_daily_channel_id: null,
      report_weekly_channel_id: null,
      report_monthly_channel_id: null,
      report_inactivity_days: 1,
      report_inactivity_channel_id: null,
      reports_enabled_at: ENABLED_AT,
    }));
  }

  function setSettings(rows: readonly SettingsRow[]): void {
    settingsFixture = rows.map((row) => ({ ...row }));
  }

  function typeRank(value: string): number {
    return value === 'daily' ? 1 : value === 'weekly' ? 2 : 3;
  }

  function channelFor(setting: SettingsRow, type: string): string | null {
    const override =
      type === 'daily'
        ? setting.report_daily_channel_id
        : type === 'weekly'
          ? setting.report_weekly_channel_id
          : setting.report_monthly_channel_id;
    return optionalString(override) ?? optionalString(setting.overview_channel_id);
  }

  function inactivityChannelFor(setting: SettingsRow): string | null {
    return optionalString(setting.report_inactivity_channel_id) ?? optionalString(setting.overview_channel_id);
  }

  function isDelivered(messageId: string | null): boolean {
    if (messageId === null) return false;
    if (messageId.startsWith('claim-delivered:')) {
      const suffix = messageId.slice('claim-delivered:'.length);
      const separator = suffix.indexOf(':');
      return separator !== -1 && suffix.slice(separator + 1).length > 0;
    }
    return !messageId.startsWith('claim:');
  }

  function installDeliveryHandlers(): void {
    setRpc('push_missing_report_deliveries', (args) => {
      const periods = args['p_periods'] as RequestedPeriod[];
      const afterGuildId = optionalString(args['p_after_guild_id']);
      const afterType = optionalString(args['p_after_report_type']);
      const afterKey = optionalString(args['p_after_period_key']);
      const rows: MissingDeliveryRow[] = [];
      for (const setting of settingsFixture) {
        if (setting.reports_enabled_at === null) continue;
        for (const period of periods) {
          if (Date.parse(period.period_end) <= Date.parse(setting.reports_enabled_at)) continue;
          const channelId = channelFor(setting, period.type);
          if (channelId === null) continue;
          const delivered = fake.ledger.find(
            (row) =>
              row.guild_id === setting.guild_id &&
              row.report_type === period.type &&
              row.period_key === period.period_key &&
              isDelivered(row.message_id),
          );
          if (delivered !== undefined) continue;
          rows.push({
            guild_id: setting.guild_id,
            report_type: period.type,
            period_key: period.period_key,
            period_start: period.period_start,
            period_end: period.period_end,
            channel_id: channelId,
          });
        }
      }
      rows.sort(
        (left, right) =>
          (left.guild_id < right.guild_id ? -1 : left.guild_id > right.guild_id ? 1 : 0) ||
          typeRank(left.report_type) - typeRank(right.report_type) ||
          (left.period_key < right.period_key ? -1 : left.period_key > right.period_key ? 1 : 0),
      );
      return {
        data: rows
          .filter(
            (row) =>
              afterGuildId === null ||
              row.guild_id > afterGuildId ||
              (row.guild_id === afterGuildId && afterType !== null && afterKey !== null &&
                (typeRank(row.report_type) > typeRank(afterType) ||
                  (row.report_type === afterType && row.period_key > afterKey))),
          )
          .slice(0, pageLimit(args)),
      };
    });

    setRpc('push_missing_inactivity_deliveries', (args) => {
      const periodKey = String(args['p_period_key']);
      const afterGuildId = optionalString(args['p_after_guild_id']);
      const rows = settingsFixture
        .filter((setting) => {
          if (setting.reports_enabled_at === null) return false;
          if (
            setting.report_inactivity_days === null ||
            setting.report_inactivity_days < 1 ||
            setting.report_inactivity_days > 365
          ) {
            return false;
          }
          if (inactivityChannelFor(setting) === null) return false;
          return !fake.inactivityLedger.some(
            (row) =>
              row.guild_id === setting.guild_id &&
              row.period_key === periodKey &&
              isDelivered(row.message_id),
          );
        })
        .map((setting) => ({
          guild_id: setting.guild_id,
          period_key: periodKey,
          channel_id: inactivityChannelFor(setting) as string,
        }))
        .filter((row) => afterGuildId === null || row.guild_id > afterGuildId)
        .sort((left, right) => (left.guild_id < right.guild_id ? -1 : 1))
        .slice(0, pageLimit(args));
      return { data: rows };
    });
  }

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
    setSettings(defaultSettings());
    installDeliveryHandlers();
  });

  it('enumerates the full explicit retention window from delegated RPC state', async () => {
    const missing = await readMissingReportDeliveries(NOW);

    expect(missing.periods.map((period) => period.periodKey)).toEqual([
      ...catchupKeys('daily'),
      ...catchupKeys('weekly'),
      ...catchupKeys('monthly'),
    ]);
    expect(missing.targets).toHaveLength(2 * (31 + 8 + 12));
    expect(missing.targets[0]).toEqual({
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      period: expect.objectContaining({ type: 'daily', periodKey: catchupKeys('daily')[0] }),
    });
    expect(missing.targets.at(-1)).toEqual({
      guildId: OTHER_GUILD_ID,
      channelId: CHANNEL_ID,
      period: expect.objectContaining({ type: 'monthly', periodKey: catchupKeys('monthly').at(-1) }),
    });
    expect(missing.inactivityPeriodKey).toBe(INACTIVITY_KEY);
    expect(missing.inactivityTargets).toEqual([
      { guildId: GUILD_ID, channelId: CHANNEL_ID, periodKey: INACTIVITY_KEY },
      { guildId: OTHER_GUILD_ID, channelId: CHANNEL_ID, periodKey: INACTIVITY_KEY },
    ]);

    const rpcCalls = fake.calls.filter((call) => call.operation === 'rpc');
    expect(rpcCalls.map((call) => call.table)).toEqual([
      'push_missing_report_deliveries',
      'push_missing_inactivity_deliveries',
    ]);
    const requestedPayload = rpcCalls[0]?.payload['p_periods'];
    expect(Array.isArray(requestedPayload)).toBe(true);
    const requested = requestedPayload as RequestedPeriod[];
    expect(requested).toHaveLength(51);
    expect(requested[0]).toEqual({
      type: 'daily',
      period_key: catchupKeys('daily')[0],
      period_start: expect.any(String),
      period_end: expect.any(String),
    });
    expect(rpcCalls[0]?.payload).toMatchObject({ p_limit: 1000 });
    expect(rpcCalls[0]?.payload).not.toHaveProperty('p_after_guild_id');
    expect(rpcCalls[1]?.payload).toEqual({ p_period_key: INACTIVITY_KEY, p_limit: 1000 });
    expect(fake.calls.some((call) => call.operation === 'select')).toBe(false);
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
    fake.inactivityLedger = [
      { guild_id: GUILD_ID, period_key: INACTIVITY_KEY, channel_id: CHANNEL_ID, message_id: '111' },
      {
        guild_id: OTHER_GUILD_ID,
        period_key: INACTIVITY_KEY,
        channel_id: CHANNEL_ID,
        message_id: '222',
      },
    ];

    const missing = await readMissingReportDeliveries(NOW);

    expect(missing.periods.map((period) => period.type)).toEqual(['weekly']);
    expect(missing.targets).toEqual([
      {
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        period: expect.objectContaining({ type: 'weekly', periodKey: catchupKeys('weekly')[7] }),
      },
    ]);
    expect(missing.inactivityPeriodKey).toBeNull();
    expect(missing.inactivityTargets).toEqual([]);
  });

  it('keeps an old period missing when only one configured guild has a ledger row', async () => {
    setLedger([...catchupRows(GUILD_ID), ...catchupRows(OTHER_GUILD_ID).slice(1)]);

    const missing = await readMissingReportDeliveries(NOW);

    expect(missing.targets).toEqual([
      {
        guildId: OTHER_GUILD_ID,
        channelId: CHANNEL_ID,
        period: expect.objectContaining({ type: 'daily', periodKey: catchupKeys('daily')[0] }),
      },
    ]);
    expect(missing.periods.map((period) => period.periodKey)).toEqual([catchupKeys('daily')[0]]);
  });

  it('keeps the inactivity day missing when only one configured guild has a ledger row', async () => {
    fake.inactivityLedger = [
      { guild_id: GUILD_ID, period_key: INACTIVITY_KEY, channel_id: CHANNEL_ID, message_id: '111' },
    ];

    const missing = await readMissingReportDeliveries(NOW);

    expect(missing.inactivityPeriodKey).toBe(INACTIVITY_KEY);
    expect(missing.inactivityTargets).toEqual([
      { guildId: OTHER_GUILD_ID, channelId: CHANNEL_ID, periodKey: INACTIVITY_KEY },
    ]);
  });

  it('only considers opted-in guilds and periods that ended after reports_enabled_at', async () => {
    setSettings([
      ...defaultSettings(),
      {
        guild_id: THIRD_GUILD_ID,
        overview_channel_id: CHANNEL_ID,
        report_daily_channel_id: null,
        report_weekly_channel_id: null,
        report_monthly_channel_id: null,
        report_inactivity_days: 1,
        report_inactivity_channel_id: null,
        reports_enabled_at: '2026-10-01T00:00:00.000Z',
      },
      {
        guild_id: '777777777777777777',
        overview_channel_id: CHANNEL_ID,
        report_daily_channel_id: null,
        report_weekly_channel_id: null,
        report_monthly_channel_id: null,
        report_inactivity_days: 1,
        report_inactivity_channel_id: null,
        reports_enabled_at: null,
      },
    ]);

    const missing = await readMissingReportDeliveries(NOW);
    const lateTargets = missing.targets.filter((target) => target.guildId === THIRD_GUILD_ID);

    expect(missing.targets.some((target) => target.guildId === '777777777777777777')).toBe(false);
    expect(lateTargets.length).toBeGreaterThan(0);
    expect(lateTargets.length).toBeLessThan(51);
    expect(
      lateTargets.some(
        (target) => target.period.type === 'monthly' && target.period.periodKey === '2026-09',
      ),
    ).toBe(false);
    expect(
      lateTargets.some(
        (target) => target.period.type === 'monthly' && target.period.periodKey === '2026-10',
      ),
    ).toBe(true);
  });

  it('includes the period in progress at opt-in when it is later completed', async () => {
    const rollout = new Date('2026-11-26T17:00:00.000Z');
    setSettings([
      {
        guild_id: THIRD_GUILD_ID,
        overview_channel_id: CHANNEL_ID,
        report_daily_channel_id: null,
        report_weekly_channel_id: null,
        report_monthly_channel_id: null,
        report_inactivity_days: 1,
        report_inactivity_channel_id: null,
        reports_enabled_at: rollout.toISOString(),
      },
    ]);
    setLedger([]);

    const missing = await readMissingReportDeliveries(new Date('2026-12-01T01:00:00.000Z'));
    const keys = (type: string): string[] =>
      missing.targets
        .filter((target) => target.guildId === THIRD_GUILD_ID && target.period.type === type)
        .map((target) => target.period.periodKey);

    expect(keys('daily')).toContain('2026-11-26');
    expect(keys('daily')).not.toContain('2026-11-25');
    expect(keys('weekly')).toContain('2026-W48');
    expect(keys('weekly')).not.toContain('2026-W47');
    expect(keys('monthly')).toContain('2026-11');
    expect(keys('monthly')).not.toContain('2026-10');
  });

  it('uses the report-channel override returned by the RPC', async () => {
    setSettings(
      defaultSettings().map((setting) =>
        setting.guild_id === GUILD_ID
          ? { ...setting, report_daily_channel_id: OVERRIDE_CHANNEL_ID }
          : setting,
      ),
    );

    const missing = await readMissingReportDeliveries(NOW);

    expect(
      missing.targets.find(
        (target) => target.guildId === GUILD_ID && target.period.type === 'daily',
      )?.channelId,
    ).toBe(OVERRIDE_CHANNEL_ID);
    expect(
      missing.targets.find(
        (target) => target.guildId === GUILD_ID && target.period.type === 'weekly',
      )?.channelId,
    ).toBe(CHANNEL_ID);
  });

  it('pages missing deliveries by guild, type and period key', async () => {
    const guilds = Array.from({ length: 1001 }, (_, index) => {
      const suffix = String(index).padStart(4, '0');
      return {
        guild_id: `guild-${suffix}`,
        overview_channel_id: CHANNEL_ID,
        report_daily_channel_id: null,
        report_weekly_channel_id: null,
        report_monthly_channel_id: null,
        report_inactivity_days: 1,
        report_inactivity_channel_id: null,
        reports_enabled_at: ENABLED_AT,
      };
    });
    setSettings(guilds);
    // Keep the fixture focused on paging: one due period per guild still
    // crosses the 1,000-row REST boundary without building 51k target objects.
    setRpc('push_missing_report_deliveries', (args) => {
      const periods = args['p_periods'] as RequestedPeriod[];
      const daily = periods.find((period) => period.type === 'daily');
      if (daily === undefined) return { data: [] };
      const afterGuildId = optionalString(args['p_after_guild_id']);
      const rows: MissingDeliveryRow[] = settingsFixture
        .filter((setting) => afterGuildId === null || setting.guild_id > afterGuildId)
        .map((setting) => ({
          guild_id: setting.guild_id,
          report_type: 'daily',
          period_key: daily.period_key,
          period_start: daily.period_start,
          period_end: daily.period_end,
          channel_id: CHANNEL_ID,
        }));
      return { data: rows.slice(0, pageLimit(args)) };
    });

    const missing = await readMissingReportDeliveries(NOW);

    expect(missing.targets).toHaveLength(1001);
    expect(missing.periods.map((period) => period.periodKey)).toEqual([catchupKeys('daily')[0]]);
    expect(missing.inactivityTargets).toHaveLength(1001);
    expect(missing.inactivityTargets[0]).toEqual({
      guildId: 'guild-0000',
      channelId: CHANNEL_ID,
      periodKey: INACTIVITY_KEY,
    });
    const deliveryCalls = fake.calls.filter(
      (call) => call.operation === 'rpc' && call.table === 'push_missing_report_deliveries',
    );
    expect(deliveryCalls).toHaveLength(2);
    expect(deliveryCalls[0]?.payload).not.toHaveProperty('p_after_guild_id');
    expect(deliveryCalls[1]?.payload).toMatchObject({
      p_limit: 1000,
      p_after_guild_id: 'guild-0999',
      p_after_report_type: 'daily',
      p_after_period_key: catchupKeys('daily')[0],
    });
    const inactivityCalls = fake.calls.filter(
      (call) => call.operation === 'rpc' && call.table === 'push_missing_inactivity_deliveries',
    );
    expect(inactivityCalls).toHaveLength(2);
    expect(inactivityCalls[1]?.payload).toMatchObject({
      p_period_key: INACTIVITY_KEY,
      p_limit: 1000,
      p_after_guild_id: 'guild-0999',
    });
  });
});

describe('runScheduledReports', () => {
  it('posts to the channel from the target and never re-reads guild_settings', async () => {
    process.env.DISCORD_TOKEN = TOKEN;
    setRpc('push_missing_report_deliveries', () => ({
      data: [
        {
          guild_id: GUILD_ID,
          channel_id: OVERRIDE_CHANNEL_ID,
          report_type: 'daily',
          period_key: PERIOD.periodKey,
          period_start: PERIOD.start.toISOString(),
          period_end: PERIOD.end.toISOString(),
        },
      ],
    }));
    setRpc('push_missing_inactivity_deliveries', () => ({ data: [] }));

    try {
      const result = await runScheduledReports(new Date('2026-11-20T17:00:00Z'), ['daily']);

      expect(result).toEqual({ failedTypes: [], skippedTypes: [], claimedTypes: ['daily'] });
      expect(
        fake.calls.some(
          (call) => call.operation === 'select' && call.table === 'guild_settings',
        ),
      ).toBe(false);
      expect(fake.discordCalls).toHaveLength(1);
      expect(fake.discordCalls[0]).toMatchObject({
        method: 'post',
        route: Routes.channelMessages(OVERRIDE_CHANNEL_ID),
      });
    } finally {
      delete process.env.DISCORD_TOKEN;
    }
  });
});
