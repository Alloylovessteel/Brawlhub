import type { SupabaseClient } from '@supabase/supabase-js';
import type { Client, Guild, GuildMember } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  formatNickname,
  loadGuildNicknameSettings,
  normalizePrefix,
  reconcileMemberNickname,
  refreshGuildNicknames,
  releaseManagedNicknamesAfterDisable,
  resolveVerifiedGuildMain,
  selectEligibleGuildMains,
  syncMemberNickname,
  syncNicknameAfterVerification,
} from './service.js';
import type { RegisteredLinkView } from '../verification/service.js';

const GUILD_ID = '1488531664962326571';
const USER_ID = '983248496884875286';
const OTHER_USER_ID = '983248496884875287';
const THIRD_USER_ID = '983248496884875288';
const OWNER_ID = '1488531664962326572';
const PLAYER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PLAYER_ID = '22222222-2222-4222-8222-222222222222';
const TAG = '2C0Y';
const OTHER_TAG = '8Q9V';
const REASON = 'BrawlHub verified player nickname';
const RESTORE_REASON = 'Restore previous nickname after BrawlHub management ended';

type Row = Record<string, unknown>;
type Filter = { readonly op: 'eq' | 'is' | 'in'; readonly column: string; readonly value: unknown };

function matches(row: Row, filters: readonly Filter[]): boolean {
  return filters.every((filter) => {
    const value = row[filter.column];
    if (filter.op === 'eq') return value === filter.value;
    if (filter.op === 'is') return value === filter.value;
    return Array.isArray(filter.value) && filter.value.includes(value);
  });
}

class FakeQuery {
  private operation = 'select';
  private readonly filters: Filter[] = [];
  private resultMode: 'many' | 'maybe' | 'single' = 'many';
  private payload: Row | undefined;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(): this {
    if (this.operation === 'select') return this;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ op: 'eq', column, value });
    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push({ op: 'is', column, value });
    return this;
  }

  in(column: string, value: unknown): this {
    this.filters.push({ op: 'in', column, value });
    return this;
  }

  order(): this {
    return this;
  }

  maybeSingle(): this {
    this.resultMode = 'maybe';
    return this;
  }

  single(): this {
    this.resultMode = 'single';
    return this;
  }

  upsert(payload: Row): this {
    this.operation = 'upsert';
    this.payload = payload;
    return this;
  }

  update(payload: Row): this {
    this.operation = 'update';
    this.payload = payload;
    return this;
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): { data: unknown; error: unknown } {
    const rows = this.db.tables[this.table] ?? [];
    const key = `${this.table}:${this.operation}`;
    const injected = this.db.errors.get(key);
    if (injected !== undefined) {
      this.db.errors.delete(key);
      return { data: null, error: { message: injected } };
    }
    this.db.calls.push({
      table: this.table,
      operation: this.operation,
      filters: [...this.filters],
      payload: this.payload,
    });

    if (this.operation === 'upsert') {
      const payload = this.payload ?? {};
      const keyFields =
        this.table === 'guild_managed_nicknames'
          ? (row: Row) => row['guild_id'] === payload['guild_id'] && row['discord_user_id'] === payload['discord_user_id']
          : (row: Row) => row['guild_id'] === payload['guild_id'];
      const index = rows.findIndex(keyFields);
      if (index >= 0) rows[index] = { ...rows[index], ...payload };
      else rows.push({ ...payload });
      return { data: { ...payload }, error: null };
    }

    const selected = rows.filter((row) => matches(row, this.filters));
    if (this.operation === 'update') {
      for (const row of selected) Object.assign(row, this.payload ?? {});
      return { data: null, error: null };
    }
    if (this.resultMode === 'maybe') return { data: selected[0] ?? null, error: null };
    if (this.resultMode === 'single') {
      return selected.length === 0
        ? { data: null, error: { message: 'no rows' } }
        : { data: selected[0], error: null };
    }
    return { data: [...selected], error: null };
  }
}

class FakeDb {
  readonly calls: Array<{
    readonly table: string;
    readonly operation: string;
    readonly filters: readonly Filter[];
    readonly payload?: Row | undefined;
  }> = [];
  readonly errors = new Map<string, string>();
  readonly tables: Record<string, Row[]>;
  private readonly rpcLinks: Row[];
  private readonly rpcGuildId: string;

