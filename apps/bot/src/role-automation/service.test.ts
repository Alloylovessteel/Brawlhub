import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Guild, GuildMember } from 'discord.js';

vi.mock('../clubs/service.js', () => ({
  asString: (value: unknown) => (typeof value === 'string' ? value : null),
  asNumber: (value: unknown) => (typeof value === 'number' ? value : null),
  record: (value: unknown) =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null,
  requireOk: (error: { message?: string } | null | undefined, context: string) => {
    if (error !== null && error !== undefined) throw new Error(`${context} failed`);
  },
}));

vi.mock('../admin/service.js', () => ({
  AdminServiceError: class AdminServiceError extends Error {},
  recordAdminAudit: vi.fn(async () => undefined),
}));

vi.mock('../club-roles/service.js', () => ({
  readGuildMembershipRoles: vi.fn(async () => new Map()),
}));

vi.mock('../verification/service.js', () => ({
  listGuildVerifiedLinks: vi.fn(async () => []),
}));

vi.mock('../ranked-roles/service.js', () => ({
  selectGuildMainLinks: (links: readonly unknown[]) => links,
}));

vi.mock('@brawlhub/database', () => ({
  createTrustedClient: () => {
    throw new Error('reconciliation must use the supplied db');
  },
}));

vi.mock('@brawlhub/logging', () => ({
  createLogger: () => ({ info: () => undefined, warn: () => undefined }),
}));

import { reconcileGuildRoles } from './service';

type Row = Record<string, unknown>;

interface QueryCall {
  readonly table: string;
  readonly operation: 'select' | 'insert' | 'update';
  readonly filters: Row;
  readonly patch?: Row;
  readonly row?: Row;
}

const GUILD_ID = '111111111111111111';
const MANAGED_ROLE = '222222222222222222';
const PRESENT_USER = '333333333333333333';
const MISSING_USER = '444444444444444444';
const UNRESOLVED_USER = '555555555555555555';

