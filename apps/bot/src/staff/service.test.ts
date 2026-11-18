import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@brawlhub/shared';
import {
  canManageStaff,
  listStaff,
  resolveStaffActor,
  StaffServiceError,
} from './service';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface QueryLog {
  readonly table: string;
  readonly select: string;
  readonly filters: Row;
}

const OWNER_PROFILE = 'profile-owner';
const ADMIN_PROFILE = 'profile-admin';
const STAFF_PROFILE = 'profile-staff';
const CLUB_OWNER_PROFILE = 'profile-club-owner';
const CLUB_ADMIN_PROFILE = 'profile-club-admin';
const CLUB_STAFF_PROFILE = 'profile-club-staff';
const MEMBER_PROFILE = 'profile-member';

const OWNER_DISCORD = '111111111111111111';
const ADMIN_DISCORD = '222222222222222222';
const STAFF_DISCORD = '333333333333333333';
const CLUB_OWNER_DISCORD = '444444444444444444';
const CLUB_ADMIN_DISCORD = '555555555555555555';
const CLUB_STAFF_DISCORD = '666666666666666666';
const MEMBER_DISCORD = '777777777777777777';

const ALPHA_CLUB = 'club-alpha';
const BRAVO_CLUB = 'club-bravo';
const GRANTED_AT = '2026-11-01T00:00:00.000Z';

