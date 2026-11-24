import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';
import { provisionIdentity } from './provision';

const DISCORD_ID = '111111111111111111';
const AUTH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHADOW_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLUB_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CLUB_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

type Row = Record<string, unknown>;
type Operation = 'select' | 'insert' | 'upsert' | 'update' | 'delete';

interface Call {
  readonly table: string;
  readonly operation: Operation;
  readonly payload: unknown;
  readonly options: unknown;
  readonly filters: Record<string, unknown>;
}

type Handler = (call: Call) => { data?: unknown; error?: unknown };

function matches(row: unknown, filters: Record<string, unknown>): boolean {
  if (row === null || typeof row !== 'object') return false;
  const value = row as Row;
  return Object.entries(filters).every(([column, expected]) =>
    expected === null ? (value[column] ?? null) === null : value[column] === expected,
  );
}

function sameGrantKey(left: Row, right: Row): boolean {
  return (
    left['user_id'] === right['user_id'] &&
    left['scope'] === right['scope'] &&
    (left['club_id'] ?? null) === (right['club_id'] ?? null)
  );
}

const fake = vi.hoisted(() => ({
  state: {
    tables: {
      profiles: [] as Row[],
      discord_users: [] as Row[],
      user_roles: [] as Row[],
    },
    handlers: {} as Record<string, Handler | undefined>,
    calls: [] as Call[],
  },
}));

vi.mock('@brawlhub/database', () => {
  class FakeQuery {
    private operation: Operation = 'select';
    private payload: unknown;
    private options: unknown;
    private readonly filters: Record<string, unknown> = {};
    private mode: 'array' | 'maybeSingle' = 'array';

    constructor(private readonly table: string) {}

    select(_columns?: string, options?: unknown): this {
      this.operation = 'select';
      this.options = options;
      return this;
    }

    insert(payload: unknown): this {
      this.operation = 'insert';
      this.payload = payload;
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

    maybeSingle(): this {
      this.mode = 'maybeSingle';
      return this;
    }

    private execute(): Promise<{ data: unknown; error: unknown }> {
      const call: Call = {
        table: this.table,
        operation: this.operation,
        payload: this.payload,
        options: this.options,
        filters: { ...this.filters },
      };
      fake.state.calls.push(call);
      const custom = fake.state.handlers[`${this.table}:${this.operation}`];
      const result = custom === undefined ? { data: [], error: null } : custom(call);
      let data: unknown = result.data ?? null;
      const error = result.error ?? null;
      if (Array.isArray(data)) data = data.filter((row) => matches(row, this.filters));
      if (this.mode === 'maybeSingle' && Array.isArray(data)) data = data[0] ?? null;
      return Promise.resolve({ data, error });
    }

    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return this.execute().then(onfulfilled, onrejected);
    }
  }

  return { createTrustedClient: () => ({ from: (table: string) => new FakeQuery(table) }) };
});

function user(): User {
  return {
    id: AUTH_ID,
    app_metadata: {},
    user_metadata: { provider_id: DISCORD_ID, username: ' Player ' },
    aud: 'authenticated',
    created_at: '2026-11-24T00:00:00.000Z',
  } as User;
}

function callsFor(table: string, operation: Operation): Call[] {
  return fake.state.calls.filter((call) => call.table === table && call.operation === operation);
}

