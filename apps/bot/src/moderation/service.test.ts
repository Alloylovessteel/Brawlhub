import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ModerationServiceError,
  addBlacklist,
  canManageBlacklists,
  listActiveBlacklists,
  removeBlacklist,
  resolveBlacklistTarget,
  resolveModerationActor,
} from './service';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type RpcResponse = { readonly data: unknown; readonly error: { message: string } | null };

interface QueryLog {
  readonly table: string;
  readonly select: string;
  readonly filters: Row;
  readonly order: { field: string; ascending: boolean } | null;
  readonly limit: number | null;
}

const OWNER_DISCORD = '111111111111111111';
const ADMIN_DISCORD = '222222222222222222';
const STAFF_DISCORD = '333333333333333333';
const CLUB_STAFF_DISCORD = '444444444444444444';
const MEMBER_DISCORD = '555555555555555555';
const UNLINKED_DISCORD = '999999999999999999';

const OWNER_PROFILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN_PROFILE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STAFF_PROFILE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CLUB_STAFF_PROFILE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MEMBER_PROFILE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const CLUB_ID = '66666666-6666-4666-8666-666666666666';
const PLAYER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PLAYER_ID = '22222222-2222-4222-8222-222222222222';
const BLACKLIST_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_BLACKLIST_ID = '44444444-4444-4444-8444-444444444444';
const REMOVED_BLACKLIST_ID = '55555555-5555-4555-8555-555555555555';
const CREATED_AT = '2026-11-18T10:00:00.000Z';
const REMOVED_AT = '2026-11-18T11:00:00.000Z';