  constructor(init: {
    readonly settings?: Row | null;
    readonly links?: Row[];
    readonly ledger?: Row[];
    readonly clubs?: Row[];
    readonly memberships?: Row[];
    readonly rpcGuildId?: string;
  }) {
    this.rpcLinks = (init.links ?? []).map((row) => ({ ...row }));
    this.rpcGuildId = init.rpcGuildId ?? GUILD_ID;
    this.tables = {
      guild_settings: init.settings == null ? [] : [{ ...init.settings }],
      clubs: (init.clubs ?? [{ id: 'club-1' }]).map((row) => ({ ...row })),
      club_memberships: (init.memberships ?? [{ player_id: PLAYER_ID }]).map((row) => ({ ...row })),
      player_verifications: (init.links ?? []).map((row) => ({ ...row })),
      guild_managed_nicknames: (init.ledger ?? []).map((row) => ({ ...row })),
    };
  }

  get client(): SupabaseClient {
    return {
      from: (table: string) => new FakeQuery(this, table),
      rpc: (name: string, args: Row) => this.rpc(name, args),
    } as unknown as SupabaseClient;
  }

  rpc(name: string, args: Row): { data: unknown; error: unknown } {
    this.calls.push({ table: `rpc:${name}`, operation: 'select', filters: [], payload: args });
    const injected = this.errors.get(`${name}:rpc`);
    if (injected !== undefined) {
      this.errors.delete(`${name}:rpc`);
      return { data: null, error: { message: injected } };
    }

    const ledger = this.tables['guild_managed_nicknames'] ?? [];
    const findLedger = () => ledger.find(
      (row) =>
        row['guild_id'] === args['p_guild_id'] &&
        row['discord_user_id'] === args['p_discord_user_id'],
    );
    const now = '2026-11-20T01:00:00.000Z';

    if (name === 'list_guild_verified_links') {
      if (args['p_guild_id'] !== this.rpcGuildId) return { data: [], error: null };
      return { data: this.rpcLinks.map((row) => ({ ...row })), error: null };
    }

    if (name === 'guild_managed_nickname_page') {
      const rows = ledger
        .filter(
          (row) =>
            row['guild_id'] === args['p_guild_id'] &&
            row['released_at'] === null &&
            (args['p_after_discord_user_id'] === null ||
              String(row['discord_user_id']) > String(args['p_after_discord_user_id'])),
        )
        .sort((a, b) => String(a['discord_user_id']).localeCompare(String(b['discord_user_id'])))
        .slice(0, Number(args['p_limit'] ?? 1000));
      return { data: rows.map((row) => ({ ...row })), error: null };
    }

    if (name === 'managed_nickname_intent') {
      const existing = findLedger();
      const pending = {
        pending_cycle_id: args['p_cycle_id'],
        pending_applied_nickname: args['p_applied_nickname'],
        pending_previous_nickname: args['p_previous_nickname'],
        source: args['p_source'],
        source_id: args['p_source_id'],
        player_id: args['p_player_id'],
        player_tag: args['p_player_tag'],
        player_name: args['p_player_name'],
        prefix: args['p_prefix'],
        updated_at: now,
        last_seen_at: now,
      };
      if (existing === undefined) {
        ledger.push({
          guild_id: args['p_guild_id'],
          discord_user_id: args['p_discord_user_id'],
          applied_nickname: args['p_applied_nickname'],
          previous_nickname: args['p_previous_nickname'],
          cycle_id: args['p_cycle_id'],
          confirmed_at: null,
          released_at: null,
          applied_at: now,
          ...pending,
        });
      } else {
        Object.assign(existing, pending);
      }
      return { data: null, error: null };
    }

    if (name === 'managed_nickname_mark_applied') {
      const row = findLedger();
      if (row === undefined || row['released_at'] !== null) return { data: false, error: null };
      const cycleMatchesPending = row['pending_cycle_id'] === args['p_cycle_id'];
      const cycleAlreadyActive =
        row['cycle_id'] === args['p_cycle_id'] && row['pending_cycle_id'] === null;
      if (!cycleMatchesPending && !cycleAlreadyActive) return { data: false, error: null };
      Object.assign(row, {
        cycle_id: args['p_cycle_id'],
        confirmed_at: now,
        applied_nickname: cycleMatchesPending
          ? (row['pending_applied_nickname'] ?? row['applied_nickname'])
          : row['applied_nickname'],
        previous_nickname: cycleMatchesPending
          ? (row['pending_previous_nickname'] ?? row['previous_nickname'])
          : row['previous_nickname'],
        pending_cycle_id: null,
        pending_applied_nickname: null,
        pending_previous_nickname: null,
        source: args['p_source'],
        source_id: args['p_source_id'],
        player_id: args['p_player_id'],
        player_tag: args['p_player_tag'],
        player_name: args['p_player_name'],
        prefix: args['p_prefix'],
        updated_at: now,
        last_seen_at: now,
      });
      return { data: true, error: null };
    }

    if (name === 'managed_nickname_release') {
      const row = findLedger();
      if (
        row === undefined ||
        row['released_at'] !== null ||
        (row['cycle_id'] !== args['p_cycle_id'] && row['pending_cycle_id'] !== args['p_cycle_id'])
      ) {
        return { data: false, error: null };
      }
      Object.assign(row, {
        released_at: now,
        updated_at: now,
        pending_cycle_id: null,
        pending_applied_nickname: null,
        pending_previous_nickname: null,
      });
      return { data: true, error: null };
    }

    return { data: [], error: null };
  }

