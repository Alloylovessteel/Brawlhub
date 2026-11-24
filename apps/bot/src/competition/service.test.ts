import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canManageCompetition,
  createCompetition,
  endCompetition,
  joinCompetition,
  listCompetitions,
  loadCompetitionLeaderboard,
  loadCompetitionRecord,
  CompetitionServiceError,
  resolveCompetitionActor,
  submitCompetitionResult,
} from './service';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type RpcResponse = { readonly data: unknown; readonly error: { message: string } | null };

const NOW = new Date('2026-11-18T12:00:00.000Z');
const COMPETITION_ID = '11111111-1111-4111-8111-111111111111';
const PLAYER_ID = '22222222-2222-4222-8222-222222222222';
const STAFF_PROFILE = '33333333-3333-4333-8333-333333333333';
const MEMBER_PROFILE = '44444444-4444-4444-8444-444444444444';
const ENTRY_ID = '55555555-5555-4555-8555-555555555555';
const CLUB_ID = '66666666-6666-4666-8666-666666666666';

function createFakeDb(tables: Tables, rpc: (name: string, args: Row) => RpcResponse) {
  const rpcCalls: { name: string; args: Row }[] = [];
  const queries: { table: string; limit: number | null }[] = [];

  function from(table: string) {
    const state = {
      filters: {} as Row,
      maybeSingle: false,
      limit: null as number | null,
      orders: 0,
    };

    async function execute(): Promise<{ data: unknown; error: { message: string } | null }> {
      queries.push({ table, limit: state.limit });
      let rows = [...(tables[table] ?? [])];
      for (const [field, value] of Object.entries(state.filters)) {
        rows = rows.filter((row) =>
          typeof value === 'function' ? value(row[field]) : row[field] === value,
        );
      }
      if (state.limit !== null) rows = rows.slice(0, state.limit);
      return {
        data: state.maybeSingle ? (rows[0] ?? null) : rows,
        error: null,
      };
    }

    const builder = {
      select: () => builder,
      eq: (field: string, value: unknown) => {
        state.filters[field] = value;
        return builder;
      },
      is: (field: string, value: unknown) => {
        state.filters[field] = value;
        return builder;
      },
      in: (field: string, values: unknown[]) => {
        state.filters[field] = (value: unknown) => values.includes(value);
        return builder;
      },
      order: () => {
        state.orders += 1;
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
      return rpc(name, args);
    },
  };
}

function baseTables(): Tables {
  return {
    profiles: [
      { id: STAFF_PROFILE, discord_user_id: '111111111111111111' },
      { id: MEMBER_PROFILE, discord_user_id: '222222222222222222' },
    ],
    user_roles: [
      { user_id: STAFF_PROFILE, scope: 'global', club_id: null, role: 'staff' },
      { user_id: MEMBER_PROFILE, scope: 'club', club_id: CLUB_ID, role: 'member' },
    ],
    competitions: [competitionRow()],
    competition_entries: [],
    competition_submissions: [],
    player_verifications: [
      {
        id: 'verification-1',
        profile_id: STAFF_PROFILE,
        player_id: PLAYER_ID,
        status: 'active',
        verified_at: '2026-11-17T00:00:00.000Z',
        method: 'manual_staff',
        player: playerRow(),
      },
    ],
    players: [playerRow()],
  };
}

function competitionRow(overrides: Row = {}): Row {
  return {
    id: COMPETITION_ID,
    name: 'Midseason Climb',
    rules: 'No camping',
    club_id: null,
    club: null,
    starts_at: '2026-11-20T00:00:00.000Z',
    ends_at: '2026-11-22T00:00:00.000Z',
    goal: 10_000,
    status: 'scheduled',
    created_by: STAFF_PROFILE,
    created_at: '2026-11-18T00:00:00.000Z',
    ended_by: null,
    ended_at: null,
    ...overrides,
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

function entryRow(overrides: Row = {}): Row {
  return {
    id: ENTRY_ID,
    competition_id: COMPETITION_ID,
    player_id: PLAYER_ID,
    player: playerRow(),
    joined_at: '2026-11-18T01:00:00.000Z',
    baseline_trophies: 4_000,
    baseline_source: 'player_snapshot',
    baseline_captured_at: '2026-11-19T23:00:00.000Z',
    ...overrides,
  };
}

function submissionRow(overrides: Row = {}): Row {
  return {
    id: 'submission-1',
    competition_id: COMPETITION_ID,
    entry_id: ENTRY_ID,
    trophies: 5_000,
    source: 'user',
    verification_status: 'unverified',
    accepted: true,
    submitted_by_profile_id: STAFF_PROFILE,
    submitted_at: '2026-11-20T12:00:00.000Z',
    verified_snapshot_id: null,
    verified_by_profile_id: null,
    ...overrides,
  };
}

function rpcOk(data: Row): RpcResponse {
  return { data: { ok: true, ...data }, error: null };
}

function rpcCode(code: string): RpcResponse {
  return { data: { ok: false, code }, error: null };
}

function createRpcHandler() {
  return vi.fn((name: string, _args: Row): RpcResponse => {
    if (name === 'push_create_competition') return rpcOk({ id: COMPETITION_ID });
    if (name === 'push_join_competition') {
      return rpcOk({
        id: ENTRY_ID,
        baselineTrophies: 4_000,
        baselineSource: 'player_snapshot',
        baselineCapturedAt: '2026-11-19T23:00:00.000Z',
      });
    }
    if (name === 'push_submit_result') {
      return rpcOk({
        id: 'submission-1',
        submittedAt: '2026-11-20T12:00:00.000Z',
        trophies: 5_000,
        verificationStatus: 'unverified',
      });
    }
    return rpcOk({ id: COMPETITION_ID, endedAt: '2026-11-21T00:00:00.000Z' });
  });
}

async function expectCompetitionError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected CompetitionServiceError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CompetitionServiceError);
    expect((error as CompetitionServiceError).code).toBe(code);
  }
}

