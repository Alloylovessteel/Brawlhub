import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  deleteUserDataForDiscordUser,
  findVerifiedPlayerForDiscordUser,
  linkPlayerManually,
  listGuildVerifiedLinks,
  listLinkedAccounts,
  revokeVerification,
  setMainVerification,
} from './service';

type Response = { readonly data: unknown; readonly error: unknown };
interface TableResponse {
  readonly select?: Response;
  readonly selectQueue?: readonly Response[];
  readonly update?: Response;
}

interface FakeDb {
  readonly client: SupabaseClient;
  readonly updates: Array<{ readonly table: string; readonly payload: Record<string, unknown> }>;
  readonly authDeletes: string[];
  setAuthDeleteResult(result: unknown): void;
  setAuthDeleteError(error: unknown): void;
}

function fakeDb(tables: Record<string, TableResponse>): FakeDb {
  const updates: FakeDb['updates'] = [];
  const authDeletes: string[] = [];
  let authDeleteResult: unknown = { data: { user: {} }, error: null };
  let authDeleteError: unknown = undefined;
  const selectCursors: Record<string, number> = {};

  function nextSelect(table: string): Response {
    const config = tables[table];
    if (config?.selectQueue !== undefined) {
      const index = selectCursors[table] ?? 0;
      selectCursors[table] = index + 1;
      return config.selectQueue[index] ?? { data: null, error: null };
    }
    return config?.select ?? { data: null, error: null };
  }

  class Query {
    private mode: 'select' | 'update' | 'delete' = 'select';

    constructor(private readonly table: string) {}

    select(): this {
      this.mode = 'select';
      return this;
    }

    update(payload: Record<string, unknown>): this {
      this.mode = 'update';
      updates.push({ table: this.table, payload });
      return this;
    }

    delete(): this {
      this.mode = 'delete';
      updates.push({ table: this.table, payload: { delete: true } });
      return this;
    }

    eq(): this {
      return this;
    }

    in(): this {
      return this;
    }

    is(): this {
      return this;
    }

    order(): this {
      return this;
    }

    limit(): this {
      return this;
    }

    maybeSingle(): this {
      return this;
    }

    single(): this {
      return this;
    }

    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: Response) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      const response =
        this.mode === 'update'
          ? (tables[this.table]?.update ?? { data: null, error: null })
          : this.mode === 'delete'
            ? { data: null, error: null }
            : nextSelect(this.table);
      return Promise.resolve(response).then(onfulfilled, onrejected);
    }
  }

  return {
    client: {
      from(table: string) {
        return new Query(table);
      },
      auth: {
        admin: {
          async deleteUser(id: string) {
            authDeletes.push(id);
            if (authDeleteError !== undefined) throw authDeleteError;
            return authDeleteResult;
          },
        },
      },
    } as unknown as SupabaseClient,
    updates,
    authDeletes,
    setAuthDeleteResult(result: unknown) {
      authDeleteResult = result;
    },
    setAuthDeleteError(error: unknown) {
      authDeleteError = error;
    },
  };
}

function link(id: string, tag: string, name: string, isMain: boolean, verifiedAt: string) {
  return {
    id,
    player_id: `player-${id}`,
    is_main: isMain,
    method: 'api_snapshot',
    verified_at: verifiedAt,
    player: { tag, name },
  };
}

const profile = { profiles: { select: { data: { id: 'profile-1' }, error: null } } };
const activeResponses: Record<string, TableResponse> = {
  ...profile,
  player_verifications: {
    select: {
      data: [link('v1', '#yqpq0q2cl', 'Alloylovessteel', true, '2026-11-19T04:37:42.257Z')],
      error: null,
    },
  },
};

describe('findVerifiedPlayerForDiscordUser', () => {
  it('returns the normalized tag of the active verified player', async () => {
    const db = fakeDb(activeResponses);
    const result = await findVerifiedPlayerForDiscordUser('983248496884875286', {
      db: db.client,
    });

    expect(result).toEqual({ tag: 'YQPQ0Q2CL', name: 'Alloylovessteel' });
  });

  it('prefers the main account when several are linked', async () => {
    const db = fakeDb({
      ...profile,
      player_verifications: {
        select: {
          data: [
            link('v2', '#2UG9UGQJY', 'Alt Player', false, '2026-11-20T00:00:00.000Z'),
            link('v1', '#YQPQ0Q2CL', 'Main Player', true, '2026-11-01T00:00:00.000Z'),
          ],
          error: null,
        },
      },
    });

    const result = await findVerifiedPlayerForDiscordUser('983248496884875286', {
      db: db.client,
    });

    expect(result).toEqual({ tag: 'YQPQ0Q2CL', name: 'Main Player' });
  });

  it('returns null when there is no active verification', async () => {
    const db = fakeDb({
      ...profile,
      player_verifications: { select: { data: [], error: null } },
    });

    const result = await findVerifiedPlayerForDiscordUser('983248496884875286', {
      db: db.client,
    });

    expect(result).toBeNull();
  });

  it('returns null for an invalid Discord ID without querying', async () => {
    const db = fakeDb(activeResponses);
    const result = await findVerifiedPlayerForDiscordUser('not-a-snowflake', {
      db: db.client,
    });

    expect(result).toBeNull();
  });
});

describe('listLinkedAccounts', () => {
  it('lists main first and labels alts', async () => {
    const db = fakeDb({
      ...profile,
      player_verifications: {
        select: {
          data: [
            link('v2', '#2UG9UGQJY', 'Alt Player', false, '2026-11-20T00:00:00.000Z'),
            link('v1', '#YQPQ0Q2CL', 'Main Player', true, '2026-11-01T00:00:00.000Z'),
          ],
          error: null,
        },
      },
    });

    const result = await listLinkedAccounts('983248496884875286', { db: db.client });

    expect(result?.map((account) => ({ tag: account.tag, isMain: account.isMain }))).toEqual([
      { tag: 'YQPQ0Q2CL', isMain: true },
      { tag: '2UG9UGQJY', isMain: false },
    ]);
  });
});

