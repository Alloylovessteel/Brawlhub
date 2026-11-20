import { beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveGuildClub } from './archival';

const GUILD_ID = '123456789012345678';
const OTHER_GUILD_ID = '876543210987654321';
const CLUB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_CLUB_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DISCORD_ID = '111111111111111111';
const NOW = new Date('2026-11-20T12:00:00.000Z');
const ARCHIVED_AT = NOW.toISOString();

const mocks = vi.hoisted(() => ({
  createTrustedClient: vi.fn(),
  recordAdminAudit: vi.fn(),
}));

vi.mock('@brawlhub/database', () => ({ createTrustedClient: mocks.createTrustedClient }));
vi.mock('../admin/service', () => ({ recordAdminAudit: mocks.recordAdminAudit }));

type Db = NonNullable<NonNullable<Parameters<typeof archiveGuildClub>[1]>['db']>;
type Row = Record<string, unknown>;
type Operation = 'select' | 'insert' | 'delete' | 'update';

interface QueryCall {
  readonly table: string;
  readonly operation: Operation;
  readonly payload: Record<string, unknown>;
  readonly filters: Record<string, unknown>;
}

type Handler = (call: QueryCall) => { data?: unknown; error?: unknown };

interface Fixture {
  readonly clubs?: Row[];
  readonly tags?: Row[];
  readonly clubSelectError?: { readonly message: string };
  readonly clubUpdateError?: { readonly message: string };
}

function createFakeDb(fixture: Fixture = {}): {
  db: Db;
  calls: QueryCall[];
  clubs: Row[];
  tags: Row[];
} {
  const calls: QueryCall[] = [];
  const clubs = fixture.clubs === undefined ? [] : [...fixture.clubs];
  const tags = fixture.tags === undefined ? [] : [...fixture.tags];

  const handlers: Record<string, Handler> = {
    'clubs:select': ({ filters }) => {
      if (fixture.clubSelectError !== undefined) return { error: fixture.clubSelectError };
      const found = clubs.find(
        (club) => club['id'] === filters['id'] && club['guild_id'] === filters['guild_id'],
      );
      return { data: found === undefined ? [] : [found] };
    },
    'clubs:update': ({ filters, payload }) => {
      if (fixture.clubUpdateError !== undefined) return { error: fixture.clubUpdateError };
      const found = clubs.find(
        (club) =>
          club['id'] === filters['id'] &&
          club['guild_id'] === filters['guild_id'] &&
          (club['archived_at'] ?? null) === (filters['archived_at'] ?? null),
      );
      if (found === undefined) return { data: [] };
      found['archived_at'] = payload['archived_at'];
      found['archived_by'] = payload['archived_by'];
      found['archive_reason'] = payload['archive_reason'];
      return { data: [{ id: found['id'] }] };
    },
    'guild_view_tags:delete': ({ filters }) => {
      for (let index = tags.length - 1; index >= 0; index -= 1) {
        const tag = tags[index]!;
        if (tag['guild_id'] === filters['guild_id'] && tag['club_id'] === filters['club_id']) {
          tags.splice(index, 1);
        }
      }
      return { data: [] };
    },
  };

  class FakeQuery {
    private operation: Operation | null = null;
    private payload: Record<string, unknown> = {};
    private readonly filters: Record<string, unknown> = {};
    private mode: 'array' | 'maybeSingle' = 'array';

    constructor(private readonly table: string) {}

    select(): this {
      if (this.operation === null) this.operation = 'select';
      return this;
    }

    insert(payload: Record<string, unknown>): this {
      this.operation = 'insert';
      this.payload = payload;
      return this;
    }

    update(payload: Record<string, unknown>): this {
      this.operation = 'update';
      this.payload = payload;
      return this;
    }

    delete(): this {
      this.operation = 'delete';
      return this;
    }

    eq(column: string, value: unknown): this {
      this.filters[column] = value;
      return this;
    }

    is(column: string, value: unknown): this {
      this.filters[column] = value;
      return this;
    }

    maybeSingle(): this {
      this.mode = 'maybeSingle';
      return this;
    }

    private execute(): Promise<{ data: unknown; error: unknown }> {
      const operation = this.operation ?? 'select';
      const call: QueryCall = {
        table: this.table,
        operation,
        payload: { ...this.payload },
        filters: { ...this.filters },
      };
      calls.push(call);
      const handler = handlers[`${this.table}:${operation}`];
      if (handler === undefined) throw new Error(`Unexpected query: ${this.table}:${operation}`);
      const result = handler(call);
      const raw = result.data ?? null;
      const data = this.mode === 'maybeSingle' && Array.isArray(raw) ? (raw[0] ?? null) : raw;
      return Promise.resolve({ data, error: result.error ?? null });
    }

    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return this.execute().then(onfulfilled, onrejected);
    }
  }

  return {
    db: { from: (table: string) => new FakeQuery(table) } as unknown as Db,
    calls,
    clubs,
    tags,
  };
}

function actor() {
  return { profileId: PROFILE_ID, discordUserId: DISCORD_ID, globalRole: 'admin' as const };
}

