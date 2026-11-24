import type { SupabaseClient } from '@supabase/supabase-js';
import type { Guild } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminActor } from '../admin/types.js';
import {
  applyClubRolePlans,
  buildClubRolePlans,
  chooseHighestClubRole,
  clubRoleRankFromRole,
  loadGuildClubRoleState,
  readGuildMembershipRoles,
  refreshGuildClubRoles,
  saveGuildClubRoleMapping,
  type ClubRoleLink,
} from './service.js';

const GUILD_ID = '1488531664962326571';
const ACTOR: AdminActor = {
  profileId: 'profile-1',
  discordUserId: '983248496884875286',
  globalRole: 'admin',
};

const mocks = vi.hoisted(() => ({
  listGuildVerifiedLinks: vi.fn(async (_guildId: string) => []),
}));

vi.mock('../verification/service.js', () => ({
  listGuildVerifiedLinks: mocks.listGuildVerifiedLinks,
}));

import { listGuildVerifiedLinks } from '../verification/service.js';

type Filter = readonly [operator: string, column: string, value: unknown];

interface QueryCall {
  readonly table: string;
  readonly operation: string;
  readonly payload: Record<string, unknown> | undefined;
  readonly options: Record<string, unknown> | undefined;
  readonly filters: Filter[];
}

type Handler = (
  payload?: Record<string, unknown>,
  options?: Record<string, unknown>,
  filters?: readonly Filter[],
) => { data: unknown; error: unknown };

function fakeDb(handlers: Record<string, Handler>): { db: SupabaseClient; calls: QueryCall[] } {
  const calls: QueryCall[] = [];

  class Query {
    private operation = 'select';
    private payload: Record<string, unknown> | undefined;
    private options: Record<string, unknown> | undefined;
    private readonly filters: Filter[] = [];

    constructor(private readonly table: string) {}

    private recordCall(): QueryCall {
      const call: QueryCall = {
        table: this.table,
        operation: this.operation,
        payload: this.payload,
        options: this.options,
        filters: [...this.filters],
      };
      calls.push(call);
      return call;
    }

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

    eq(column: string, value: unknown): this {
      this.filters.push(['eq', column, value]);
      return this;
    }

    is(column: string, value: unknown): this {
      this.filters.push(['is', column, value]);
      return this;
    }

    in(column: string, value: unknown): this {
      this.filters.push(['in', column, value]);
      return this;
    }

    maybeSingle(): this {
      return this;
    }

    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      const call = this.recordCall();
      const handler =
        handlers[`${this.table}:${this.operation}`] ?? (() => ({ data: null, error: null }));
      return Promise.resolve(handler(call.payload, call.options, call.filters)).then(
        onfulfilled,
        onrejected,
      );
    }
  }

  return {
    db: {
      from(table: string) {
        return new Query(table);
      },
    } as unknown as SupabaseClient,
    calls,
  };
}

beforeEach(() => {
  mocks.listGuildVerifiedLinks.mockReset();
  mocks.listGuildVerifiedLinks.mockResolvedValue([]);
});

describe('club rank parsing', () => {
  it('maps only President, Vice President and Senior official roster roles', () => {
    expect(clubRoleRankFromRole('president')).toBe('president');
    expect(clubRoleRankFromRole('vicePresident')).toBe('vicePresident');
    expect(clubRoleRankFromRole('senior')).toBe('senior');
    expect(clubRoleRankFromRole('member')).toBeNull();
    expect(clubRoleRankFromRole('President')).toBeNull();
  });

  it('uses highest-rank precedence across accounts and clubs', () => {
    expect(chooseHighestClubRole(['senior', 'vicePresident', 'member'])).toBe('vicePresident');
    expect(chooseHighestClubRole(['senior', 'president'])).toBe('president');
    expect(chooseHighestClubRole(['member', null])).toBeNull();
  });
});

