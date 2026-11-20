import { describe, expect, it } from 'vitest';
import {
  canInspectIdentityLinks,
  loadTrackedMembers,
  normalizeMemberSearchQuery,
  resolveMembershipActor,
  searchTrackedMembersByDiscord,
  searchTrackedMembersByPlayer,
} from './service';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

const NOW = new Date('2026-11-18T12:00:00.000Z');
const CLUB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLUB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PLAYER_A = '11111111-1111-4111-8111-111111111111';
const PLAYER_B = '22222222-2222-4222-8222-222222222222';
const STAFF_PROFILE = '33333333-3333-4333-8333-333333333333';
const MEMBER_PROFILE = '44444444-4444-4444-8444-444444444444';
const TARGET_PROFILE = '55555555-5555-4555-8555-555555555555';
const STAFF_DISCORD = '111111111111111111';
const MEMBER_DISCORD = '222222222222222222';
const TARGET_DISCORD = '333333333333333333';

function createFakeDb(initialTables: Tables) {
  const queriedTables: string[] = [];
  const tables: Tables = { ...initialTables };

  function from(table: string) {
    queriedTables.push(table);
    const state = {
      filters: {} as Row,
      inFilters: [] as Array<{ field: string; values: unknown[] }>,
      orParts: [] as string[],
      maybeSingle: false,
      limit: null as number | null,
    };

    async function execute(): Promise<{ data: unknown; error: { message: string } | null }> {
      let rows = [...(tables[table] ?? [])];
      for (const [field, value] of Object.entries(state.filters)) {
        rows = rows.filter((row) => (row[field] ?? null) === value);
      }
      for (const filter of state.inFilters) {
        rows = rows.filter((row) => filter.values.includes(row[filter.field]));
      }
      if (state.orParts.length > 0) {
        const matchers = state.orParts
          .map((part) => /^(\w+)\.ilike\.%(.*)%$/.exec(part))
          .filter((match): match is RegExpExecArray => match !== null)
          .map((match) => ({
            field: match[1] as string,
            needle: (match[2] ?? '').replace(/\\(.)/g, '$1').toLowerCase(),
          }));
        rows = rows.filter((row) =>
          matchers.some((matcher) =>
            String(row[matcher.field] ?? '').toLowerCase().includes(matcher.needle),
          ),
        );
      }
      if (state.limit !== null) rows = rows.slice(0, state.limit);
      return { data: state.maybeSingle ? (rows[0] ?? null) : rows, error: null };
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
        state.inFilters.push({ field, values });
        return builder;
      },
      or: (expression: string) => {
        state.orParts.push(...expression.split(','));
        return builder;
      },
      order: () => builder,
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

  return { from, queriedTables, tables };
}

function playerRow(overrides: Row = {}): Row {
  return {
    id: PLAYER_A,
    tag: '2C0Y',
    name: 'Alpha',
    trophies: 5000,
    highest_trophies: 5200,
    exp_level: 35,
    last_synced_at: '2026-11-18T11:55:00.000Z',
    ...overrides,
  };
}

function clubRef(clubId: string, overrides: Row = {}): Row {
  return {
    id: clubId,
    tag: clubId === CLUB_A ? '8QCL' : '9QVR',
    name: clubId === CLUB_A ? 'Alpha Club' : 'Beta Club',
    ...overrides,
  };
}

function membershipRow(
  player: Row,
  clubId: string,
  overrides: Row = {},
) {
  return {
    id: `membership-${clubId}-${player['tag']}`,
    club_id: clubId,
    player_id: player['id'],
    role: 'member',
    valid_from: '2026-11-01T00:00:00.000Z',
    valid_to: null,
    player,
    club: clubRef(clubId),
    ...overrides,
  };
}

function baseTables(): Tables {
  return {
    clubs: [clubRef(CLUB_A), clubRef(CLUB_B)],
    players: [playerRow()],
    club_memberships: [membershipRow(playerRow(), CLUB_A)],
    profiles: [],
    user_roles: [],
    player_verifications: [],
  };
}

function options(db: ReturnType<typeof createFakeDb>) {
  return { db: db as never, now: NOW };
}

describe('membership service — tracked members', () => {
  it('lists current, historical and incomplete memberships with a club filter', async () => {
    const alpha = playerRow();
    const bravo = playerRow({
      id: PLAYER_B,
      tag: 'Q8VR',
      name: 'Bravo',
      last_synced_at: '2026-10-01T00:00:00.000Z',
    });
    const db = createFakeDb(baseTables());
    db.tables['players'] = [alpha, bravo];
    db.tables['club_memberships'] = [
      membershipRow(alpha, CLUB_A),
      membershipRow(bravo, CLUB_A, {
        valid_from: '2026-09-01T00:00:00.000Z',
        valid_to: '2026-10-01T00:00:00.000Z',
      }),
      membershipRow(alpha, CLUB_B, {
        valid_from: '2026-08-01T00:00:00.000Z',
        valid_to: '2026-09-01T00:00:00.000Z',
      }),
      membershipRow(bravo, CLUB_B, { valid_from: null }),
    ];

    const all = await loadTrackedMembers({}, options(db));
    expect(all.kind).toBe('ok');
    if (all.kind !== 'ok') return;
    expect(all.value.records).toHaveLength(4);
    expect(all.value.currentCount).toBe(1);
    expect(all.value.historicalCount).toBe(3);
    expect(all.value.records[0]?.status).toBe('current');
    expect(all.value.records.some((record) => record.status === 'past')).toBe(true);
    expect(all.value.records.some((record) => record.status === 'incomplete')).toBe(true);

    const filtered = await loadTrackedMembers({ tag: '#9QVR' }, options(db));
    expect(filtered.kind).toBe('ok');
    if (filtered.kind !== 'ok') return;
    expect(filtered.value.club?.id).toBe(CLUB_B);
    expect(filtered.value.records).toHaveLength(2);
    expect(filtered.value.records.every((record) => record.club.tag === '9QVR')).toBe(true);
  });

  it('rejects invalid and unregistered club tags', async () => {
    const db = createFakeDb(baseTables());
    const invalid = await loadTrackedMembers({ tag: 'not-a-tag' }, options(db));
    expect(invalid.kind).toBe('invalid-tag');

    const unregistered = await loadTrackedMembers({ tag: 'QQQQ' }, options(db));
    expect(unregistered.kind).toBe('unregistered');
  });

  it('returns an empty view when no clubs are registered', async () => {
    const db = createFakeDb({ ...baseTables(), clubs: [] });
    const result = await loadTrackedMembers({}, options(db));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.records).toEqual([]);
    expect(result.value.currentCount).toBe(0);
  });
});

