import type { SupabaseClient } from '@supabase/supabase-js';
import type { REST } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { AdminActor } from '../admin/types.js';
import {
  buildInactivityEmbed,
  buildInactivitySettingsEmbed,
  loadInactivityData,
  normalizeInactivityDays,
  postInactivityReports,
  readInactivitySettings,
  updateInactivitySettings,
} from './inactivity.js';

const GUILD_ID = '123456789012345678';
const OTHER_GUILD_ID = '223456789012345678';
const CHANNEL_ID = '999999999999999999';
const ACTOR: AdminActor = {
  profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  discordUserId: '111111111111111111',
  globalRole: 'admin',
};
const NOW = new Date('2026-11-21T00:00:00.000Z');

type Filter = readonly [operator: string, column: string, value: unknown];
type Handler = (
  payload?: Record<string, unknown>,
  options?: Record<string, unknown>,
  filters?: readonly Filter[],
) => { data: unknown; error: unknown };

interface QueryCall {
  readonly table: string;
  readonly operation: string;
  readonly payload: Record<string, unknown> | undefined;
  readonly options: Record<string, unknown> | undefined;
  readonly filters: Filter[];
}

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
        filters: [...this.filters],
        payload: this.payload,
        options: this.options,
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

    not(column: string, operator: string, value: unknown): this {
      this.filters.push(['not', `${column}.${operator}`, value]);
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
      const handler = handlers[`${this.table}:${this.operation}`] ?? (() => ({ data: null, error: null }));
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

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

describe('normalizeInactivityDays', () => {
  it('accepts only whole days between 1 and 365', () => {
    expect(normalizeInactivityDays(4)).toBe(4);
    expect(normalizeInactivityDays('7')).toBeNull();
    expect(normalizeInactivityDays(0)).toBeNull();
    expect(normalizeInactivityDays(366)).toBeNull();
    expect(normalizeInactivityDays(null)).toBeNull();
  });
});

describe('loadInactivityData', () => {
  it('uses only this guild’s stored clubs and flags members past the threshold', async () => {
    const { db, calls } = fakeDb({
      'clubs:select': () => ({
        data: [{ id: 'club-1', tag: 'ABC', name: 'Alpha' }],
        error: null,
      }),
      'club_memberships:select': () => ({
        data: [
          { club_id: 'club-1', player_id: 'player-1', role: 'senior' },
          { club_id: 'club-1', player_id: 'player-2', role: 'member' },
          { club_id: 'club-1', player_id: 'player-3', role: 'vicePresident' },
          { club_id: 'club-1', player_id: 'player-4', role: 'member' },
          { club_id: 'club-1', player_id: 'player-5', role: 'member' },
        ],
        error: null,
      }),
      'players:select': () => ({
        data: [
          { id: 'player-1', tag: 'P1', name: 'Recent', last_battle_at: daysAgo(2) },
          { id: 'player-2', tag: 'P2', name: 'Idle', last_battle_at: daysAgo(10) },
          { id: 'player-3', tag: 'P3', name: 'Unknown', last_battle_at: null },
          { id: 'player-4', tag: 'P4', name: 'Invalid', last_battle_at: 'not-a-date' },
          { id: 'player-5', tag: 'P5', name: 'Future', last_battle_at: daysAgo(-2) },
        ],
        error: null,
      }),
    });

    const result = await loadInactivityData(GUILD_ID, 7, NOW, db);

    expect(calls).toContainEqual({
      table: 'clubs',
      operation: 'select',
      filters: [
        ['eq', 'guild_id', GUILD_ID],
        ['is', 'archived_at', null],
      ],
      payload: undefined,
      options: undefined,
    });
    expect(calls).toContainEqual(
      expect.objectContaining({
        table: 'club_memberships',
        operation: 'select',
        filters: [
          ['in', 'club_id', ['club-1']],
          ['is', 'valid_to', null],
        ],
      }),
    );
    expect(result.totalMembers).toBe(5);
    expect(result.inactive.map((member) => member.playerTag)).toEqual(['P2']);
    expect(result.inactive[0]?.daysInactive).toBe(10);
    expect(result.clubs[0]).toMatchObject({ tag: 'ABC', members: 5, inactive: 1 });
  });

  it('returns an empty report for a guild with no registered clubs', async () => {
    const { db } = fakeDb({ 'clubs:select': () => ({ data: [], error: null }) });

    await expect(loadInactivityData(GUILD_ID, 4, NOW, db)).resolves.toMatchObject({
      guildId: GUILD_ID,
      clubs: [],
      inactive: [],
      totalMembers: 0,
    });
  });
});

describe('inactivity embeds', () => {
  it('renders the custom threshold without mentioning Discord presence as a data source', () => {
    const embed = buildInactivityEmbed({
      guildId: GUILD_ID,
      thresholdDays: 4,
      generatedAt: NOW.toISOString(),
      clubs: [{ tag: 'ABC', name: 'Alpha', members: 2, inactive: 1 }],
      inactive: [
        {
          clubTag: 'ABC',
          clubName: 'Alpha',
          playerTag: 'P2',
          playerName: 'Idle',
          role: 'member',
          daysInactive: 9,
        },
      ],
      totalMembers: 2,
    }).toJSON();

    expect(JSON.stringify(embed)).toContain('4+ day(s)');
    expect(JSON.stringify(embed)).toContain('#P2');
    expect(JSON.stringify(embed)).toContain('Stored battle activity, not Discord presence');
    expect(JSON.stringify(embed).length).toBeLessThan(6000);
  });

  it('shows disabled settings and the overview fallback', () => {
    const embed = buildInactivitySettingsEmbed(GUILD_ID, { days: null, channelId: null }).toJSON();
    const json = JSON.stringify(embed);
    expect(json).toContain('Disabled');
    expect(json).toContain('Overview channel fallback');
    expect(json).toContain('No immediate or on-demand report posts');
  });
});

describe('inactivity settings', () => {
  it('reads the guild override or falls back to the overview channel', async () => {
    const { db } = fakeDb({
      'guild_settings:select': () => ({
        data: {
          report_inactivity_days: 4,
          report_inactivity_channel_id: null,
          overview_channel_id: CHANNEL_ID,
        },
        error: null,
      }),
    });

    await expect(readInactivitySettings(GUILD_ID, db)).resolves.toEqual({
      days: 4,
      channelId: CHANNEL_ID,
    });
  });

  it('upserts only this guild’s settings and writes a guild-scoped audit', async () => {
    const { db, calls } = fakeDb({
      'guild_settings:upsert': () => ({ data: null, error: null }),
      'guild_settings:select': () => ({
        data: {
          report_inactivity_days: 4,
          report_inactivity_channel_id: CHANNEL_ID,
          overview_channel_id: null,
        },
        error: null,
      }),
      'audit_logs:insert': () => ({ data: null, error: null }),
    });

    const settings = await updateInactivitySettings(
      { guildId: GUILD_ID, days: 4, channelId: CHANNEL_ID, actor: ACTOR },
      db,
    );

    expect(settings).toEqual({ days: 4, channelId: CHANNEL_ID });
    expect(calls).toContainEqual(
      expect.objectContaining({
        table: 'guild_settings',
        operation: 'upsert',
        payload: {
          guild_id: GUILD_ID,
          report_inactivity_days: 4,
          report_inactivity_channel_id: CHANNEL_ID,
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
          action: 'guild.inactivity_report.updated',
          details: expect.objectContaining({ days: 4, channelId: CHANNEL_ID }),
        }),
      }),
    );
  });

  it('rejects invalid thresholds and channel IDs before writing', async () => {
    const { db, calls } = fakeDb({});

    await expect(
      updateInactivitySettings(
        { guildId: GUILD_ID, days: 0, channelId: null, actor: ACTOR },
        db,
      ),
    ).rejects.toThrow('between 1 and 365');
    await expect(
      updateInactivitySettings(
        { guildId: GUILD_ID, days: 4, channelId: 'not-a-snowflake', actor: ACTOR },
        db,
      ),
    ).rejects.toThrow('Discord channel ID');
    expect(calls).toHaveLength(0);
  });
});

