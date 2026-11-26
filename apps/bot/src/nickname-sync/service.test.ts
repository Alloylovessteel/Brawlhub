import type { SupabaseClient } from '@supabase/supabase-js';
import type { Guild, GuildMember } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  formatNickname,
  loadGuildNicknameSettings,
  normalizePrefix,
  syncMemberNickname,
} from './service.js';

const GUILD_ID = '1488531664962326571';
const USER_ID = '983248496884875286';

interface FakeQuery {
  readonly calls: Array<{
    readonly table: string;
    readonly operation: string;
    readonly filters: Array<[string, string, unknown]>;
  }>;
}

function fakeDb(row: Record<string, unknown> | null): { db: SupabaseClient; calls: FakeQuery['calls'] } {
  const calls: FakeQuery['calls'] = [];
  class Query {
    private operation = 'select';
    private readonly filters: Array<[string, string, unknown]> = [];

    constructor(private readonly table: string) {}

    select(): this {
      this.operation = 'select';
      return this;
    }

    eq(column: string, value: unknown): this {
      this.filters.push(['eq', column, value]);
      return this;
    }

    maybeSingle(): this {
      return this;
    }

    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2) | null,
    ): Promise<TResult1 | TResult2> {
      calls.push({ table: this.table, operation: this.operation, filters: [...this.filters] });
      return Promise.resolve({ data: row, error: null }).then(onfulfilled, onrejected);
    }
  }

  return {
    db: { from: (table: string) => new Query(table) } as unknown as SupabaseClient,
    calls,
  };
}

function fakeGuild(nickname: string | null, setNickname: ReturnType<typeof vi.fn>): Guild {
  const member = {
    id: USER_ID,
    nickname,
    user: { bot: false },
    setNickname,
  } as unknown as GuildMember;
  return {
    id: GUILD_ID,
    ownerId: '1488531664962326572',
    members: { fetch: vi.fn(async () => member) },
  } as unknown as Guild;
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
  it('reads the guild-scoped prefix and defaults sync to enabled', async () => {
    const { db, calls } = fakeDb({
      guild_id: GUILD_ID,
      nickname_prefix: '[ABC]',
      nickname_sync_enabled: null,
    });

    const settings = await loadGuildNicknameSettings(GUILD_ID, { db });

    expect(settings).toEqual({ guildId: GUILD_ID, enabled: true, prefix: '[ABC]' });
    expect(calls).toEqual([
      {
        table: 'guild_settings',
        operation: 'select',
        filters: [['eq', 'guild_id', GUILD_ID]],
      },
    ]);
  });
});

describe('syncMemberNickname', () => {
  it('does not touch Discord when sync is disabled', async () => {
    const { db } = fakeDb({
      guild_id: GUILD_ID,
      nickname_prefix: '[ABC]',
      nickname_sync_enabled: false,
    });
    const setNickname = vi.fn(async () => undefined);
    const guild = fakeGuild(null, setNickname);

    const result = await syncMemberNickname(guild, USER_ID, {
      db,
      playerNameHint: 'Alpha',
    });

    expect(result.kind).toBe('disabled');
    expect(setNickname).not.toHaveBeenCalled();
  });

  it('sets the prefixed nickname from a verified player hint', async () => {
    const { db } = fakeDb({
      guild_id: GUILD_ID,
      nickname_prefix: '[ABC]',
      nickname_sync_enabled: true,
    });
    const setNickname = vi.fn(async () => undefined);
    const guild = fakeGuild('Old Name', setNickname);

    const result = await syncMemberNickname(guild, USER_ID, {
      db,
      playerNameHint: 'Alpha',
    });

    expect(result).toEqual({ kind: 'ok', nickname: '[ABC] Alpha' });
    expect(setNickname).toHaveBeenCalledWith(
      '[ABC] Alpha',
      'BrawlHub verified player nickname',
    );
  });

  it('leaves an already-correct nickname unchanged', async () => {
    const { db } = fakeDb({
      guild_id: GUILD_ID,
      nickname_prefix: '[ABC]',
      nickname_sync_enabled: true,
    });
    const setNickname = vi.fn(async () => undefined);
    const guild = fakeGuild('[ABC] Alpha', setNickname);

    const result = await syncMemberNickname(guild, USER_ID, {
      db,
      playerNameHint: 'Alpha',
    });

    expect(result.kind).toBe('unchanged');
    expect(setNickname).not.toHaveBeenCalled();
  });
});