describe('membership service — player search', () => {
  it('validates queries and reports empty results without API calls', async () => {
    const db = createFakeDb(baseTables());
    expect(normalizeMemberSearchQuery(' ab ')).toBe('ab');
    expect(normalizeMemberSearchQuery('a')).toBeNull();
    expect(normalizeMemberSearchQuery('a\n b')).toBeNull();
    expect(normalizeMemberSearchQuery('x'.repeat(33))).toBeNull();

    const invalid = await searchTrackedMembersByPlayer('a', options(db));
    expect(invalid.kind).toBe('invalid-input');

    db.tables['players'] = [];
    const empty = await searchTrackedMembersByPlayer('nobody', options(db));
    expect(empty.kind).toBe('ok');
    if (empty.kind !== 'ok') return;
    expect(empty.value.entries).toEqual([]);
    expect(db.queriedTables).not.toContain('club_memberships');
  });

  it('finds players by name and tag and removes duplicate rows', async () => {
    const alpha = playerRow();
    const duplicate = playerRow();
    const db = createFakeDb(baseTables());
    db.tables['players'] = [alpha, duplicate];
    db.tables['club_memberships'] = [membershipRow(alpha, CLUB_A)];

    const byName = await searchTrackedMembersByPlayer('alpha', options(db));
    expect(byName.kind).toBe('ok');
    if (byName.kind !== 'ok') return;
    expect(byName.value.entries).toHaveLength(1);
    expect(byName.value.entries[0]?.playerTag).toBe('2C0Y');
    expect(byName.value.entries[0]?.currentClub?.tag).toBe('8QCL');

    const byTag = await searchTrackedMembersByPlayer('#2c0y', options(db));
    expect(byTag.kind).toBe('ok');
    if (byTag.kind !== 'ok') return;
    expect(byTag.value.query).toBe('#2c0y');
    expect(byTag.value.entries).toHaveLength(1);
  });

  it('prefers the current club when a player has multiple memberships', async () => {
    const alpha = playerRow();
    const db = createFakeDb(baseTables());
    db.tables['players'] = [alpha];
    db.tables['club_memberships'] = [
      membershipRow(alpha, CLUB_A),
      membershipRow(alpha, CLUB_B, {
        valid_to: '2026-10-01T00:00:00.000Z',
        valid_from: '2026-09-01T00:00:00.000Z',
      }),
    ];

    const result = await searchTrackedMembersByPlayer('alpha', options(db));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.entries[0]?.currentClub?.tag).toBe('8QCL');
  });

  it('does not present an incomplete membership as a current club', async () => {
    const alpha = playerRow();
    const db = createFakeDb(baseTables());
    db.tables['players'] = [alpha];
    db.tables['club_memberships'] = [membershipRow(alpha, CLUB_A, { valid_from: null })];

    const result = await searchTrackedMembersByPlayer('alpha', options(db));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.entries[0]?.currentClub).toBeNull();
  });
});