describe('buildClubRolePlans', () => {
  it('ignores alts and gives each verified main one role with highest precedence', () => {
    const links: ClubRoleLink[] = [
      { discordUserId: 'user-1', playerId: 'player-alt', isMain: false },
      { discordUserId: 'user-1', playerId: 'player-senior', isMain: true },
      { discordUserId: 'user-1', playerId: 'player-president', isMain: true },
      { discordUserId: 'user-2', playerId: 'player-member', isMain: true },
    ];
    const membershipRoles = new Map([
      ['player-alt', 'president' as const],
      ['player-senior', 'senior' as const],
      ['player-president', 'president' as const],
    ]);
    const mapping = {
      president: '111111111111111111',
      vicePresident: '222222222222222222',
      senior: '333333333333333333',
    };

    const plans = buildClubRolePlans(links, membershipRoles, mapping);

    expect(plans).toHaveLength(2);
    expect(plans.find((plan) => plan.discordUserId === 'user-1')).toMatchObject({
      rank: 'president',
      addRoleIds: ['111111111111111111'],
      removeRoleIds: ['222222222222222222', '333333333333333333'],
    });
    expect(plans.find((plan) => plan.discordUserId === 'user-2')).toMatchObject({
      rank: null,
      addRoleIds: [],
      removeRoleIds: ['111111111111111111', '222222222222222222', '333333333333333333'],
    });
  });
});

describe('guild-scoped membership reads', () => {
  it('reads only this guild’s active club memberships and chooses the highest rank', async () => {
    const { db, calls } = fakeDb({
      'clubs:select': () => ({
        data: [{ id: 'club-a' }, { id: 'club-b' }, { id: 'other-guild-club' }],
        error: null,
      }),
      'club_memberships:select': () => ({
        data: [
          { player_id: 'player-1', role: 'senior' },
          { player_id: 'player-1', role: 'president' },
          { player_id: 'player-2', role: 'member' },
          { player_id: 'player-2', role: 'vicePresident' },
        ],
        error: null,
      }),
    });

    const roles = await readGuildMembershipRoles(GUILD_ID, ['player-1', 'player-2'], { db });

    expect(roles.get('player-1')).toBe('president');
    expect(roles.get('player-2')).toBe('vicePresident');
    expect(calls.find((call) => call.table === 'clubs')?.filters).toEqual([
      ['eq', 'guild_id', GUILD_ID],
      ['is', 'archived_at', null],
    ]);
    expect(calls.find((call) => call.table === 'club_memberships')?.filters).toEqual([
      ['in', 'club_id', ['club-a', 'club-b', 'other-guild-club']],
      ['in', 'player_id', ['player-1', 'player-2']],
      ['is', 'valid_to', null],
    ]);
  });
});

describe('guild settings persistence', () => {
  it('reads only this guild and ignores invalid role IDs', async () => {
    const { db, calls } = fakeDb({
      'guild_settings:select': () => ({
        data: {
          guild_id: GUILD_ID,
          club_role_ids: {
            president: '123456789012345678',
            senior: 'bad-id',
          },
        },
        error: null,
      }),
    });

    const state = await loadGuildClubRoleState(GUILD_ID, { db });

    expect(state).toEqual({
      guildId: GUILD_ID,
      mapping: { president: '123456789012345678' },
    });
    expect(calls[0]?.filters).toEqual([['eq', 'guild_id', GUILD_ID]]);
  });

  it('saves a guild-scoped mapping and audits the guild', async () => {
    const { db, calls } = fakeDb({
      'guild_settings:select': () => ({
        data: { guild_id: GUILD_ID, club_role_ids: { president: '123456789012345678' } },
        error: null,
      }),
    });

    const state = await saveGuildClubRoleMapping(
      {
        guildId: GUILD_ID,
        mapping: { president: '123456789012345678', senior: 'bad-id' },
        actor: ACTOR,
      },
      { db },
    );

    expect(state.mapping).toEqual({ president: '123456789012345678' });
    expect(calls).toContainEqual(
      expect.objectContaining({
        table: 'guild_settings',
        operation: 'upsert',
        payload: {
          guild_id: GUILD_ID,
          club_role_ids: { president: '123456789012345678' },
        },
        options: { onConflict: 'guild_id' },
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        table: 'audit_logs',
        operation: 'insert',
        payload: expect.objectContaining({
          guild_id: GUILD_ID,
          action: 'guild.club_roles.updated',
        }),
      }),
    );
  });
});