describe('competition actor authorization', () => {
  it('derives staff and club roles from stored user_roles', async () => {
    const db: any = createFakeDb(baseTables(), () => rpcOk({}));
    const staff = await resolveCompetitionActor('111111111111111111', { db });
    const member = await resolveCompetitionActor('222222222222222222', { db });

    expect(staff.profileId).toBe(STAFF_PROFILE);
    expect(staff.globalRole).toBe('staff');
    expect(canManageCompetition(staff, null)).toBe(true);
    expect(member.clubRoles.get(CLUB_ID)).toBe('member');
    expect(canManageCompetition(member, CLUB_ID)).toBe(false);
    expect(canManageCompetition(member, null)).toBe(false);
  });

  it('rejects Discord users without a BrawlHub profile', async () => {
    const db: any = createFakeDb(baseTables(), () => rpcOk({}));
    await expectCompetitionError(resolveCompetitionActor('999999999999999999', { db }), 'profile_not_linked');
  });
});

describe('competition service', () => {
  let tables: Tables;
  let rpcHandler: ReturnType<typeof createRpcHandler>;
  let db: any;

  beforeEach(() => {
    tables = baseTables();
    rpcHandler = createRpcHandler();
    db = createFakeDb(tables, rpcHandler);
  });

  it('creates a competition with parsed dates and an audit-backed RPC', async () => {
    const competition = await createCompetition(
      {
        discordUserId: '111111111111111111',
        name: '  Midseason   Climb ',
        description: '  No camping ',
        start: '2026-11-20T00:00Z',
        end: '2026-11-22T00:00Z',
        clubId: null,
        goal: 10_000,
      },
      { db, now: NOW },
    );

    expect(competition.name).toBe('Midseason Climb');
    expect(rpcHandler).toHaveBeenCalledWith(
      'push_create_competition',
      expect.objectContaining({
        p_name: 'Midseason Climb',
        p_description: 'No camping',
        p_starts_at: '2026-11-20T00:00:00.000Z',
        p_ends_at: '2026-11-22T00:00:00.000Z',
        p_created_by: STAFF_PROFILE,
      }),
    );
  });

  it('rejects invalid date ranges before writing', async () => {
    await expectCompetitionError(
      createCompetition(
        {
          discordUserId: '111111111111111111',
          name: 'Bad period',
          description: null,
          start: '2026-11-22T00:00Z',
          end: '2026-11-20T00:00Z',
          clubId: null,
          goal: null,
        },
        { db, now: NOW },
      ),
      'invalid_input',
    );
    expect(rpcHandler).not.toHaveBeenCalled();
  });

  it('does not expose creation to ordinary members or duplicate configurations', async () => {
    await expectCompetitionError(
      createCompetition(
        {
          discordUserId: '222222222222222222',
          name: 'Member competition',
          description: null,
          start: '2026-11-20T00:00Z',
          end: '2026-11-22T00:00Z',
          clubId: CLUB_ID,
          goal: null,
        },
        { db, now: NOW },
      ),
      'forbidden',
    );
    expect(rpcHandler).not.toHaveBeenCalled();

    rpcHandler.mockImplementation(() => rpcCode('duplicate'));
    await expectCompetitionError(
      createCompetition(
        {
          discordUserId: '111111111111111111',
          name: 'Midseason Climb',
          description: null,
          start: '2026-11-20T00:00Z',
          end: '2026-11-22T00:00Z',
          clubId: null,
          goal: null,
        },
        { db, now: NOW },
      ),
      'duplicate',
    );
  });

  it('joins only with a verified account and preserves the returned baseline', async () => {
    const result = await joinCompetition(
      { discordUserId: '111111111111111111', competitionId: COMPETITION_ID, playerId: PLAYER_ID },
      { db },
    );

    expect(result).toMatchObject({
      entryId: ENTRY_ID,
      baselineTrophies: 4_000,
      baselineSource: 'player_snapshot',
    });

    tables['player_verifications'] = [];
    await expectCompetitionError(
      joinCompetition(
        { discordUserId: '111111111111111111', competitionId: COMPETITION_ID, playerId: PLAYER_ID },
        { db },
      ),
      'not_verified',
    );
    expect(rpcHandler).toHaveBeenCalledTimes(1);
  });

  it('maps duplicate, ended and club-restriction failures from the database', async () => {
    for (const code of ['already_joined', 'ended', 'wrong_club'] as const) {
      rpcHandler.mockImplementationOnce(() => rpcCode(code));
      await expectCompetitionError(
        joinCompetition(
          { discordUserId: '111111111111111111', competitionId: COMPETITION_ID, playerId: PLAYER_ID },
          { db },
        ),
        code,
      );
    }
  });

  it('records repeated submissions as unverified user values', async () => {
    const result = await submitCompetitionResult(
      {
        discordUserId: '111111111111111111',
        competitionId: COMPETITION_ID,
        playerId: PLAYER_ID,
        trophies: 5_000,
      },
      { db },
    );

    expect(result).toEqual({
      submissionId: 'submission-1',
      submittedAt: '2026-11-20T12:00:00.000Z',
      trophies: 5_000,
      verificationStatus: 'unverified',
    });
    expect(rpcHandler).toHaveBeenCalledWith(
      'push_submit_result',
      expect.objectContaining({ p_trophies: 5_000 }),
    );
  });

  it('rejects negative trophies and outside-period submissions without writing', async () => {
    await expectCompetitionError(
      submitCompetitionResult(
        {
          discordUserId: '111111111111111111',
          competitionId: COMPETITION_ID,
          playerId: PLAYER_ID,
          trophies: -5,
        },
        { db },
      ),
      'invalid_input',
    );
    expect(rpcHandler).not.toHaveBeenCalled();

    rpcHandler.mockImplementation(() => rpcCode('outside_period'));
    await expectCompetitionError(
      submitCompetitionResult(
        {
          discordUserId: '111111111111111111',
          competitionId: COMPETITION_ID,
          playerId: PLAYER_ID,
          trophies: 5_000,
        },
        { db },
      ),
      'outside_period',
    );
  });

  it('blocks submitting for another profile account', async () => {
    tables['player_verifications'] = [
      {
        id: 'verification-other',
        profile_id: MEMBER_PROFILE,
        player_id: PLAYER_ID,
        status: 'active',
        verified_at: '2026-11-17T00:00:00.000Z',
        method: 'manual_staff',
        player: playerRow(),
      },
    ];

    await expectCompetitionError(
      submitCompetitionResult(
        {
          discordUserId: '111111111111111111',
          competitionId: COMPETITION_ID,
          playerId: PLAYER_ID,
          trophies: 5_000,
        },
        { db },
      ),
      'not_verified',
    );
    expect(rpcHandler).not.toHaveBeenCalled();
  });

  it('ends a competition once and reports repeated end attempts', async () => {
    const ended = await endCompetition(
      { discordUserId: '111111111111111111', competitionId: COMPETITION_ID },
      { db },
    );
    expect(ended.name).toBe('Midseason Climb');

    rpcHandler.mockImplementation(() => rpcCode('already_ended'));
    await expectCompetitionError(
      endCompetition(
        { discordUserId: '111111111111111111', competitionId: COMPETITION_ID },
        { db },
      ),
      'already_ended',
    );
  });

  it('lists competitions with uncapped entry counts', async () => {
    tables['competition_entries'] = [entryRow(), entryRow({ id: 'entry-2' })];
    const competitions = await listCompetitions({ db });
    expect(competitions).toHaveLength(1);
    expect(competitions[0]?.entryCount).toBe(2);
    expect(
      db.queries.filter(
        (query: { table: string; limit: number | null }) => query.table === 'competition_entries',
      ),
    ).toEqual([
      { table: 'competition_entries', limit: null },
    ]);
  });

  it('keeps global competitions visible while hiding other guilds’ club competitions', async () => {
    tables['clubs'] = [{ id: CLUB_ID, guild_id: 'guild-1', archived_at: null }];
    tables['competitions'] = [
      competitionRow(),
      competitionRow({
        id: '77777777-7777-4777-8777-777777777777',
        name: 'Other Guild Cup',
        club_id: 'other-club',
        club: { id: 'other-club', tag: 'OTHER', name: 'Other' },
      }),
    ];

    const competitions = await listCompetitions({ db, guildId: 'guild-1' });
    expect(competitions.map((competition) => competition.name)).toEqual(['Midseason Climb']);
    await expect(
      loadCompetitionRecord('77777777-7777-4777-8777-777777777777', { db, guildId: 'guild-1' }),
    ).resolves.toBeNull();
    await expect(loadCompetitionRecord(COMPETITION_ID, { db, guildId: 'guild-1' })).resolves.toMatchObject({
      id: COMPETITION_ID,
      clubId: null,
    });
  });

  it('uses the latest accepted submission, handles negative gains and missing baselines', async () => {
    tables['competition_entries'] = [
      entryRow(),
      entryRow({
        id: 'entry-2',
        player_id: 'other-player',
        player: playerRow({ id: 'other-player', name: 'Bravo', tag: 'Q8VR' }),
        baseline_trophies: null,
        baseline_source: 'none',
        baseline_captured_at: null,
      }),
    ];
    tables['competition_submissions'] = [
      submissionRow({ id: 'old', trophies: 4_200, submitted_at: '2026-11-20T10:00:00.000Z' }),
      submissionRow({ id: 'new', trophies: 4_800, submitted_at: '2026-11-20T11:00:00.000Z' }),
      submissionRow({
        id: 'rejected',
        trophies: 9_999,
        submitted_at: '2026-11-20T12:00:00.000Z',
        accepted: false,
      }),
      submissionRow({
        id: 'other',
        entry_id: 'entry-2',
        trophies: 3_000,
        submitted_at: '2026-11-20T09:00:00.000Z',
      }),
    ];

    const view = await loadCompetitionLeaderboard(COMPETITION_ID, { db, now: NOW });

    expect(view.rows).toHaveLength(2);
    expect(view.rows[0]?.entry.player.name).toBe('Alpha');
    expect(view.rows[0]?.trophies).toBe(4_800);
    expect(view.rows[0]?.gain).toBe(800);
    expect(view.rows[0]?.rank).toBe(1);
    expect(view.rows[1]?.entry.player.name).toBe('Bravo');
    expect(view.rows[1]?.gain).toBeNull();
    expect(view.rows[1]?.rank).toBeNull();
    expect(
      db.queries
        .filter(
          (query: { table: string; limit: number | null }) =>
            query.table === 'competition_entries' || query.table === 'competition_submissions',
        )
        .map((query: { table: string; limit: number | null }) => query.limit),
    ).toEqual([null, null, null]);
  });

  it('handles an empty competition without inventing rows', async () => {
    const view = await loadCompetitionLeaderboard(COMPETITION_ID, { db, now: NOW });
    expect(view.rows).toEqual([]);
  });
});
