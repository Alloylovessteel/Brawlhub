import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { AdminActor } from '../admin/types.js';
import {
  buildRankedRolePlans,
  loadGuildRankedRoleState,
  rankedTierFromRankName,
  resolveRankedRoleId,
  saveGuildRankedRoleMapping,
  selectStaleRoleIds,
} from './service.js';

const GUILD_ID = '1488531664962326571';
const ACTOR: AdminActor = {
  profileId: 'profile-1',
  discordUserId: '983248496884875286',
  globalRole: 'admin',
};

type Handler = (
  payload?: Record<string, unknown>,
  options?: Record<string, unknown>,
) => { data: unknown; error: unknown };

function fakeDb(handlers: Record<string, Handler>): SupabaseClient {
  class Query {
    private operation = 'select';
    private payload: Record<string, unknown> | undefined;
    private options: Record<string, unknown> | undefined;

    constructor(private readonly table: string) {}

    select(): this {
      this.operation = 'select';
      return this;
    }

    upsert(payload: Record<string, unknown>, options?: Record<string, unknown>): this {
      this.operation = 'upsert';
      this.payload = payload;
      this.options = options;
      return this;
    }

    insert(payload: Record<string, unknown>): this {
      this.operation = 'insert';
      this.payload = payload;
      return this;
    }

    eq(): this {
      return this;
    }

    in(): this {
      return this;
    }

    maybeSingle(): this {
      return this;
    }

    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      const key = `${this.table}:${this.operation}`;
      const response = (handlers[key] ?? (() => ({ data: null, error: null })))(
        this.payload,
        this.options,
      );
      return Promise.resolve(response).then(onfulfilled, onrejected);
    }
  }

  return {
    from(table: string) {
      return new Query(table);
    },
  } as unknown as SupabaseClient;
}

describe('ranked tier resolution', () => {
  it('uses only official stored rank names', () => {
    expect(rankedTierFromRankName('DIAMOND II')).toBe('DIAMOND');
    expect(rankedTierFromRankName('legendary i')).toBe('LEGENDARY');
    expect(rankedTierFromRankName('UNKNOWN RANK')).toBeNull();
    expect(rankedTierFromRankName(null)).toBeNull();
  });

  it('resolves configured roles without guessing', () => {
    expect(resolveRankedRoleId({ GOLD: '123456789012345678' }, 'GOLD I')).toBe('123456789012345678');
    expect(resolveRankedRoleId({ GOLD: '123456789012345678' }, 'PRO I')).toBeNull();
  });
});

describe('buildRankedRolePlans', () => {
  it('uses verified main accounts and removes other ranked roles', () => {
    const plans = buildRankedRolePlans(
      [
        { discordUserId: 'user-1', playerId: 'player-alt', isMain: false },
        { discordUserId: 'user-1', playerId: 'player-main', isMain: true },
        { discordUserId: 'user-2', playerId: 'player-no-main', isMain: false },
      ],
      new Map([
        ['player-alt', 'PRO I'],
        ['player-main', 'DIAMOND II'],
      ]),
      { BRONZE: '111111111111111111', DIAMOND: '222222222222222222', PRO: '333333333333333333' },
      '444444444444444444',
    );

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      discordUserId: 'user-1',
      tier: 'DIAMOND',
      addRoleIds: ['222222222222222222'],
      removeRoleIds: ['111111111111111111', '333333333333333333'],
      verifiedRoleId: '444444444444444444',
    });
  });
});

describe('selectStaleRoleIds', () => {
  it('finds only bot-managed roles the member still holds', () => {
    expect(
      selectStaleRoleIds(
        ['111111111111111111', '999999999999999999'],
        ['111111111111111111', '222222222222222222'],
      ),
    ).toEqual(['111111111111111111']);
  });
});

describe('guild settings persistence', () => {
  it('reads only this guild and ignores invalid role IDs', async () => {
    const db = fakeDb({
      'guild_settings:select': () => ({
        data: {
          guild_id: GUILD_ID,
          ranked_role_ids: {
            GOLD: '123456789012345678',
            PRO: 'not-a-role',
          },
          verification_channel_id: '999999999999999999',
          verification_message_id: '888888888888888888',
        },
        error: null,
      }),
    });

    const state = await loadGuildRankedRoleState(GUILD_ID, { db });
    expect(state.mapping).toEqual({ GOLD: '123456789012345678' });
    expect(state.verificationChannelId).toBe('999999999999999999');
    expect(state.verificationMessageId).toBe('888888888888888888');
  });

  it('rejects a non-guild identifier', async () => {
    await expect(loadGuildRankedRoleState('not-a-guild', { db: fakeDb({}) })).rejects.toMatchObject({
      code: 'invalid_guild',
    });
  });

  it('saves a guild-scoped mapping and audits the guild', async () => {
    const upsert = vi.fn(() => ({ data: null, error: null }));
    const audit = vi.fn(
      (_payload?: Record<string, unknown>, _options?: Record<string, unknown>) => ({
        data: null,
        error: null,
      }),
    );
    const db = fakeDb({
      'guild_settings:upsert': upsert,
      'audit_logs:insert': audit,
      'guild_settings:select': () => ({
        data: {
          guild_id: GUILD_ID,
          ranked_role_ids: { GOLD: '123456789012345678' },
          verification_channel_id: null,
          verification_message_id: null,
        },
        error: null,
      }),
    });

    const state = await saveGuildRankedRoleMapping(
      {
        guildId: GUILD_ID,
        mapping: { GOLD: '123456789012345678', PRO: 'bad' },
        actor: ACTOR,
      },
      { db },
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        guild_id: GUILD_ID,
        ranked_role_ids: { GOLD: '123456789012345678' },
      }),
      { onConflict: 'guild_id' },
    );
    expect(state.mapping).toEqual({ GOLD: '123456789012345678' });
    expect(audit.mock.calls[0]?.[0]).toMatchObject({
      guild_id: GUILD_ID,
      action: 'guild.ranked_roles.updated',
    });
  });
});