  failOnce(table: string, operation: string): void {
    this.errors.set(`${table}:${operation}`, 'temporary failure');
  }
}

function settingsRow(overrides: Partial<Row> = {}): Row {
  return {
    guild_id: GUILD_ID,
    nickname_prefix: '[ABC]',
    nickname_sync_enabled: true,
    ...overrides,
  };
}

function linkRow(overrides: Partial<Row> = {}): Row {
  return {
    verification_id: 'v-1',
    player_id: PLAYER_ID,
    discord_user_id: USER_ID,
    username: 'alpha',
    tag: TAG,
    name: 'Alpha',
    is_main: true,
    method: 'api_snapshot',
    verified_at: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}

function ledgerRow(overrides: Partial<Row> = {}): Row {
  return {
    guild_id: GUILD_ID,
    discord_user_id: USER_ID,
    applied_nickname: '[ABC] Alpha',
    previous_nickname: 'Original',
    source: 'verification',
    source_id: 'v-1',
    player_id: PLAYER_ID,
    player_tag: TAG,
    player_name: 'Alpha',
    prefix: '[ABC]',
    applied_at: '2026-11-20T00:00:00.000Z',
    updated_at: '2026-11-20T00:00:00.000Z',
    last_seen_at: '2026-11-20T00:00:00.000Z',
    released_at: null,
    cycle_id: '33333333-3333-4333-8333-333333333333',
    confirmed_at: '2026-11-20T00:00:00.000Z',
    pending_cycle_id: null,
    pending_applied_nickname: null,
    pending_previous_nickname: null,
    ...overrides,
  };
}

interface MemberSpec {
  readonly nickname?: string | null;
  readonly bot?: boolean;
  readonly fetchError?: unknown;
  readonly setNicknameImpl?: (nickname: string | null) => Promise<void>;
}

function fakeGuild(
  specs: Record<string, MemberSpec>,
  ownerId: string = OWNER_ID,
): {
  readonly guild: Guild;
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly setNicknames: Record<string, ReturnType<typeof vi.fn>>;
} {
  const members: Record<string, GuildMember> = {};
  const setNicknames: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const [id, spec] of Object.entries(specs)) {
    const member = {
      id,
      nickname: spec.nickname ?? null,
      user: { bot: spec.bot ?? false },
      setNickname: vi.fn(async (nickname: string | null) => {
        if (spec.setNicknameImpl !== undefined) await spec.setNicknameImpl(nickname);
        (member as { nickname: string | null }).nickname = nickname;
      }),
    } as unknown as GuildMember;
    members[id] = member;
    setNicknames[id] = member.setNickname as ReturnType<typeof vi.fn>;
  }
  const fetch = vi.fn(async (id: string) => {
    const spec = specs[id];
    if (spec === undefined) throw { code: 10007, message: 'Unknown Member' };
    if (spec.fetchError !== undefined) throw spec.fetchError;
    return members[id]!;
  });
  return {
    guild: { id: GUILD_ID, ownerId, members: { fetch } } as unknown as Guild,
    fetch,
    setNicknames,
  };
}

function fakeClient(guild: Guild): { readonly client: Client; readonly fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async () => guild);
  return { client: { guilds: { fetch } } as unknown as Client, fetch };
}