function createFakeDb(tables: Tables, rpcHandler: (name: string, args: Row) => RpcResponse) {
  const rpcCalls: { name: string; args: Row }[] = [];
  const queries: QueryLog[] = [];

  function from(table: string) {
    const state = {
      select: '',
      filters: {} as Row,
      maybeSingle: false,
      limit: null as number | null,
      order: null as { field: string; ascending: boolean } | null,
    };

    async function execute(): Promise<{ data: unknown; error: { message: string } | null }> {
      queries.push({
        table,
        select: state.select,
        filters: { ...state.filters },
        order: state.order === null ? null : { ...state.order },
        limit: state.limit,
      });
      let rows = [...(tables[table] ?? [])];
      for (const [field, value] of Object.entries(state.filters)) {
        rows = rows.filter((row) => row[field] === value);
      }
      if (state.order !== null) {
        const { field, ascending } = state.order;
        rows = [...rows].sort((left, right) => {
          const a = String(left[field] ?? '');
          const b = String(right[field] ?? '');
          return ascending ? a.localeCompare(b) : b.localeCompare(a);
        });
      }
      if (state.limit !== null) rows = rows.slice(0, state.limit);
      return {
        data: state.maybeSingle ? (rows[0] ?? null) : rows,
        error: null,
      };
    }

    const builder = {
      select: (columns: string) => {
        state.select = columns;
        return builder;
      },
      eq: (field: string, value: unknown) => {
        state.filters[field] = value;
        return builder;
      },
      order: (field: string, options: { ascending?: boolean } = {}) => {
        state.order = { field, ascending: options.ascending ?? true };
        return builder;
      },
      limit: (value: number) => {
        state.limit = value;
        return builder;
      },
      maybeSingle: () => {
        state.maybeSingle = true;
        return execute();
      },
      then: (
        resolve: (value: { data: unknown; error: { message: string } | null }) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => execute().then(resolve, reject),
    };
    return builder;
  }

  return {
    from,
    rpcCalls,
    queries,
    rpc: async (name: string, args: Row): Promise<RpcResponse> => {
      rpcCalls.push({ name, args });
      return rpcHandler(name, args);
    },
  };
}

function playerRow(overrides: Row = {}): Row {
  return {
    id: PLAYER_ID,
    tag: '2C0Y',
    name: 'Alpha',
    trophies: 5_000,
    highest_trophies: 5_200,
    exp_level: 40,
    last_synced_at: '2026-11-17T00:00:00.000Z',
    ...overrides,
  };
}

function blacklistRow(overrides: Row = {}): Row {
  return {
    id: BLACKLIST_ID,
    player_id: PLAYER_ID,
    reason: 'Spamming chat',
    created_by: OWNER_PROFILE,
    expires_at: null,
    created_at: CREATED_AT,
    status: 'active',
    ...overrides,
  };
}

function baseTables(): Tables {
  return {
    profiles: [
      { id: OWNER_PROFILE, discord_user_id: OWNER_DISCORD },
      { id: ADMIN_PROFILE, discord_user_id: ADMIN_DISCORD },
      { id: STAFF_PROFILE, discord_user_id: STAFF_DISCORD },
      { id: CLUB_STAFF_PROFILE, discord_user_id: CLUB_STAFF_DISCORD },
      { id: MEMBER_PROFILE, discord_user_id: MEMBER_DISCORD },
    ],
    user_roles: [
      { user_id: OWNER_PROFILE, scope: 'global', club_id: null, role: 'owner' },
      { user_id: ADMIN_PROFILE, scope: 'global', club_id: null, role: 'admin' },
      { user_id: STAFF_PROFILE, scope: 'global', club_id: null, role: 'staff' },
      { user_id: CLUB_STAFF_PROFILE, scope: 'club', club_id: CLUB_ID, role: 'owner' },
      { user_id: MEMBER_PROFILE, scope: 'global', club_id: null, role: 'member' },
    ],
    players: [playerRow()],
    discord_users: [
      { discord_user_id: OWNER_DISCORD, username: 'owner' },
      { discord_user_id: ADMIN_DISCORD, username: 'admin' },
      { discord_user_id: MEMBER_DISCORD, username: 'blacklisted-player' },
    ],
    player_verifications: [
      { player_id: PLAYER_ID, profile_id: MEMBER_PROFILE, status: 'active' },
      { player_id: OTHER_PLAYER_ID, profile_id: OWNER_PROFILE, status: 'removed' },
    ],
    blacklists: [
      blacklistRow(),
      blacklistRow({
        id: OTHER_BLACKLIST_ID,
        player_id: OTHER_PLAYER_ID,
        reason: 'Cheating in matches',
        created_by: ADMIN_PROFILE,
        expires_at: '2026-12-01T00:00:00.000Z',
        created_at: '2026-11-17T10:00:00.000Z',
      }),
      blacklistRow({
        id: REMOVED_BLACKLIST_ID,
        status: 'removed',
        created_at: '2026-11-19T10:00:00.000Z',
      }),
    ],
  };
}

function rpcOk(data: Row): RpcResponse {
  return { data: { ok: true, ...data }, error: null };
}

function rpcCode(code: string): RpcResponse {
  return { data: { ok: false, code }, error: null };
}

/** In-memory stand-in for moderation_blacklist_list, including pre-limit filtering. */
function listRpcFromTables(tables: Tables, args: Row): RpcResponse {
  const search = (typeof args['p_search'] === 'string' ? args['p_search'] : '').trim().toLowerCase();
  const profileDiscordIds = new Map<string, string>();
  for (const row of tables['profiles'] ?? []) {
    const id = typeof row['id'] === 'string' ? row['id'] : null;
    const discordId = typeof row['discord_user_id'] === 'string' ? row['discord_user_id'] : null;
    if (id !== null && discordId !== null) profileDiscordIds.set(id, discordId);
  }
  const usernames = new Map<string, string>();
  for (const row of tables['discord_users'] ?? []) {
    const discordId = typeof row['discord_user_id'] === 'string' ? row['discord_user_id'] : null;
    const username = typeof row['username'] === 'string' ? row['username'] : null;
    if (discordId !== null && username !== null) usernames.set(discordId, username);
  }
  const targetIdsByPlayer = new Map<string, string[]>();
  for (const row of tables['player_verifications'] ?? []) {
    if (row['status'] !== 'active') continue;
    const playerId = typeof row['player_id'] === 'string' ? row['player_id'] : null;
    const profileId = typeof row['profile_id'] === 'string' ? row['profile_id'] : null;
    if (playerId === null || profileId === null) continue;
    const discordId = profileDiscordIds.get(profileId);
    if (discordId === undefined) continue;
    targetIdsByPlayer.set(playerId, [...(targetIdsByPlayer.get(playerId) ?? []), discordId]);
  }

  const entries = (tables['blacklists'] ?? [])
    .filter((row) => row['status'] === 'active')
    .map((row) => {
      const playerId = typeof row['player_id'] === 'string' ? row['player_id'] : null;
      const player = (tables['players'] ?? []).find((candidate) => candidate['id'] === playerId);
      const createdByProfileId =
        typeof row['created_by'] === 'string' ? row['created_by'] : null;
      const createdByDiscordId =
        createdByProfileId === null ? null : profileDiscordIds.get(createdByProfileId) ?? null;
      const targetIds = playerId === null ? [] : targetIdsByPlayer.get(playerId) ?? [];
      return {
        id: String(row['id']),
        playerId,
        playerTag: typeof player?.['tag'] === 'string' ? player['tag'] : null,
        playerName: typeof player?.['name'] === 'string' ? player['name'] : null,
        reason: String(row['reason']),
        createdByProfileId,
        createdByDiscordId,
        createdAt: String(row['created_at']),
        expiresAt: typeof row['expires_at'] === 'string' ? row['expires_at'] : null,
        removedAt: null,
        haystack: [
          typeof player?.['tag'] === 'string' ? player['tag'] : '',
          typeof player?.['name'] === 'string' ? player['name'] : '',
          String(row['reason']),
          createdByDiscordId ?? '',
          createdByDiscordId === null ? '' : usernames.get(createdByDiscordId) ?? '',
          ...targetIds,
          ...targetIds.map((id) => usernames.get(id) ?? ''),
        ]
          .join('\n')
          .toLowerCase(),
      };
    })
    .filter((entry) => search === '' || entry.haystack.includes(search))
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    )
    .map(({ haystack: _haystack, ...entry }) => entry);

  const limit =
    typeof args['p_limit'] === 'number' ? Math.max(1, Math.floor(args['p_limit'])) : 100;
  const offset =
    typeof args['p_offset'] === 'number' ? Math.max(0, Math.floor(args['p_offset'])) : 0;
  return rpcOk({ entries: entries.slice(offset, offset + limit), total: entries.length });
}