describe('membership service — Discord identity search', () => {
  function identityTables(): Tables {
    return {
      ...baseTables(),
      profiles: [
        { id: STAFF_PROFILE, discord_user_id: STAFF_DISCORD },
        { id: MEMBER_PROFILE, discord_user_id: MEMBER_DISCORD },
        { id: TARGET_PROFILE, discord_user_id: TARGET_DISCORD },
      ],
      user_roles: [
        { user_id: STAFF_PROFILE, scope: 'global', club_id: null, role: 'staff' },
        { user_id: MEMBER_PROFILE, scope: 'global', club_id: null, role: 'member' },
      ],
      player_verifications: [
        {
          id: 'verification-1',
          profile_id: TARGET_PROFILE,
          player_id: PLAYER_A,
          status: 'active',
          verified_at: '2026-11-17T00:00:00.000Z',
          player: playerRow(),
        },
      ],
    };
  }

  it('allows global staff to inspect active identity links only', async () => {
    const db = createFakeDb(identityTables());
    db.tables['club_memberships'] = [membershipRow(playerRow(), CLUB_A)];

    const result = await searchTrackedMembersByDiscord(TARGET_DISCORD, STAFF_DISCORD, options(db));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.mode).toBe('discord');
    expect(result.value.identityContext).toBe(true);
    expect(result.value.entries).toHaveLength(1);
    expect(result.value.entries[0]?.playerTag).toBe('2C0Y');
  });

  it('allows a user to inspect only their own identity links', async () => {
    const db = createFakeDb(identityTables());
    db.tables['profiles'] = [
      { id: TARGET_PROFILE, discord_user_id: TARGET_DISCORD },
    ];
    db.tables['player_verifications'] = [
      {
        id: 'verification-self',
        profile_id: TARGET_PROFILE,
        player_id: PLAYER_A,
        status: 'active',
        verified_at: '2026-11-17T00:00:00.000Z',
        player: playerRow(),
      },
    ];

    const result = await searchTrackedMembersByDiscord(TARGET_DISCORD, TARGET_DISCORD, options(db));
    expect(result.kind).toBe('ok');
  });

  it('forbids ordinary members from looking up another Discord user', async () => {
    const db = createFakeDb(identityTables());
    const actor = await resolveMembershipActor(MEMBER_DISCORD, options(db));
    expect(canInspectIdentityLinks(actor)).toBe(false);

    const result = await searchTrackedMembersByDiscord(TARGET_DISCORD, MEMBER_DISCORD, options(db));
    expect(result.kind).toBe('forbidden');
    expect(db.queriedTables).not.toContain('player_verifications');
  });

  it('reports missing links, revoked links and invalid Discord IDs safely', async () => {
    const noProfileDb = createFakeDb(identityTables());
    noProfileDb.tables['profiles'] = [
      { id: STAFF_PROFILE, discord_user_id: STAFF_DISCORD },
    ];
    const noProfile = await searchTrackedMembersByDiscord(TARGET_DISCORD, STAFF_DISCORD, options(noProfileDb));
    expect(noProfile.kind).toBe('no-identity-link');

    const revokedDb = createFakeDb(identityTables());
    revokedDb.tables['player_verifications'] = [];
    const revoked = await searchTrackedMembersByDiscord(TARGET_DISCORD, STAFF_DISCORD, options(revokedDb));
    expect(revoked.kind).toBe('no-identity-link');

    const invalid = await searchTrackedMembersByDiscord('not-a-snowflake', STAFF_DISCORD, options(revokedDb));
    expect(invalid.kind).toBe('invalid-input');
  });
});