function asLinkView(overrides: Partial<RegisteredLinkView> = {}): RegisteredLinkView {
  return {
    verificationId: 'v-1',
    playerId: PLAYER_ID,
    discordUserId: USER_ID,
    discordUsername: 'alpha',
    tag: TAG,
    name: 'Alpha',
    isMain: true,
    method: 'api_snapshot',
    verifiedAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('nickname formatting', () => {
  it('normalizes a stored club-tag prefix without changing brackets', () => {
    expect(normalizePrefix('  [ABC]  ')).toBe('[ABC]');
    expect(normalizePrefix('[<@123>ABC]')).toBe('[ABC]');
    expect(normalizePrefix('   ')).toBeNull();
  });

  it('formats player names with and without a prefix', () => {
    expect(formatNickname(null, 'Alpha')).toBe('Alpha');
    expect(formatNickname('[ABC]', 'Alpha')).toBe('[ABC] Alpha');
    expect(formatNickname('[ABC]', 'A Very Long Brawl Stars Name')).toHaveLength(32);
  });
});

describe('loadGuildNicknameSettings', () => {
  it('reads the guild-scoped prefix and keeps the opt-out default', async () => {
    const db = new FakeDb({ settings: settingsRow({ nickname_sync_enabled: null }) });

    const settings = await loadGuildNicknameSettings(GUILD_ID, { db: db.client });

    expect(settings).toEqual({ guildId: GUILD_ID, enabled: true, prefix: '[ABC]' });
    expect(db.calls).toEqual([
      {
        table: 'guild_settings',
        operation: 'select',
        filters: [{ op: 'eq', column: 'guild_id', value: GUILD_ID }],
        payload: undefined,
      },
    ]);
  });
});

describe('verified main resolution', () => {
  it('selects an explicit main only when one exists', () => {
    const main = asLinkView();
    const alt = asLinkView({ verificationId: 'v-2', playerId: OTHER_PLAYER_ID, isMain: false });
    expect(selectEligibleGuildMains([alt, main])).toEqual([main]);
  });

  it('treats a single unmarked guild link as the freshly verified main', () => {
    const first = asLinkView({ isMain: false });
    expect(selectEligibleGuildMains([first])).toEqual([first]);
  });

  it('does not guess a main when a user has several unmarked links', () => {
    const first = asLinkView({ isMain: false });
    const second = asLinkView({ verificationId: 'v-2', playerId: OTHER_PLAYER_ID, isMain: false });
    expect(selectEligibleGuildMains([first, second])).toEqual([]);
  });

  it('never trusts a hint when no current guild main exists', async () => {
    const db = new FakeDb({ settings: settingsRow(), links: [] });
    const { guild, setNicknames } = fakeGuild({ [USER_ID]: { nickname: 'Old' } });

    const result = await syncMemberNickname(guild, USER_ID, {
      db: db.client,
      playerNameHint: 'Alpha',
    });

    expect(result).toEqual({ kind: 'not-verified' });
    expect(setNicknames[USER_ID]).not.toHaveBeenCalled();
  });

  it('uses the stored guild main even when the verification hint is stale', async () => {
    const db = new FakeDb({ settings: settingsRow(), links: [linkRow()] });
    const { guild, setNicknames } = fakeGuild({ [USER_ID]: { nickname: 'Old' } });

    const result = await syncMemberNickname(guild, USER_ID, {
      db: db.client,
      playerNameHint: { playerName: 'Stale Hint', playerTag: 'WRONG' },
      source: { source: 'verification', sourceId: 'v-1' },
    });

    expect(result).toEqual({ kind: 'ok', nickname: '[ABC] Alpha' });
    expect(setNicknames[USER_ID]).toHaveBeenCalledWith('[ABC] Alpha', REASON);
    expect(db.tables['guild_managed_nicknames']?.[0]).toMatchObject({
      guild_id: GUILD_ID,
      discord_user_id: USER_ID,
      applied_nickname: '[ABC] Alpha',
      previous_nickname: 'Old',
      source: 'verification',
      source_id: 'v-1',
      player_id: PLAYER_ID,
      player_tag: TAG,
      player_name: 'Alpha',
      prefix: '[ABC]',
      released_at: null,
    });
  });

  it('resolves the first account before verification ever sets is_main', async () => {
    const db = new FakeDb({ settings: settingsRow(), links: [linkRow({ is_main: false })] });
    const { guild, setNicknames } = fakeGuild({ [USER_ID]: { nickname: null } });

    const result = await syncMemberNickname(guild, USER_ID, { db: db.client });

    expect(result.kind).toBe('ok');
    expect(setNicknames[USER_ID]).toHaveBeenCalledWith('[ABC] Alpha', REASON);
  });

  it('does not resolve another guild’s link for the same Discord user', async () => {
    const db = new FakeDb({
      settings: settingsRow(),
      rpcGuildId: '9999999999999999999',
      links: [linkRow()],
    });
    const { guild, setNicknames } = fakeGuild({ [USER_ID]: { nickname: 'Old' } });

    const main = await resolveVerifiedGuildMain(GUILD_ID, USER_ID, null, { db: db.client });
    const result = await syncMemberNickname(guild, USER_ID, { db: db.client });

    expect(main).toBeNull();
    expect(result).toEqual({ kind: 'not-verified' });
    expect(setNicknames[USER_ID]).not.toHaveBeenCalled();
  });
});

describe('syncMemberNickname failures', () => {
  it('maps confirmed-missing members to not-member and transient errors to unresolved', async () => {
    const missingDb = new FakeDb({
      settings: settingsRow(),
      links: [linkRow()],
      ledger: [ledgerRow()],
    });
    const missing = fakeGuild({});
    const missingResult = await syncMemberNickname(missing.guild, USER_ID, {
      db: missingDb.client,
    });
    expect(missingResult.kind).toBe('not-member');
    expect(missingResult.released).toBe(true);
    expect(missingDb.tables['guild_managed_nicknames']?.[0]?.['released_at']).not.toBeNull();

    const transientDb = new FakeDb({ settings: settingsRow(), links: [linkRow()] });
    const transient = fakeGuild({
      [USER_ID]: { nickname: 'Old', fetchError: new Error('Gateway timeout') },
    });
    expect(
      (await syncMemberNickname(transient.guild, USER_ID, { db: transientDb.client })).kind,
    ).toBe('unresolved');
    expect(transient.setNicknames[USER_ID]).not.toHaveBeenCalled();
  });

  it('never edits the owner or a bot and leaves no active ledger row', async () => {
    const db = new FakeDb({
      settings: settingsRow(),
      links: [linkRow({ discord_user_id: OWNER_ID })],
      ledger: [ledgerRow({ discord_user_id: OWNER_ID })],
    });
    const ownerGuild = fakeGuild(
      { [OWNER_ID]: { nickname: 'Owner Nick' } },
      OWNER_ID,
    );
    expect((await syncMemberNickname(ownerGuild.guild, OWNER_ID, { db: db.client })).kind).toBe(
      'skipped-owner',
    );
    expect(ownerGuild.setNicknames[OWNER_ID]).not.toHaveBeenCalled();

    const botDb = new FakeDb({
      settings: settingsRow(),
      links: [linkRow({ discord_user_id: OTHER_USER_ID })],
      ledger: [ledgerRow({ discord_user_id: OTHER_USER_ID })],
    });
    const botGuild = fakeGuild({ [OTHER_USER_ID]: { nickname: 'Bot Nick', bot: true } });
    expect((await syncMemberNickname(botGuild.guild, OTHER_USER_ID, { db: botDb.client })).kind).toBe(
      'skipped-bot',
    );
    expect(botGuild.setNicknames[OTHER_USER_ID]).not.toHaveBeenCalled();
    expect(botDb.tables['guild_managed_nicknames']?.[0]?.['released_at']).not.toBeNull();
  });

  it('keeps only an unconfirmed intent when Discord rejects the nickname change', async () => {
    const db = new FakeDb({ settings: settingsRow(), links: [linkRow()] });
    const { guild, setNicknames } = fakeGuild({
      [USER_ID]: {
        nickname: 'Old',
        setNicknameImpl: async () => {
          throw new Error('Missing Permissions');
        },
      },
    });

    const result = await syncMemberNickname(guild, USER_ID, { db: db.client });

    expect(result.kind).toBe('failed');
    expect(setNicknames[USER_ID]).toHaveBeenCalledOnce();
    expect(db.tables['guild_managed_nicknames']).toHaveLength(1);
    expect(db.tables['guild_managed_nicknames']?.[0]).toMatchObject({
      applied_nickname: '[ABC] Alpha',
      previous_nickname: 'Old',
      confirmed_at: null,
      released_at: null,
    });
    expect(db.tables['guild_managed_nicknames']?.[0]?.['pending_cycle_id']).not.toBeNull();
  });
});

describe('managed nickname ledger preservation', () => {
  it('keeps the original previous nickname when the nickname is unchanged', async () => {
    const db = new FakeDb({
      settings: settingsRow(),
      links: [linkRow()],
      ledger: [ledgerRow({ previous_nickname: 'Original', applied_nickname: '[ABC] Alpha' })],
    });
    const { guild, setNicknames } = fakeGuild({ [USER_ID]: { nickname: '[ABC] Alpha' } });

    const result = await syncMemberNickname(guild, USER_ID, { db: db.client });

    expect(result.kind).toBe('unchanged');
    expect(setNicknames[USER_ID]).not.toHaveBeenCalled();
    expect(db.tables['guild_managed_nicknames']?.[0]).toMatchObject({
      previous_nickname: 'Original',
      applied_nickname: '[ABC] Alpha',
      released_at: null,
    });
  });

  it('keeps the original previous nickname when reapplying after a manual edit', async () => {
    const db = new FakeDb({
      settings: settingsRow({ nickname_prefix: '[XYZ]' }),
      links: [linkRow()],
      ledger: [ledgerRow({ previous_nickname: 'Original', applied_nickname: '[ABC] Alpha' })],
    });
    const { guild, setNicknames } = fakeGuild({ [USER_ID]: { nickname: 'Manual Change' } });

    const result = await syncMemberNickname(guild, USER_ID, { db: db.client });

    expect(result).toEqual({ kind: 'ok', nickname: '[XYZ] Alpha' });
    expect(setNicknames[USER_ID]).toHaveBeenCalledWith('[XYZ] Alpha', REASON);
    expect(db.tables['guild_managed_nicknames']?.[0]).toMatchObject({
      previous_nickname: 'Original',
      applied_nickname: '[XYZ] Alpha',
      prefix: '[XYZ]',
      released_at: null,
    });
  });

  it('never reactivates a released ledger row through a new write intent', async () => {
    const originalRelease = '2026-11-19T00:00:00.000Z';
    const originalConfirmation = '2026-11-19T00:00:00.000Z';
    const db = new FakeDb({
      settings: settingsRow(),
      links: [linkRow()],
      ledger: [ledgerRow({
        released_at: originalRelease,
        confirmed_at: originalConfirmation,
      })],
    });
    const { guild } = fakeGuild({ [USER_ID]: { nickname: 'Manual' } });

    const result = await syncMemberNickname(guild, USER_ID, { db: db.client });

    expect(result.kind).toBe('failed');
    expect(db.tables['guild_managed_nicknames']?.[0]).toMatchObject({
      released_at: originalRelease,
      confirmed_at: originalConfirmation,
    });
  });
});

describe('verification hook', () => {
  it('accepts a name/tag hint and still resolves the current guild main', async () => {
    const db = new FakeDb({ settings: settingsRow(), links: [linkRow()] });
    const { client } = fakeClient(fakeGuild({ [USER_ID]: { nickname: 'Old' } }).guild);

    const result = await syncNicknameAfterVerification(
      client,
      GUILD_ID,
      USER_ID,
      { playerName: 'Hint Only', playerTag: OTHER_TAG },
      { db: db.client },
    );

    expect(result).toEqual({ kind: 'ok', nickname: '[ABC] Alpha' });
  });
});

describe('refreshGuildNicknames', () => {
  it('reads settings once per guild and applies eligible mains', async () => {
    const db = new FakeDb({
      settings: settingsRow(),
      links: [linkRow()],
      memberships: [{ player_id: PLAYER_ID }],
    });
    const { guild, setNicknames } = fakeGuild({ [USER_ID]: { nickname: 'Old' } });

    const summary = await refreshGuildNicknames(guild, { db: db.client });

    expect(db.calls.filter((call) => call.table === 'guild_settings')).toHaveLength(1);
    expect(summary).toEqual({
      guilds: 1,
      members: 1,
      updated: 1,
      unchanged: 0,
      notMembers: 0,
      unresolved: 0,
      restored: 0,
      released: 0,
      failures: 0,
      cleanupIncomplete: false,
    });
    expect(setNicknames[USER_ID]).toHaveBeenCalledWith('[ABC] Alpha', REASON);
  });

  it('releases a stale ledger row and restores the previous nickname', async () => {
    const db = new FakeDb({
      settings: settingsRow(),
      links: [linkRow()],
      ledger: [ledgerRow({ discord_user_id: OTHER_USER_ID, applied_nickname: '[ABC] Ghost', previous_nickname: 'Ghost Original' })],
    });
    const { guild, setNicknames } = fakeGuild({
      [USER_ID]: { nickname: '[ABC] Alpha' },
      [OTHER_USER_ID]: { nickname: '[ABC] Ghost' },
    });

    const summary = await refreshGuildNicknames(guild, { db: db.client });

    expect(summary.unchanged).toBe(1);
    expect(summary.released).toBe(1);
    expect(summary.restored).toBe(1);
    expect(setNicknames[OTHER_USER_ID]).toHaveBeenCalledWith(
      'Ghost Original',
      RESTORE_REASON,
    );
    expect(db.tables['guild_managed_nicknames']?.[0]?.['released_at']).not.toBeNull();
  });

  it('releases the verified member’s ledger row when Discord confirms they left', async () => {
    const db = new FakeDb({
      settings: settingsRow(),
      links: [linkRow()],
      ledger: [ledgerRow({ applied_nickname: '[ABC] Alpha' })],
    });
    const { guild, setNicknames } = fakeGuild({});

    const summary = await refreshGuildNicknames(guild, { db: db.client });

    expect(summary.notMembers).toBe(1);
    expect(summary.released).toBe(1);
    expect(summary.failures).toBe(0);
    expect(setNicknames[USER_ID]).toBeUndefined();
    expect(db.tables['guild_managed_nicknames']?.[0]?.['released_at']).not.toBeNull();
  });

  it('clears a restored nickname when the original previous nickname was null', async () => {
    const db = new FakeDb({
      settings: settingsRow(),
      ledger: [ledgerRow({ discord_user_id: OTHER_USER_ID, applied_nickname: '[ABC] Ghost', previous_nickname: null })],
    });
    const { guild, setNicknames } = fakeGuild({ [OTHER_USER_ID]: { nickname: '[ABC] Ghost' } });

    const summary = await refreshGuildNicknames(guild, { db: db.client });

    expect(summary.restored).toBe(1);
    expect(setNicknames[OTHER_USER_ID]).toHaveBeenCalledWith(
      null,
      RESTORE_REASON,
    );
  });

  it('leaves a member’s manual nickname alone and only releases the ledger', async () => {
    const db = new FakeDb({
      settings: settingsRow(),
      ledger: [ledgerRow({ discord_user_id: OTHER_USER_ID, applied_nickname: '[ABC] Ghost' })],
    });
    const { guild, setNicknames } = fakeGuild({ [OTHER_USER_ID]: { nickname: 'Chosen By Member' } });

    const summary = await refreshGuildNicknames(guild, { db: db.client });

    expect(summary.released).toBe(1);
    expect(summary.restored).toBe(0);
    expect(setNicknames[OTHER_USER_ID]).not.toHaveBeenCalled();
    expect(db.tables['guild_managed_nicknames']?.[0]?.['released_at']).not.toBeNull();
  });

  it('releases the ledger without a Discord write for a confirmed missing member', async () => {
    const db = new FakeDb({
      settings: settingsRow(),
      ledger: [ledgerRow({ discord_user_id: OTHER_USER_ID, applied_nickname: '[ABC] Ghost' })],
    });
    const { guild, setNicknames } = fakeGuild({});

    const summary = await refreshGuildNicknames(guild, { db: db.client });

    expect(summary.notMembers).toBe(1);
    expect(summary.released).toBe(1);
    expect(summary.failures).toBe(0);
    expect(setNicknames[OTHER_USER_ID]).toBeUndefined();
    expect(db.tables['guild_managed_nicknames']?.[0]?.['released_at']).not.toBeNull();
  });

  it('keeps the ledger active and counts unresolved member lookups as failures', async () => {
    const db = new FakeDb({
      settings: settingsRow(),
      ledger: [ledgerRow({ discord_user_id: OTHER_USER_ID, applied_nickname: '[ABC] Ghost' })],
    });
    const { guild } = fakeGuild({
      [OTHER_USER_ID]: { nickname: '[ABC] Ghost', fetchError: { status: 500, message: 'Gateway' } },
    });

    const summary = await refreshGuildNicknames(guild, { db: db.client });

    expect(summary.unresolved).toBe(1);
    expect(summary.failures).toBe(1);
    expect(summary.released).toBe(0);
    expect(db.tables['guild_managed_nicknames']?.[0]?.['released_at']).toBeNull();
  });

  it('never mutates an owner or bot during cleanup', async () => {
    const db = new FakeDb({
      settings: settingsRow(),
      ledger: [
        ledgerRow({ discord_user_id: OWNER_ID, applied_nickname: '[ABC] Owner' }),
        ledgerRow({ discord_user_id: OTHER_USER_ID, applied_nickname: '[ABC] Bot' }),
      ],
    });
    const { guild, setNicknames } = fakeGuild(
      {
        [OWNER_ID]: { nickname: '[ABC] Owner' },
        [OTHER_USER_ID]: { nickname: '[ABC] Bot', bot: true },
      },
      OWNER_ID,
    );

    const summary = await refreshGuildNicknames(guild, { db: db.client });

    expect(summary.released).toBe(2);
    expect(summary.restored).toBe(0);
    expect(setNicknames[OWNER_ID]).not.toHaveBeenCalled();
    expect(setNicknames[OTHER_USER_ID]).not.toHaveBeenCalled();
    expect(db.tables['guild_managed_nicknames']?.every((row) => row['released_at'] !== null)).toBe(
      true,
    );
  });

  it('continues through one failing member and still runs cleanup', async () => {
    const db = new FakeDb({
      settings: settingsRow(),
      links: [
        linkRow({ verification_id: 'v-1', player_id: PLAYER_ID }),
        linkRow({
          verification_id: 'v-2',
          player_id: OTHER_PLAYER_ID,
          discord_user_id: THIRD_USER_ID,
          username: 'beta',
          tag: OTHER_TAG,
          name: 'Beta',
        }),
      ],
      memberships: [{ player_id: PLAYER_ID }, { player_id: OTHER_PLAYER_ID }],
      ledger: [ledgerRow({ discord_user_id: OTHER_USER_ID, applied_nickname: '[ABC] Ghost' })],
    });
    const { guild, setNicknames } = fakeGuild({
      [USER_ID]: {
        nickname: 'Old',
        setNicknameImpl: async () => {
          throw new Error('Hierarchy');
        },
      },
      [THIRD_USER_ID]: { nickname: 'Old Beta' },
      [OTHER_USER_ID]: { nickname: '[ABC] Ghost' },
    });

    const summary = await refreshGuildNicknames(guild, { db: db.client });

    expect(summary.members).toBe(2);
    expect(summary.failures).toBe(1);
    expect(summary.updated).toBe(1);
    expect(summary.released).toBe(1);
    expect(setNicknames[THIRD_USER_ID]).toHaveBeenCalledWith('[ABC] Beta', REASON);
    expect(setNicknames[OTHER_USER_ID]).toHaveBeenCalledOnce();
  });

  it('keeps a ledger row active when Discord rejects the restore', async () => {
    const db = new FakeDb({
      settings: settingsRow(),
      ledger: [ledgerRow({ discord_user_id: OTHER_USER_ID, applied_nickname: '[ABC] Ghost' })],
    });
    const { guild } = fakeGuild({
      [OTHER_USER_ID]: {
        nickname: '[ABC] Ghost',
        setNicknameImpl: async () => {
          throw new Error('Missing Permissions');
        },
      },
    });

    const summary = await refreshGuildNicknames(guild, { db: db.client });

    expect(summary.failures).toBe(1);
    expect(summary.released).toBe(0);
    expect(db.tables['guild_managed_nicknames']?.[0]?.['released_at']).toBeNull();
  });

  it('counts transient ledger read failures without aborting the guild refresh', async () => {
    const db = new FakeDb({
      settings: settingsRow(),
      ledger: [ledgerRow({ discord_user_id: OTHER_USER_ID, applied_nickname: '[ABC] Ghost' })],
    });
    db.failOnce('guild_managed_nickname_page', 'rpc');
    const { guild } = fakeGuild({ [OTHER_USER_ID]: { nickname: '[ABC] Ghost' } });

    const summary = await refreshGuildNicknames(guild, { db: db.client });

    expect(summary.failures).toBe(1);
    expect(summary.released).toBe(0);
    expect(db.tables['guild_managed_nicknames']?.[0]?.['released_at']).toBeNull();
  });

  it('skips destructive cleanup when verified links cannot be read', async () => {
    const originalRelease = '2026-11-19T00:00:00.000Z';
    const db = new FakeDb({
      settings: settingsRow(),
      ledger: [ledgerRow({
        discord_user_id: OTHER_USER_ID,
        applied_nickname: '[ABC] Ghost',
        released_at: originalRelease,
      })],
    });
    const { guild, setNicknames } = fakeGuild({ [OTHER_USER_ID]: { nickname: '[ABC] Ghost' } });
    db.failOnce('list_guild_verified_links', 'rpc');

    const summary = await refreshGuildNicknames(guild, { db: db.client });

    expect(summary).toMatchObject({ members: 0, failures: 1, released: 0 });
    expect(summary.cleanupIncomplete).toBe(true);
    expect(setNicknames[OTHER_USER_ID]).not.toHaveBeenCalled();
    expect(db.tables['guild_managed_nicknames']?.[0]?.['released_at']).toBe(originalRelease);
  });
});

describe('command-layer nickname hooks', () => {
  it('releases an active ledger row when a member has no remaining main', async () => {
    const db = new FakeDb({
      settings: settingsRow(),
      ledger: [ledgerRow({ applied_nickname: '[ABC] Alpha' })],
    });
    const { guild, setNicknames } = fakeGuild({ [USER_ID]: { nickname: '[ABC] Alpha' } });

    const result = await reconcileMemberNickname(guild, USER_ID, { db: db.client });

    expect(result.kind).toBe('released');
    expect(setNicknames[USER_ID]).toHaveBeenCalledWith('Original', RESTORE_REASON);
    expect(db.tables['guild_managed_nicknames']?.[0]?.['released_at']).not.toBeNull();
  });

  it('restores managed nicknames on disable', async () => {
    const db = new FakeDb({
      settings: settingsRow({ nickname_sync_enabled: false }),
      ledger: [ledgerRow({ applied_nickname: '[ABC] Alpha', previous_nickname: 'Before Sync' })],
    });
    const { guild, setNicknames } = fakeGuild({ [USER_ID]: { nickname: '[ABC] Alpha' } });

    const summary = await releaseManagedNicknamesAfterDisable(guild, { db: db.client });

    expect(summary.released).toBe(1);
    expect(summary.restored).toBe(1);
    expect(setNicknames[USER_ID]).toHaveBeenCalledWith(
      'Before Sync',
      RESTORE_REASON,
    );
  });
});