function createRpcHandler(tables: Tables) {
  return vi.fn((name: string, args: Row): RpcResponse => {
    if (name === 'moderation_blacklist_add') {
      return rpcOk({ id: BLACKLIST_ID, createdAt: CREATED_AT });
    }
    if (name === 'moderation_blacklist_list') {
      return listRpcFromTables(tables, args);
    }
    return rpcOk({ id: BLACKLIST_ID, removedAt: REMOVED_AT });
  });
}

async function expectModerationError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ModerationServiceError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ModerationServiceError);
    expect((error as ModerationServiceError).code).toBe(code);
  }
}

describe('moderation actor authorization', () => {
  it('grants management only to global owner and admin', async () => {
    const db: any = createFakeDb(baseTables(), () => rpcOk({}));
    const owner = await resolveModerationActor(OWNER_DISCORD, { db });
    const admin = await resolveModerationActor(ADMIN_DISCORD, { db });

    expect(owner).toEqual({
      profileId: OWNER_PROFILE,
      discordUserId: OWNER_DISCORD,
      globalRole: 'owner',
    });
    expect(admin.globalRole).toBe('admin');
    expect(canManageBlacklists(owner)).toBe(true);
    expect(canManageBlacklists(admin)).toBe(true);
  });

  it('never grants management to club staff, global staff or members', async () => {
    const db: any = createFakeDb(baseTables(), () => rpcOk({}));
    const staff = await resolveModerationActor(STAFF_DISCORD, { db });
    const clubStaff = await resolveModerationActor(CLUB_STAFF_DISCORD, { db });
    const member = await resolveModerationActor(MEMBER_DISCORD, { db });

    expect(staff.globalRole).toBe('staff');
    expect(clubStaff.globalRole).toBeNull();
    expect(member.globalRole).toBe('member');
    expect(canManageBlacklists(staff)).toBe(false);
    expect(canManageBlacklists(clubStaff)).toBe(false);
    expect(canManageBlacklists(member)).toBe(false);
  });

  it('rejects unlinked Discord users and invalid snowflakes', async () => {
    const db: any = createFakeDb(baseTables(), () => rpcOk({}));
    await expectModerationError(resolveModerationActor(UNLINKED_DISCORD, { db }), 'profile_not_linked');
    await expectModerationError(resolveModerationActor('not-a-snowflake', { db }), 'invalid_discord_id');
  });
});