function activeClub(id: string, guildId = GUILD_ID): Row {
  return { id, guild_id: guildId, archived_at: null };
}

function tag(clubId: string, guildId = GUILD_ID): Row {
  return { guild_id: guildId, club_id: clubId };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    clubId: CLUB_ID,
    guildId: GUILD_ID,
    actor: actor(),
    clubTag: '2UG9',
    clubName: 'Alpha',
    now: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.createTrustedClient.mockReset();
  mocks.createTrustedClient.mockImplementation(() => {
    throw new Error('createTrustedClient should not be called in these tests');
  });
  mocks.recordAdminAudit.mockReset();
  mocks.recordAdminAudit.mockResolvedValue(undefined);
});

describe('archiveGuildClub', () => {
  it('archives non-destructively with guild-scoped writes and records an audit', async () => {
    const { db, calls, clubs, tags } = createFakeDb({
      clubs: [activeClub(CLUB_ID), activeClub(OTHER_CLUB_ID)],
      tags: [tag(CLUB_ID), tag(CLUB_ID, OTHER_GUILD_ID), tag(OTHER_CLUB_ID)],
    });

    const result = await archiveGuildClub(input(), { db });

    expect(result).toEqual({ kind: 'archived' });
    expect(calls.some((call) => call.table === 'clubs' && call.operation === 'delete')).toBe(false);
    expect(calls.find((call) => call.table === 'clubs' && call.operation === 'select')).toMatchObject({
      filters: { id: CLUB_ID, guild_id: GUILD_ID },
    });
    expect(calls.find((call) => call.table === 'clubs' && call.operation === 'update')).toMatchObject({
      payload: {
        archived_at: ARCHIVED_AT,
        archived_by: PROFILE_ID,
        archive_reason: 'Archived with /remove-club',
      },
      filters: { id: CLUB_ID, guild_id: GUILD_ID, archived_at: null },
    });
    expect(clubs).toEqual([
      {
        id: CLUB_ID,
        guild_id: GUILD_ID,
        archived_at: ARCHIVED_AT,
        archived_by: PROFILE_ID,
        archive_reason: 'Archived with /remove-club',
      },
      activeClub(OTHER_CLUB_ID),
    ]);
    expect(tags).toEqual([tag(CLUB_ID, OTHER_GUILD_ID), tag(OTHER_CLUB_ID)]);
    expect(calls.some((call) => call.table === 'guild_settings')).toBe(false);
    expect(calls.find((call) => call.table === 'guild_view_tags')).toMatchObject({
      operation: 'delete',
      filters: { guild_id: GUILD_ID, club_id: CLUB_ID },
    });
    expect(mocks.recordAdminAudit).toHaveBeenCalledOnce();
    expect(mocks.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: actor(),
        action: 'club.archived',
        targetType: 'club',
        targetId: CLUB_ID,
        guildId: GUILD_ID,
        details: { clubTag: '2UG9', clubName: 'Alpha', archivedAt: ARCHIVED_AT },
      }),
      { db },
    );
  });

  it('returns not-found for a club in another guild without writing', async () => {
    const { db, calls, clubs } = createFakeDb({ clubs: [activeClub(CLUB_ID, OTHER_GUILD_ID)] });

    await expect(archiveGuildClub(input(), { db })).resolves.toEqual({ kind: 'not-found' });
    expect(calls.filter((call) => call.operation !== 'select')).toEqual([]);
    expect(clubs[0]?.['archived_at']).toBeNull();
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('returns not-found for blank ids without querying', async () => {
    const { db, calls } = createFakeDb({ clubs: [activeClub(CLUB_ID)] });

    await expect(
      archiveGuildClub(input({ guildId: '   ' }), { db }),
    ).resolves.toEqual({ kind: 'not-found' });
    await expect(
      archiveGuildClub(input({ clubId: '' }), { db }),
    ).resolves.toEqual({ kind: 'not-found' });
    expect(calls).toEqual([]);
  });

  it('returns already-archived without deleting view tags', async () => {
    const { db, calls, tags } = createFakeDb({
      clubs: [{ ...activeClub(CLUB_ID), archived_at: '2026-11-19T00:00:00.000Z' }],
      tags: [tag(CLUB_ID)],
    });

    await expect(archiveGuildClub(input(), { db })).resolves.toEqual({ kind: 'already-archived' });
    expect(calls.some((call) => call.table === 'guild_settings')).toBe(false);
    expect(calls.some((call) => call.table === 'guild_view_tags')).toBe(false);
    expect(tags).toEqual([tag(CLUB_ID)]);
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('surfaces read and archive errors', async () => {
    const readFailure = createFakeDb({ clubSelectError: { message: 'read failed' } });
    await expect(archiveGuildClub(input(), { db: readFailure.db })).rejects.toThrow(
      'Read club failed: read failed',
    );

    const updateFailure = createFakeDb({
      clubs: [activeClub(CLUB_ID)],
      clubUpdateError: { message: 'write failed' },
    });
    await expect(archiveGuildClub(input(), { db: updateFailure.db })).rejects.toThrow(
      'Archive club failed: write failed',
    );
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });
});