describe('postInactivityReports', () => {
  it('posts once per guild/day and skips disabled guilds', async () => {
    const { db, calls } = fakeDb({
      'guild_settings:select': () => ({
        data: [
          {
            guild_id: GUILD_ID,
            report_inactivity_days: 4,
            report_inactivity_channel_id: CHANNEL_ID,
            overview_channel_id: null,
          },
          {
            guild_id: OTHER_GUILD_ID,
            report_inactivity_days: null,
            report_inactivity_channel_id: null,
            overview_channel_id: CHANNEL_ID,
          },
        ],
        error: null,
      }),
      'clubs:select': () => ({
        data: [{ id: 'club-1', tag: 'ABC', name: 'Alpha' }],
        error: null,
      }),
      'club_memberships:select': () => ({
        data: [{ club_id: 'club-1', player_id: 'player-1', role: 'member' }],
        error: null,
      }),
      'players:select': () => ({
        data: [{ id: 'player-1', tag: 'P1', name: 'Idle', last_battle_at: daysAgo(9) }],
        error: null,
      }),
      'guild_inactivity_report_posts:select': () => ({ data: null, error: null }),
      'guild_inactivity_report_posts:upsert': () => ({ data: null, error: null }),
    });
    const post = vi.fn(async (_route: string, _options?: unknown) => ({ id: 'message-1' }));
    const rest = { post, patch: vi.fn() } as unknown as REST;

    await expect(postInactivityReports(NOW, rest, undefined, db)).resolves.toBe(1);

    expect(post).toHaveBeenCalledOnce();
    expect(String(post.mock.calls[0]?.[0])).toContain(CHANNEL_ID);
    expect(calls).toContainEqual(
      expect.objectContaining({
        table: 'guild_inactivity_report_posts',
        operation: 'upsert',
        payload: {
          guild_id: GUILD_ID,
          period_key: '2026-11-21',
          channel_id: CHANNEL_ID,
          message_id: 'message-1',
        },
      }),
    );
    expect(calls.filter((call) => call.table === 'clubs')).toHaveLength(1);
    expect(calls.find((call) => call.table === 'clubs')?.filters).toContainEqual([
      'eq',
      'guild_id',
      GUILD_ID,
    ]);
  });
});