describe('moderation service', () => {
  let tables: Tables;
  let rpcHandler: ReturnType<typeof createRpcHandler>;
  let db: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    tables = baseTables();
    tables['players'] = [
      ...(tables['players'] ?? []),
      playerRow({ id: OTHER_PLAYER_ID, tag: 'P0RQ', name: 'Bravo' }),
    ];
    rpcHandler = createRpcHandler(tables);
    db = createFakeDb(tables, rpcHandler);
  });

  it('resolves only stored players and rejects invalid or unknown tags', async () => {
    const target = await resolveBlacklistTarget(' ##2c0y ', { db: db as any });
    expect(target).toEqual({ id: PLAYER_ID, tag: '2C0Y', name: 'Alpha' });
    expect(db.queries.some((query) => query.table === 'players' && query.select === 'id, tag, name')).toBe(true);

    await expectModerationError(resolveBlacklistTarget('!!!', { db: db as any }), 'invalid-tag');
    await expectModerationError(resolveBlacklistTarget('P0RQ2', { db: db as any }), 'player-not-found');
    expect(rpcHandler).not.toHaveBeenCalled();
  });

  it('blocks unauthorized adds and removes before any write', async () => {
    await expectModerationError(
      addBlacklist({ discordUserId: STAFF_DISCORD, tag: '2C0Y', reason: 'Spam' }, { db: db as any }),
      'forbidden',
    );
    await expectModerationError(
      removeBlacklist(
        { discordUserId: CLUB_STAFF_DISCORD, blacklistId: BLACKLIST_ID, reason: 'Appeal' },
        { db: db as any },
      ),
      'forbidden',
    );
    expect(rpcHandler).not.toHaveBeenCalled();
  });

  it('adds with the exact audit RPC, normalized tag and trimmed reason', async () => {
    const result = await addBlacklist(
      { discordUserId: ADMIN_DISCORD, tag: '  ##2c0y ', reason: '  Spamming   chat  ' },
      { db: db as any },
    );

    expect(result).toEqual({
      id: BLACKLIST_ID,
      player: { id: PLAYER_ID, tag: '2C0Y', name: 'Alpha' },
      reason: 'Spamming   chat',
      createdAt: CREATED_AT,
    });
    expect(db.rpcCalls).toEqual([
      {
        name: 'moderation_blacklist_add',
        args: {
          p_player_id: PLAYER_ID,
          p_reason: 'Spamming   chat',
          p_expires_at: null,
          p_actor_profile_id: ADMIN_PROFILE,
          p_actor_discord_id: ADMIN_DISCORD,
        },
      },
    ]);
  });

  it('uses a default reason and rejects reasons over 500 characters', async () => {
    const defaulted = await addBlacklist(
      { discordUserId: OWNER_DISCORD, tag: '2C0Y', reason: '   ' },
      { db: db as any },
    );
    expect(defaulted.reason).toBe('No reason provided');
    expect(rpcHandler).toHaveBeenCalledTimes(1);

    await expectModerationError(
      addBlacklist(
        { discordUserId: OWNER_DISCORD, tag: '2C0Y', reason: 'x'.repeat(501) },
        { db: db as any },
      ),
      'invalid-reason',
    );
    expect(rpcHandler).toHaveBeenCalledTimes(1);
  });

  it('maps duplicate_active and unknown add codes from the database', async () => {
    rpcHandler.mockImplementationOnce(() => rpcCode('duplicate_active'));
    await expectModerationError(
      addBlacklist({ discordUserId: OWNER_DISCORD, tag: '2C0Y', reason: 'Spam' }, { db: db as any }),
      'duplicate_active',
    );

    rpcHandler.mockImplementationOnce(() => rpcCode('unknown'));
    await expectModerationError(
      addBlacklist({ discordUserId: OWNER_DISCORD, tag: '2C0Y', reason: 'Spam' }, { db: db as any }),
      'unknown',
    );
  });

  it('removes with the exact audit RPC and maps repeated or missing entries', async () => {
    const result = await removeBlacklist(
      {
        discordUserId: OWNER_DISCORD,
        blacklistId: BLACKLIST_ID,
        reason: '  Appeal approved  ',
      },
      { db: db as any },
    );

    expect(result).toEqual({ id: BLACKLIST_ID, removedAt: REMOVED_AT });
    expect(db.rpcCalls[0]).toEqual({
      name: 'moderation_blacklist_remove',
      args: {
        p_blacklist_id: BLACKLIST_ID,
        p_removal_reason: 'Appeal approved',
        p_actor_profile_id: OWNER_PROFILE,
        p_actor_discord_id: OWNER_DISCORD,
      },
    });

    rpcHandler.mockImplementationOnce(() => rpcCode('already_removed'));
    await expectModerationError(
      removeBlacklist({ discordUserId: OWNER_DISCORD, blacklistId: BLACKLIST_ID }, { db: db as any }),
      'already_removed',
    );

    rpcHandler.mockImplementationOnce(() => rpcCode('not_found'));
    await expectModerationError(
      removeBlacklist({ discordUserId: OWNER_DISCORD, blacklistId: BLACKLIST_ID }, { db: db as any }),
      'not_found',
    );
  });

  it('treats a blank or oversized removal reason correctly', async () => {
    await removeBlacklist(
      { discordUserId: OWNER_DISCORD, blacklistId: BLACKLIST_ID, reason: '   ' },
      { db: db as any },
    );
    expect(db.rpcCalls[0]?.args['p_removal_reason']).toBeNull();

    await expectModerationError(
      removeBlacklist(
        { discordUserId: OWNER_DISCORD, blacklistId: BLACKLIST_ID, reason: 'x'.repeat(501) },
        { db: db as any },
      ),
      'invalid-reason',
    );
    expect(rpcHandler).toHaveBeenCalledTimes(1);
  });

  it('requires an authorized actor Discord ID for reads', async () => {
    await expectModerationError(listActiveBlacklists({}, { db: db as any }), 'forbidden');
    await expectModerationError(
      listActiveBlacklists({}, { db: db as any, actorDiscordUserId: STAFF_DISCORD }),
      'forbidden',
    );
  });

  it('lists only active rows with joined player and creator identity', async () => {
    const view = await listActiveBlacklists(
      {},
      { db: db as any, actorDiscordUserId: OWNER_DISCORD },
    );

    expect(view.generatedAt).toBeInstanceOf(Date);
    expect(view.entries).toHaveLength(2);
    expect(view.entries[0]).toEqual({
      id: BLACKLIST_ID,
      playerId: PLAYER_ID,
      playerTag: '2C0Y',
      playerName: 'Alpha',
      reason: 'Spamming chat',
      createdByProfileId: OWNER_PROFILE,
      createdByDiscordId: OWNER_DISCORD,
      createdAt: CREATED_AT,
      expiresAt: null,
      removedAt: null,
    });
    expect(view.entries[1]?.playerName).toBe('Bravo');
    expect(view.entries[1]?.createdByDiscordId).toBe(ADMIN_DISCORD);
    expect(view.total).toBe(2);

    expect(db.rpcCalls).toContainEqual({
      name: 'moderation_blacklist_list',
      args: {
        p_actor_profile_id: OWNER_PROFILE,
        p_actor_discord_id: OWNER_DISCORD,
        p_search: null,
        p_limit: 100,
        p_offset: 0,
      },
    });
    // Search, ordering, identity joins and counting all live in the RPC.
    expect(db.queries.some((query) => query.table === 'blacklists')).toBe(false);
    expect(db.queries.some((query) => query.table === 'player_verifications')).toBe(false);
  });

  it('filters active entries by player, reason, creator and verified target Discord identity', async () => {
    const byPlayer = await listActiveBlacklists(
      { search: 'bravo' },
      { db: db as any, actorDiscordUserId: OWNER_DISCORD },
    );
    expect(byPlayer.entries.map((entry) => entry.id)).toEqual([OTHER_BLACKLIST_ID]);

    const byReason = await listActiveBlacklists(
      { search: 'SPAMMING' },
      { db: db as any, actorDiscordUserId: OWNER_DISCORD },
    );
    expect(byReason.entries.map((entry) => entry.id)).toEqual([BLACKLIST_ID]);

    const byCreator = await listActiveBlacklists(
      { search: ADMIN_DISCORD },
      { db: db as any, actorDiscordUserId: OWNER_DISCORD },
    );
    expect(byCreator.entries.map((entry) => entry.id)).toEqual([OTHER_BLACKLIST_ID]);

    const byTargetDiscordId = await listActiveBlacklists(
      { search: MEMBER_DISCORD },
      { db: db as any, actorDiscordUserId: OWNER_DISCORD },
    );
    expect(byTargetDiscordId.entries.map((entry) => entry.id)).toEqual([BLACKLIST_ID]);

    const byTargetUsername = await listActiveBlacklists(
      { search: 'BLACKLISTED-PLAYER' },
      { db: db as any, actorDiscordUserId: OWNER_DISCORD },
    );
    expect(byTargetUsername.entries.map((entry) => entry.id)).toEqual([BLACKLIST_ID]);
    expect(
      db.rpcCalls
        .filter((call) => call.name === 'moderation_blacklist_list')
        .map((call) => call.args['p_search']),
    ).toEqual(['bravo', 'SPAMMING', ADMIN_DISCORD, MEMBER_DISCORD, 'BLACKLISTED-PLAYER']);
  });

  it('passes explicit page, limit and offset through to the list RPC', async () => {
    const view = await listActiveBlacklists(
      { search: 'a', page: 3, limit: 5, offset: 10 },
      { db: db as any, actorDiscordUserId: OWNER_DISCORD },
    );

    expect(view.total).toBe(2);
    expect(view.entries).toEqual([]);
    expect(db.rpcCalls.at(-1)).toEqual({
      name: 'moderation_blacklist_list',
      args: {
        p_actor_profile_id: OWNER_PROFILE,
        p_actor_discord_id: OWNER_DISCORD,
        p_search: 'a',
        p_limit: 5,
        p_offset: 10,
      },
    });
  });

  it('derives the list offset from the page when no offset is supplied', async () => {
    await listActiveBlacklists(
      { page: 3, limit: 5 },
      { db: db as any, actorDiscordUserId: OWNER_DISCORD },
    );

    expect(db.rpcCalls.at(-1)?.args['p_offset']).toBe(10);
  });

  it('propagates list RPC failures', async () => {
    rpcHandler.mockImplementationOnce(() => ({ data: null, error: { message: 'list failed' } }));

    await expect(
      listActiveBlacklists({}, { db: db as any, actorDiscordUserId: OWNER_DISCORD }),
    ).rejects.toThrow('moderation_blacklist_list failed');
  });

  it('returns an empty list without inventing entries', async () => {
    tables['blacklists'] = [];
    const dbEmpty: any = createFakeDb(tables, rpcHandler);
    const view = await listActiveBlacklists(
      { search: 'anything' },
      { db: dbEmpty, actorDiscordUserId: OWNER_DISCORD },
    );
    expect(view.entries).toEqual([]);
    expect(view.generatedAt).toBeInstanceOf(Date);
  });
});