beforeEach(() => {
  fake.state.tables.profiles = [];
  fake.state.tables.discord_users = [];
  fake.state.tables.user_roles = [];
  fake.state.handlers = {};
  fake.state.calls = [];

  fake.state.handlers['profiles:select'] = () => ({ data: fake.state.tables.profiles });
  fake.state.handlers['profiles:upsert'] = ({ payload }) => {
    const row = payload as Row;
    fake.state.tables.profiles = fake.state.tables.profiles.filter(
      (item) => item['id'] !== row['id'] && item['discord_user_id'] !== row['discord_user_id'],
    );
    fake.state.tables.profiles.push({ ...row });
    return { data: [row] };
  };
  fake.state.handlers['profiles:update'] = ({ payload, filters }) => {
    for (const row of fake.state.tables.profiles) {
      if (matches(row, filters)) Object.assign(row, payload);
    }
    return { data: [] };
  };
  fake.state.handlers['discord_users:upsert'] = ({ payload }) => {
    const row = payload as Row;
    fake.state.tables.discord_users = [row];
    return { data: [row] };
  };
  fake.state.handlers['user_roles:select'] = () => ({ data: fake.state.tables.user_roles });
  fake.state.handlers['user_roles:upsert'] = ({ payload, options }) => {
    const rows = (Array.isArray(payload) ? payload : [payload]) as Row[];
    const ignoreDuplicates = (options as { ignoreDuplicates?: boolean } | undefined)?.ignoreDuplicates === true;
    for (const row of rows) {
      const existing = fake.state.tables.user_roles.findIndex((item) => sameGrantKey(item, row));
      if (existing >= 0) {
        if (!ignoreDuplicates) fake.state.tables.user_roles[existing] = { ...row };
        continue;
      }
      fake.state.tables.user_roles.push({ ...row });
    }
    return { data: rows };
  };
  fake.state.handlers['user_roles:delete'] = ({ filters }) => {
    fake.state.tables.user_roles = fake.state.tables.user_roles.filter(
      (row) => !matches(row, filters),
    );
    return { data: [] };
  };
});

describe('provisionIdentity', () => {
  it('reconciles grants without deleting untouched rows first', async () => {
    fake.state.tables.user_roles = [
      { user_id: AUTH_ID, scope: 'global', club_id: null, role: 'admin', source: 'discord', granted_by: null },
      {
        user_id: AUTH_ID,
        scope: 'club',
        club_id: CLUB_A,
        role: 'owner',
        source: 'manual',
        granted_by: SHADOW_ID,
      },
      { user_id: AUTH_ID, scope: 'club', club_id: CLUB_B, role: 'member', source: 'discord', granted_by: null },
    ];

    await provisionIdentity({
      user: user(),
      grants: [
        { scope: 'global', clubId: null, role: 'member' },
        { scope: 'club', clubId: CLUB_A, role: 'member' },
      ],
    });

    const deletes = callsFor('user_roles', 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.filters).toMatchObject({ user_id: AUTH_ID, scope: 'club', club_id: CLUB_B });
    expect(deletes[0]?.filters['club_id']).not.toBeNull();

    const upserts = callsFor('user_roles', 'upsert');
    expect(upserts.length).toBeGreaterThanOrEqual(1);
    const saved = upserts.flatMap((call) => (Array.isArray(call.payload) ? call.payload : [call.payload])) as Row[];
    expect(saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: AUTH_ID,
          scope: 'global',
          club_id: null,
          role: 'member',
          source: 'discord',
          granted_by: null,
        }),
        expect.objectContaining({
          user_id: AUTH_ID,
          scope: 'club',
          club_id: CLUB_A,
          role: 'owner',
          source: 'manual',
          granted_by: SHADOW_ID,
        }),
      ]),
    );
  });

  it('reclaims a bot-created shadow profile without losing its role grants', async () => {
    fake.state.tables.profiles = [
      { id: SHADOW_ID, discord_user_id: DISCORD_ID, username: 'shadow' },
    ];
    fake.state.tables.discord_users = [
      { discord_user_id: DISCORD_ID, profile_id: SHADOW_ID, username: 'shadow' },
    ];
    fake.state.tables.user_roles = [
      {
        user_id: SHADOW_ID,
        scope: 'club',
        club_id: CLUB_A,
        role: 'staff',
        source: 'manual',
        granted_by: SHADOW_ID,
      },
    ];

    const identity = await provisionIdentity({ user: user(), grants: [] });

    expect(identity).toEqual({ id: DISCORD_ID, username: 'Player', avatarUrl: null });
    expect(fake.state.tables.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: SHADOW_ID, discord_user_id: `shadow:${AUTH_ID}` }),
        expect.objectContaining({ id: AUTH_ID, discord_user_id: DISCORD_ID, username: 'Player' }),
      ]),
    );
    expect(fake.state.tables.discord_users[0]).toMatchObject({
      discord_user_id: DISCORD_ID,
      profile_id: AUTH_ID,
    });
    expect(fake.state.tables.user_roles).toEqual([
      expect.objectContaining({ user_id: AUTH_ID, club_id: CLUB_A, role: 'staff', source: 'manual' }),
    ]);
  });
});