function createFakeDb(tables: Tables) {
  const queries: QueryLog[] = [];

  function from(table: string) {
    const state = {
      select: '',
      filters: {} as Row,
      maybeSingle: false,
    };

    async function execute(): Promise<{ data: unknown; error: { message: string } | null }> {
      queries.push({ table, select: state.select, filters: { ...state.filters } });
      let rows = [...(tables[table] ?? [])];
      for (const [field, value] of Object.entries(state.filters)) {
        rows = rows.filter((row) => row[field] === value);
      }
      return { data: state.maybeSingle ? (rows[0] ?? null) : rows, error: null };
    }

    const builder = {
      select: (fields: string) => {
        state.select = fields;
        return builder;
      },
      eq: (field: string, value: unknown) => {
        state.filters[field] = value;
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

  return { from, queries };
}

function roleRow(
  userId: string,
  scope: 'global' | 'club',
  role: string,
  clubId: string | null = null,
): Row {
  return {
    user_id: userId,
    scope,
    club_id: clubId,
    role,
    created_at: GRANTED_AT,
  };
}

function baseTables(): Tables {
  return {
    profiles: [
      { id: OWNER_PROFILE, discord_user_id: OWNER_DISCORD },
      { id: ADMIN_PROFILE, discord_user_id: ADMIN_DISCORD },
      { id: STAFF_PROFILE, discord_user_id: STAFF_DISCORD },
      { id: CLUB_OWNER_PROFILE, discord_user_id: CLUB_OWNER_DISCORD },
      { id: CLUB_ADMIN_PROFILE, discord_user_id: CLUB_ADMIN_DISCORD },
      { id: CLUB_STAFF_PROFILE, discord_user_id: CLUB_STAFF_DISCORD },
      { id: MEMBER_PROFILE, discord_user_id: MEMBER_DISCORD },
    ],
    user_roles: [
      roleRow(OWNER_PROFILE, 'global', 'owner'),
      roleRow(ADMIN_PROFILE, 'global', 'admin'),
      roleRow(STAFF_PROFILE, 'global', 'staff'),
      roleRow(CLUB_OWNER_PROFILE, 'club', 'owner', ALPHA_CLUB),
      roleRow(CLUB_OWNER_PROFILE, 'club', 'staff', BRAVO_CLUB),
      roleRow(CLUB_ADMIN_PROFILE, 'club', 'admin', ALPHA_CLUB),
      roleRow(CLUB_STAFF_PROFILE, 'club', 'staff', BRAVO_CLUB),
      roleRow(MEMBER_PROFILE, 'club', 'member', ALPHA_CLUB),
    ],
    clubs: [
      { id: ALPHA_CLUB, tag: 'ALPHA', name: 'Alpha' },
      { id: BRAVO_CLUB, tag: 'BRAVO', name: 'Bravo' },
    ],
    discord_users: [
      { discord_user_id: OWNER_DISCORD, username: 'Owner#0001', notes: 'private note' },
      { discord_user_id: ADMIN_DISCORD, username: 'Admin#0002' },
    ],
  };
}

async function expectStaffError(
  promise: Promise<unknown>,
  code: string,
  message?: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected StaffServiceError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(StaffServiceError);
    expect((error as StaffServiceError).code).toBe(code);
    if (message !== undefined) expect((error as Error).message).toBe(message);
  }
}

describe('staff actor authorization', () => {
  it('lets global owners and admins manage staff, but not global staff', async () => {
    const db: any = createFakeDb(baseTables());
    const owner = await resolveStaffActor(OWNER_DISCORD, { db });
    const admin = await resolveStaffActor(ADMIN_DISCORD, { db });
    const staff = await resolveStaffActor(STAFF_DISCORD, { db });

    expect(owner).toMatchObject({ profileId: OWNER_PROFILE, globalRole: 'owner' });
    expect(admin.globalRole).toBe('admin');
    expect(canManageStaff(owner)).toBe(true);
    expect(canManageStaff(admin)).toBe(true);
    expect(canManageStaff(staff)).toBe(false);
  });

  it('never grants staff:manage from club owner, admin or staff roles', async () => {
    const db: any = createFakeDb(baseTables());
    for (const discordUserId of [CLUB_OWNER_DISCORD, CLUB_ADMIN_DISCORD, CLUB_STAFF_DISCORD]) {
      const actor = await resolveStaffActor(discordUserId, { db });
      expect(actor.globalRole).toBeNull();
      expect(canManageStaff(actor)).toBe(false);
    }
  });

  it('derives only the highest global role for the actor', async () => {
    const tables = baseTables();
    tables['user_roles'] = [
      roleRow(OWNER_PROFILE, 'global', 'staff'),
      roleRow(OWNER_PROFILE, 'global', 'admin'),
      roleRow(OWNER_PROFILE, 'club', 'owner', ALPHA_CLUB),
    ];
    const db: any = createFakeDb(tables);
    const actor = await resolveStaffActor(OWNER_DISCORD, { db });
    expect(actor.globalRole).toBe('admin');
    expect(canManageStaff(actor)).toBe(true);
  });

  it('rejects unlinked and invalid Discord users', async () => {
    const db: any = createFakeDb(baseTables());
    const message =
      'Your Discord account is not linked to BrawlHub. Sign in to the website first.';
    await expectStaffError(resolveStaffActor('999999999999999999', { db }), 'profile_not_linked', message);
    await expectStaffError(resolveStaffActor('not-a-snowflake', { db }), 'profile_not_linked', message);
  });
});

describe('staff listing', () => {
  it('includes global and club staff and excludes member-only roles', async () => {
    const fakeDb = createFakeDb(baseTables());
    const view = await listStaff({ db: fakeDb as any });
    const queries = fakeDb.queries;

    expect(view.entries).toHaveLength(6);
    expect(view.globalCount).toBe(3);
    expect(view.clubCount).toBe(4);
    expect(view.generatedAt).toBeInstanceOf(Date);
    expect(view.entries.some((entry) => entry.profileId === MEMBER_PROFILE)).toBe(false);

    const tableNames = queries.map((query) => query.table);
    expect(tableNames).toEqual(
      expect.arrayContaining(['user_roles', 'profiles', 'clubs', 'discord_users']),
    );
    expect(tableNames).not.toContain('staff_members');
    expect(queries.every((query) => !query.select.includes('):'))).toBe(true);
    expect(queries.find((query) => query.table === 'discord_users')?.select).not.toContain('notes');
  });

  it('separates club scope from global scope and sorts club assignments', async () => {
    const db: any = createFakeDb(baseTables());
    const view = await listStaff({ db });

    const owner = view.entries.find((entry) => entry.profileId === OWNER_PROFILE);
    expect(owner?.highestGlobalRole).toBe('owner');
    expect(owner?.roles).toEqual([
      expect.objectContaining({ scope: 'global', role: 'owner', clubId: null }),
    ]);
    expect(owner?.permissions).toEqual([...ROLE_PERMISSIONS.owner]);

    const clubOwner = view.entries.find((entry) => entry.profileId === CLUB_OWNER_PROFILE);
    expect(clubOwner?.highestGlobalRole).toBeNull();
    expect(clubOwner?.roles.map((role) => role.scope)).toEqual(['club', 'club']);
    expect(clubOwner?.roles.map((role) => role.clubName)).toEqual(['Alpha', 'Bravo']);
    expect(clubOwner?.roles[0]).toMatchObject({
      role: 'owner',
      clubId: ALPHA_CLUB,
      clubTag: 'ALPHA',
      grantedAt: GRANTED_AT,
    });
    expect(clubOwner?.permissions).toContain('staff:manage');
    expect(canManageStaff(await resolveStaffActor(CLUB_OWNER_DISCORD, { db }))).toBe(false);
  });

  it('uses Discord usernames when present and falls back to null', async () => {
    const db: any = createFakeDb(baseTables());
    const view = await listStaff({ db });
    const byProfile = (profileId: string) =>
      view.entries.find((entry) => entry.profileId === profileId);

    expect(byProfile(OWNER_PROFILE)?.discordUserId).toBe(OWNER_DISCORD);
    expect(byProfile(OWNER_PROFILE)?.discordUsername).toBe('Owner#0001');
    expect(byProfile(CLUB_STAFF_PROFILE)?.discordUsername).toBeNull();
    expect(JSON.stringify(view)).not.toContain('private note');
  });

  it('returns an empty view when no staff roles are stored', async () => {
    const db: any = createFakeDb({ profiles: [], user_roles: [], clubs: [], discord_users: [] });
    const view = await listStaff({ db });
    expect(view).toMatchObject({ entries: [], globalCount: 0, clubCount: 0 });
    expect(view.generatedAt).toBeInstanceOf(Date);
  });
});