describe('applyClubRolePlans', () => {
  it('adds the target role and removes other managed roles', async () => {
    const held = new Map([['333333333333333333', {} as never]]);
    const add = vi.fn(async (roleId: string) => {
      held.set(roleId, {} as never);
    });
    const remove = vi.fn(async (roleId: string) => {
      held.delete(roleId);
    });
    const member = {
      id: 'user-1',
      roles: {
        cache: {
          has: (roleId: string) => held.has(roleId),
          keys: () => held.keys(),
        },
        add,
        remove,
      },
    };
    const guild = {
      members: {
        fetch: vi.fn(async (discordUserId: string) => {
          if (discordUserId !== 'user-1') throw new Error('Unknown Member');
          return member;
        }),
      },
    } as unknown as Guild;

    const result = await applyClubRolePlans(guild, [
      {
        discordUserId: 'user-1',
        rank: 'president',
        addRoleIds: ['111111111111111111'],
        removeRoleIds: ['333333333333333333'],
      },
    ]);

    expect(result).toEqual({ processed: 1, membersNotFound: 0 });
    expect(remove).toHaveBeenCalledWith('333333333333333333', 'BrawlHub club role refresh');
    expect(add).toHaveBeenCalledWith('111111111111111111', 'BrawlHub club role refresh');
    expect([...held.keys()]).toEqual(['111111111111111111']);
  });

  it('continues with other members when one role mutation is rejected', async () => {
    const heldByUser = new Map([
      ['user-1', new Set<string>()],
      ['user-2', new Set<string>()],
    ]);
    const guild = {
      id: GUILD_ID,
      members: {
        fetch: vi.fn(async (id: string) => {
          const held = heldByUser.get(id);
          if (held === undefined) throw new Error('Unknown Member');
          return {
            id,
            roles: {
              cache: {
                has: (roleId: string) => held.has(roleId),
                keys: () => held.keys(),
              },
              add: vi.fn(async (roleId: string) => {
                if (id === 'user-1') throw new Error('Missing Permissions');
                held.add(roleId);
              }),
              remove: vi.fn(async (roleId: string) => {
                held.delete(roleId);
              }),
            },
          };
        }),
      },
    } as unknown as Guild;

    const result = await applyClubRolePlans(guild, [
      {
        discordUserId: 'user-1',
        rank: 'president',
        addRoleIds: ['111111111111111111'],
        removeRoleIds: [],
      },
      {
        discordUserId: 'user-2',
        rank: 'president',
        addRoleIds: ['111111111111111111'],
        removeRoleIds: [],
      },
    ]);

    expect(result).toEqual({ processed: 2, membersNotFound: 0 });
    expect(heldByUser.get('user-2')?.has('111111111111111111')).toBe(true);
  });
});

describe('refreshGuildClubRoles', () => {
  it('does nothing when the guild has no club role mapping', async () => {
    const { db } = fakeDb({
      'guild_settings:select': () => ({
        data: { guild_id: GUILD_ID, club_role_ids: {} },
        error: null,
      }),
    });
    const guild = { id: GUILD_ID } as Guild;

    await expect(refreshGuildClubRoles(guild, { db })).resolves.toEqual({
      configured: false,
      planned: 0,
      processed: 0,
      membersNotFound: 0,
      cleanedMembers: 0,
    });
    expect(listGuildVerifiedLinks).not.toHaveBeenCalled();
  });
});