function createFakeDb() {
  const tables: Record<string, Row[]> = {
    guild_auto_role_configs: [
      {
        guild_id: GUILD_ID,
        role_kind: 'verify',
        tier_key: 'member',
        discord_role_id: MANAGED_ROLE,
        enabled: true,
        priority: 1,
      },
    ],
    guild_managed_roles: [
      { guild_id: GUILD_ID, discord_role_id: MANAGED_ROLE, role_kind: 'verify' },
    ],
    guild_role_assignments: [PRESENT_USER, MISSING_USER, UNRESOLVED_USER].map((userId) => ({
      guild_id: GUILD_ID,
      discord_user_id: userId,
      discord_role_id: MANAGED_ROLE,
      profile_id: null,
      player_id: null,
      source_kind: 'verify',
      source_id: 'member',
      assigned_at: '2026-11-01T00:00:00.000Z',
      revoked_at: null,
    })),
    profiles: [],
    players: [],
    guild_role_sync_runs: [],
  };
  const calls: QueryCall[] = [];

  function from(table: string) {
    const state: {
      operation: QueryCall['operation'];
      filters: Row;
      patch: Row | null;
      row: Row | null;
    } = { operation: 'select', filters: {}, patch: null, row: null };
    const builder: any = {};

    function rowsForTable(): Row[] {
      let rows = [...(tables[table] ?? [])];
      for (const [field, value] of Object.entries(state.filters)) {
        rows = rows.filter((row) => (row[field] ?? null) === value);
      }
      return rows;
    }

    function recordCall(): QueryCall {
      const call: QueryCall = {
        table,
        operation: state.operation,
        filters: { ...state.filters },
        ...(state.operation === 'update' && state.patch !== null ? { patch: state.patch } : {}),
        ...(state.operation === 'insert' && state.row !== null ? { row: state.row } : {}),
      };
      calls.push(call);
      return call;
    }

    async function execute(): Promise<{ data: unknown; error: null }> {
      if (state.operation === 'select') {
        recordCall();
        return { data: rowsForTable(), error: null };
      }
      recordCall();
      if (state.operation === 'insert') {
        const row = { id: `run-${calls.length}`, ...state.row };
        tables[table] = [...(tables[table] ?? []), row];
        return { data: [row], error: null };
      }
      return { data: null, error: null };
    }

    builder.select = () => builder;
    builder.eq = (field: string, value: unknown) => {
      state.filters[field] = value;
      return builder;
    };
    builder.is = (field: string, value: unknown) => {
      state.filters[field] = value;
      return builder;
    };
    builder.in = (field: string, values: unknown[]) => {
      state.filters[field] = values;
      return builder;
    };
    builder.insert = (row: Row) => {
      state.operation = 'insert';
      state.row = row;
      return builder;
    };
    builder.update = (patch: Row) => {
      state.operation = 'update';
      state.patch = patch;
      return builder;
    };
    builder.maybeSingle = async () => {
      recordCall();
      return { data: rowsForTable()[0] ?? null, error: null };
    };
    builder.single = async () => {
      await execute();
      return { data: rowsForTable()[0] ?? null, error: null };
    };
    builder.then = (
      resolve: (value: Awaited<ReturnType<typeof execute>>) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => execute().then(resolve, reject);
    return builder;
  }

  return { db: { from }, calls, tables };
}

function memberFor(userId: string): GuildMember {
  return {
    id: userId,
    roles: {
      cache: new Map([[MANAGED_ROLE, {}]]),
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
  } as unknown as GuildMember;
}

function createGuild(): Guild {
  const members = {
    fetch: vi.fn(async (userId?: string) => {
      if (userId === undefined) throw new Error('member list blocked');
      if (userId === MISSING_USER) throw { code: 10007, message: 'Unknown Member' };
      if (userId === UNRESOLVED_USER) throw new Error('gateway timeout');
      return memberFor(userId);
    }),
  };
  return {
    id: GUILD_ID,
    members,
    roles: { cache: new Map(), fetch: vi.fn(async () => undefined) },
  } as unknown as Guild;
}

describe('reconcileGuildRoles with an unavailable member list', () => {
  let fake: ReturnType<typeof createFakeDb>;
  let guild: Guild;

  beforeEach(() => {
    fake = createFakeDb();
    guild = createGuild();
  });

  it('leaves unconfirmed ledger rows open, revokes only confirmed-missing rows and records a partial run', async () => {
    const result = await reconcileGuildRoles(guild, GUILD_ID, { db: fake.db as any });

    const listFetch = (guild.members.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call.length === 0,
    );
    expect(listFetch).toBeDefined();
    for (const userId of [PRESENT_USER, MISSING_USER, UNRESOLVED_USER]) {
      expect(guild.members.fetch).toHaveBeenCalledWith(userId);
    }

    const revokes = fake.calls.filter(
      (call) => call.table === 'guild_role_assignments' && call.operation === 'update',
    );
    // The present user was read individually and no longer holds a desired
    // role, and the missing user is confirmed absent. The unreadable user stays.
    expect(revokes.map((call) => call.filters['discord_user_id']).sort()).toEqual(
      [PRESENT_USER, MISSING_USER].sort(),
    );
    expect(revokes.every((call) => call.filters['guild_id'] === GUILD_ID)).toBe(true);

    const runUpdate = fake.calls.find(
      (call) => call.table === 'guild_role_sync_runs' && call.operation === 'update',
    );
    expect(runUpdate?.filters['guild_id']).toBe(GUILD_ID);
    expect(runUpdate?.patch).toMatchObject({ status: 'partial' });
    expect(String(runUpdate?.patch?.['last_error'])).toContain('Member list unavailable');
    expect(String(runUpdate?.patch?.['last_error'])).toContain(UNRESOLVED_USER);

    expect(result.membersNotFound).toBe(2);
    expect(result.errorCount).toBe(1);
    expect(fake.calls.filter((call) => call.operation === 'insert').every(
      (call) => call.row?.['guild_id'] === GUILD_ID,
    )).toBe(true);
  });
});
