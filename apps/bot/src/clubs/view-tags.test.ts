import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OVERVIEW_MAX_CLUBS } from './overview/embed';

const GUILD_ID = '123456789012345678';
const OTHER_GUILD_ID = '876543210987654321';
const CLUB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_CLUB_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DISCORD_ID = '111111111111111111';

const mocks = vi.hoisted(() => ({
  createTrustedClient: vi.fn(),
  recordAdminAudit: vi.fn(),
  loadClubSummaries: vi.fn(),
}));

vi.mock('@brawlhub/database', () => ({ createTrustedClient: mocks.createTrustedClient }));
vi.mock('../admin/service', () => ({ recordAdminAudit: mocks.recordAdminAudit }));
vi.mock('./service', () => ({ loadClubSummaries: mocks.loadClubSummaries }));

import { addViewTag, loadViewTagSummaries, readViewTags, removeViewTag } from './view-tags';

type Db = NonNullable<NonNullable<Parameters<typeof addViewTag>[1]>['db']>;
type Row = Record<string, unknown>;
type Operation = 'select' | 'insert' | 'delete' | 'update';

interface QueryCall {
  readonly table: string;
  readonly operation: Operation;
  readonly payload: Record<string, unknown>;
  readonly filters: Record<string, unknown>;
  readonly orders: readonly string[];
  readonly mode: 'array' | 'maybeSingle';
}

type Handler = (call: QueryCall) => { data?: unknown; error?: unknown };

interface Fixture {
  readonly clubs?: Row[];
  readonly tags?: Row[];
  readonly viewTagSelectError?: { readonly message: string };
  readonly clubSelectError?: { readonly message: string };
  readonly insertError?: { readonly code?: string; readonly message: string };
  readonly removeError?: { readonly message: string };
}