describe('setMainVerification', () => {
  it('demotes the old main and promotes the chosen alt', async () => {
    const db = fakeDb({
      ...profile,
      player_verifications: {
        select: {
          data: [
            link('v1', '#YQPQ0Q2CL', 'Main Player', true, '2026-11-01T00:00:00.000Z'),
            link('v2', '#2UG9UGQJY', 'Alt Player', false, '2026-11-20T00:00:00.000Z'),
          ],
          error: null,
        },
        update: { data: null, error: null },
      },
    });

    const result = await setMainVerification('983248496884875286', '#2UG9UGQJY', {
      db: db.client,
    });

    expect(result).toEqual({ kind: 'ok', tag: '2UG9UGQJY' });
    expect(db.updates).toEqual([
      { table: 'player_verifications', payload: { is_main: false } },
      { table: 'player_verifications', payload: { is_main: true } },
    ]);
  });

  it('rejects a tag that is not linked to the caller', async () => {
    const db = fakeDb(activeResponses);

    const result = await setMainVerification('983248496884875286', '#2UU08YPPJ', {
      db: db.client,
    });

    expect(result).toEqual({ kind: 'not-found' });
    expect(db.updates).toEqual([]);
  });
});

function staffLink(
  id: string,
  tag: string,
  discordUserId: string,
  isMain: boolean,
): Record<string, unknown> {
  return {
    id,
    player_id: `player-${id}`,
    is_main: isMain,
    method: 'manual_staff',
    verified_at: '2026-11-19T00:00:00.000Z',
    player: { tag, name: `Player ${id}` },
    profile: { discord_user_id: discordUserId, username: `user-${id}` },
  };
}

describe('listGuildVerifiedLinks', () => {
  it('only returns links for players in clubs registered to the guild', async () => {
    const db = fakeDb({
      clubs: { select: { data: [{ id: 'club-1' }], error: null } },
      club_memberships: { select: { data: [{ player_id: 'player-v1' }], error: null } },
      player_verifications: {
        select: {
          data: [staffLink('v1', 'YQPQ0Q2CL', '983248496884875286', true)],
          error: null,
        },
      },
    });

    const result = await listGuildVerifiedLinks('guild-1', { db: db.client });

    expect(result).toEqual([
      expect.objectContaining({
        tag: 'YQPQ0Q2CL',
        discordUserId: '983248496884875286',
        isMain: true,
        method: 'manual_staff',
      }),
    ]);
  });

  it('returns an empty list when the guild has no registered clubs', async () => {
    const db = fakeDb({ clubs: { select: { data: [], error: null } } });

    const result = await listGuildVerifiedLinks('guild-1', { db: db.client });

    expect(result).toEqual([]);
  });
});

describe('deleteUserDataForDiscordUser', () => {
  it('deletes the Discord identity and profile rows', async () => {
    const db = fakeDb(profile);

    const result = await deleteUserDataForDiscordUser('983248496884875286', {
      db: db.client,
    });

    expect(result).toEqual({ kind: 'ok' });
    expect(db.authDeletes).toHaveLength(1);
    expect(db.updates).toEqual([
      { table: 'discord_users', payload: { delete: true } },
      { table: 'profiles', payload: { delete: true } },
    ]);
  });

  it('keeps identity rows and reports failure when Auth deletion returns an error', async () => {
    const db = fakeDb(profile);
    db.setAuthDeleteResult({ data: null, error: { message: 'auth unavailable' } });

    const result = await deleteUserDataForDiscordUser('983248496884875286', {
      db: db.client,
    });

    expect(result).toEqual({ kind: 'auth-delete-failed' });
    expect(db.updates).toEqual([]);
  });

  it('reports failure when Auth deletion throws and allows a later retry', async () => {
    const db = fakeDb(profile);
    db.setAuthDeleteError(new Error('auth unavailable'));

    await expect(
      deleteUserDataForDiscordUser('983248496884875286', { db: db.client }),
    ).resolves.toEqual({ kind: 'auth-delete-failed' });
    expect(db.updates).toEqual([]);

    db.setAuthDeleteError(undefined);
    await expect(
      deleteUserDataForDiscordUser('983248496884875286', { db: db.client }),
    ).resolves.toEqual({ kind: 'ok' });
    expect(db.updates).toHaveLength(2);
  });

  it('reports when there is no stored identity', async () => {
    const db = fakeDb({
      profiles: { select: { data: null, error: null } },
      discord_users: { select: { data: null, error: null } },
    });

    const result = await deleteUserDataForDiscordUser('983248496884875286', {
      db: db.client,
    });

    expect(result).toEqual({ kind: 'not-found' });
  });
});

describe('revokeVerification', () => {
  it('promotes another active account when the main link is revoked', async () => {
    const db = fakeDb({
      player_verifications: {
        selectQueue: [
          { data: { id: 'v1', profile_id: 'profile-1', is_main: true }, error: null },
          {
            data: [link('v2', '#2UG9UGQJY', 'Alt Player', false, '2026-11-20T00:00:00.000Z')],
            error: null,
          },
        ],
        update: { data: null, error: null },
      },
    });

    const result = await revokeVerification('v1', 'actor-profile', { db: db.client });

    expect(result).toEqual({ kind: 'ok', promoted: true });
    expect(db.updates[0]?.payload).toMatchObject({
      status: 'revoked',
      revoked_by_profile_id: 'actor-profile',
    });
    expect(db.updates[1]?.payload).toEqual({ is_main: true });
  });
});