function createFakeDb(fixture: Fixture = {}): { db: Db; calls: QueryCall[]; tags: Row[] } {
  const calls: QueryCall[] = [];
  const clubs = fixture.clubs === undefined ? [] : [...fixture.clubs];
  const tags = fixture.tags === undefined ? [] : [...fixture.tags];

  const handlers: Record<string, Handler> = {
    'guild_view_tags:select': ({ filters }) => {
      if (fixture.viewTagSelectError !== undefined) return { error: fixture.viewTagSelectError };
      return { data: tags.filter((tag) => tag['guild_id'] === filters['guild_id']) };
    },
    'clubs:select': ({ filters }) => {
      if (fixture.clubSelectError !== undefined) return { error: fixture.clubSelectError };
      const found = clubs.find(
        (club) =>
          club['id'] === filters['id'] &&
          club['guild_id'] === filters['guild_id'] &&
          (club['archived_at'] ?? null) === (filters['archived_at'] ?? null),
      );
      return { data: found === undefined ? [] : [found] };
    },
    'guild_view_tags:insert': ({ payload }) => {
      if (fixture.insertError !== undefined) return { error: fixture.insertError };
      tags.push({
        guild_id: payload['guild_id'],
        club_id: payload['club_id'],
        added_by: payload['added_by'],
        added_at: '2026-11-20T00:00:00.000Z',
      });
      return { data: [] };
    },
    'guild_view_tags:delete': ({ filters }) => {
      if (fixture.removeError !== undefined) return { error: fixture.removeError };
      const removed: Row[] = [];
      for (let index = tags.length - 1; index >= 0; index -= 1) {
        const tag = tags[index]!;
        if (tag['guild_id'] === filters['guild_id'] && tag['club_id'] === filters['club_id']) {
          removed.push(...tags.splice(index, 1));
        }
      }
      return { data: removed };
    },
  };

  class FakeQuery {
    private operation: Operation | null = null;
    private payload: Record<string, unknown> = {};
    private readonly filters: Record<string, unknown> = {};
    private readonly orders: string[] = [];
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

    order(column: string): this {
      this.orders.push(column);
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
        orders: [...this.orders],
        mode: this.mode,
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
  return {
    guild_id: guildId,
    club_id: clubId,
    added_by: PROFILE_ID,
    added_at: '2026-11-20T00:00:00.000Z',
  };
}

function summary(id: string): any {
  return { club: { id } };
}

beforeEach(() => {
  mocks.createTrustedClient.mockReset();
  mocks.createTrustedClient.mockImplementation(() => {
    throw new Error('createTrustedClient should not be called in these tests');
  });
  mocks.recordAdminAudit.mockReset();
  mocks.recordAdminAudit.mockResolvedValue(undefined);
  mocks.loadClubSummaries.mockReset();
  mocks.loadClubSummaries.mockResolvedValue([]);
});

describe('readViewTags', () => {
  it('reads only the requested guild and preserves stored order', async () => {
    const { db, calls } = createFakeDb({
      tags: [
        tag(CLUB_ID),
        tag(OTHER_CLUB_ID, OTHER_GUILD_ID),
        { ...tag(OTHER_CLUB_ID), added_by: null, added_at: null },
      ],
    });

    const result = await readViewTags(GUILD_ID, { db });

    expect(result.map((entry) => entry.clubId)).toEqual([CLUB_ID, OTHER_CLUB_ID]);
    expect(result[0]).toMatchObject({ guildId: GUILD_ID, clubId: CLUB_ID, addedBy: PROFILE_ID });
    expect(result[1]).toMatchObject({ addedBy: null, addedAt: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      table: 'guild_view_tags',
      operation: 'select',
      filters: { guild_id: GUILD_ID },
      orders: ['added_at'],
    });
  });

  it('returns an empty list for blank guild ids without querying', async () => {
    const { db, calls } = createFakeDb({ tags: [tag(CLUB_ID)] });

    await expect(readViewTags('   ', { db })).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it('ignores malformed rows and surfaces read errors', async () => {
    const { db } = createFakeDb({
      tags: [{ guild_id: GUILD_ID, club_id: '' }, { guild_id: GUILD_ID }, tag(CLUB_ID)],
    });
    await expect(readViewTags(GUILD_ID, { db })).resolves.toHaveLength(1);

    const failing = createFakeDb({ viewTagSelectError: { message: 'db offline' } });
    await expect(readViewTags(GUILD_ID, { db: failing.db })).rejects.toThrow(
      'Read overview clubs failed: db offline',
    );
  });
});

describe('addViewTag', () => {
  it('adds an active club in the same guild and records one audit entry', async () => {
    const { db, calls, tags } = createFakeDb({ clubs: [activeClub(CLUB_ID)] });

    const result = await addViewTag({ guildId: GUILD_ID, clubId: CLUB_ID, actor: actor() }, { db });

    expect(result).toEqual({ kind: 'added', total: 1 });
    expect(calls.find((call) => call.operation === 'insert')).toMatchObject({
      table: 'guild_view_tags',
      payload: { guild_id: GUILD_ID, club_id: CLUB_ID, added_by: PROFILE_ID },
    });
    expect(tags).toHaveLength(1);
    expect(mocks.recordAdminAudit).toHaveBeenCalledOnce();
    expect(mocks.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: actor(),
        action: 'club_view_tag.added',
        targetType: 'club',
        targetId: CLUB_ID,
        guildId: GUILD_ID,
        details: { guildId: GUILD_ID, clubId: CLUB_ID },
      }),
      { db },
    );
  });

  it('rejects blank guild and club ids without touching the database', async () => {
    const { db, calls } = createFakeDb({ clubs: [activeClub(CLUB_ID)] });

    await expect(
      addViewTag({ guildId: '  ', clubId: CLUB_ID, actor: actor() }, { db }),
    ).resolves.toEqual({ kind: 'not-found' });
    await expect(
      addViewTag({ guildId: GUILD_ID, clubId: '   ', actor: actor() }, { db }),
    ).resolves.toEqual({ kind: 'not-found' });
    expect(calls).toEqual([]);
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('rejects clubs registered in another guild', async () => {
    const { db, calls } = createFakeDb({ clubs: [activeClub(CLUB_ID, OTHER_GUILD_ID)] });

    await expect(
      addViewTag({ guildId: GUILD_ID, clubId: CLUB_ID, actor: actor() }, { db }),
    ).resolves.toEqual({ kind: 'not-found' });
    expect(calls.some((call) => call.operation === 'insert')).toBe(false);
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('rejects archived clubs', async () => {
    const { db } = createFakeDb({
      clubs: [{ ...activeClub(CLUB_ID), archived_at: '2026-11-19T00:00:00.000Z' }],
    });

    await expect(
      addViewTag({ guildId: GUILD_ID, clubId: CLUB_ID, actor: actor() }, { db }),
    ).resolves.toEqual({ kind: 'not-found' });
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('reports an existing tag for the same guild without inserting or auditing', async () => {
    const { db, calls } = createFakeDb({
      clubs: [activeClub(CLUB_ID)],
      tags: [tag(CLUB_ID)],
    });

    await expect(
      addViewTag({ guildId: GUILD_ID, clubId: CLUB_ID, actor: actor() }, { db }),
    ).resolves.toEqual({ kind: 'already-present' });
    expect(calls.some((call) => call.operation === 'insert')).toBe(false);
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('ignores the same club tagged in a different guild', async () => {
    const { db, tags } = createFakeDb({
      clubs: [activeClub(CLUB_ID)],
      tags: [tag(CLUB_ID, OTHER_GUILD_ID)],
    });

    await expect(
      addViewTag({ guildId: GUILD_ID, clubId: CLUB_ID, actor: actor() }, { db }),
    ).resolves.toEqual({ kind: 'added', total: 1 });
    expect(tags.map((entry) => entry['guild_id'])).toEqual([OTHER_GUILD_ID, GUILD_ID]);
  });

  it('enforces the overview maximum before inserting', async () => {
    const fullTags = Array.from({ length: OVERVIEW_MAX_CLUBS }, (_, index) =>
      tag(`club-${index}`),
    );
    const { db, calls } = createFakeDb({ clubs: [activeClub(CLUB_ID)], tags: fullTags });

    await expect(
      addViewTag({ guildId: GUILD_ID, clubId: CLUB_ID, actor: actor() }, { db }),
    ).resolves.toEqual({ kind: 'limit-reached', limit: OVERVIEW_MAX_CLUBS });
    expect(calls.some((call) => call.operation === 'insert')).toBe(false);
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('treats a unique constraint failure as already-present without auditing', async () => {
    const { db } = createFakeDb({
      clubs: [activeClub(CLUB_ID)],
      insertError: { code: '23505', message: 'duplicate key' },
    });

    await expect(
      addViewTag({ guildId: GUILD_ID, clubId: CLUB_ID, actor: actor() }, { db }),
    ).resolves.toEqual({ kind: 'already-present' });
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('surfaces other database errors', async () => {
    const { db } = createFakeDb({
      clubs: [activeClub(CLUB_ID)],
      insertError: { message: 'permission denied' },
    });

    await expect(
      addViewTag({ guildId: GUILD_ID, clubId: CLUB_ID, actor: actor() }, { db }),
    ).rejects.toThrow('Add overview club failed: permission denied');
  });
});

describe('removeViewTag', () => {
  it('deletes only the guild-scoped row and audits the removal', async () => {
    const { db, calls, tags } = createFakeDb({
      tags: [tag(CLUB_ID), tag(CLUB_ID, OTHER_GUILD_ID), tag(OTHER_CLUB_ID)],
    });

    const result = await removeViewTag({ guildId: GUILD_ID, clubId: CLUB_ID, actor: actor() }, { db });

    expect(result).toEqual({ kind: 'removed' });
    expect(calls.find((call) => call.operation === 'delete')).toMatchObject({
      table: 'guild_view_tags',
      filters: { guild_id: GUILD_ID, club_id: CLUB_ID },
    });
    expect(tags.map((entry) => [entry['guild_id'], entry['club_id']])).toEqual([
      [OTHER_GUILD_ID, CLUB_ID],
      [GUILD_ID, OTHER_CLUB_ID],
    ]);
    expect(mocks.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'club_view_tag.removed', targetId: CLUB_ID, guildId: GUILD_ID }),
      { db },
    );
  });

  it('does not audit when nothing was deleted', async () => {
    const { db } = createFakeDb({ tags: [tag(CLUB_ID, OTHER_GUILD_ID)] });

    await expect(
      removeViewTag({ guildId: GUILD_ID, clubId: CLUB_ID, actor: actor() }, { db }),
    ).resolves.toEqual({ kind: 'not-found' });
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('rejects blank ids and surfaces delete errors', async () => {
    const { db, calls } = createFakeDb();

    await expect(
      removeViewTag({ guildId: '', clubId: CLUB_ID, actor: actor() }, { db }),
    ).resolves.toEqual({ kind: 'not-found' });
    await expect(
      removeViewTag({ guildId: GUILD_ID, clubId: ' ', actor: actor() }, { db }),
    ).resolves.toEqual({ kind: 'not-found' });
    expect(calls).toEqual([]);

    const failing = createFakeDb({ removeError: { message: 'delete blocked' } });
    await expect(
      removeViewTag({ guildId: GUILD_ID, clubId: CLUB_ID, actor: actor() }, { db: failing.db }),
    ).rejects.toThrow('Remove overview club failed: delete blocked');
  });
});

describe('loadViewTagSummaries', () => {
  it('returns every active club summary when the guild has no tags', async () => {
    const { db } = createFakeDb();
    const summaries = [summary(CLUB_ID), summary(OTHER_CLUB_ID)];
    mocks.loadClubSummaries.mockResolvedValue(summaries);

    await expect(loadViewTagSummaries(GUILD_ID, { db })).resolves.toEqual(summaries);
    expect(mocks.loadClubSummaries).toHaveBeenCalledWith(GUILD_ID, db);
  });

  it('filters summaries to tagged club ids within the guild', async () => {
    const { db } = createFakeDb({
      tags: [tag(CLUB_ID), tag('missing-club'), tag(OTHER_CLUB_ID, OTHER_GUILD_ID)],
    });
    const summaries = [summary(CLUB_ID), summary(OTHER_CLUB_ID)];
    mocks.loadClubSummaries.mockResolvedValue(summaries);

    await expect(loadViewTagSummaries(GUILD_ID, { db })).resolves.toEqual([summary(CLUB_ID)]);
  });
});
