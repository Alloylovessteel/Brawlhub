import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const GUILD_ID = '123456789012345678';
const OTHER_GUILD_ID = '876543210987654321';
const DISCORD_ROLE_ID = '999999999999999999';
const CUSTOM_ROLE_ID = '11111111-1111-4111-8111-111111111111';

type Call = {
  table: string;
  operation: string;
  payload: any;
  filters: Record<string, unknown>;
};

const fake = vi.hoisted(() => ({
  handlers: {} as Record<string, (call: Call) => { data?: unknown; error?: unknown }>,
  calls: [] as Call[],
}));

const sessionMock = vi.hoisted(() => ({ session: null as any }));

vi.mock('@brawlhub/database', () => {
  class FakeQuery {
    private operation = 'select';
    private payload: any = undefined;
    private filters: Record<string, unknown> = {};
    private mode: 'array' | 'maybeSingle' = 'array';

    constructor(private readonly table: string) {}

    select(): this {
      return this;
    }

    insert(payload: unknown): this {
      this.operation = 'insert';
      this.payload = payload;
      return this;
    }

    upsert(payload: unknown): this {
      this.operation = 'upsert';
      this.payload = payload;
      return this;
    }

    update(payload: unknown): this {
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

    maybeSingle(): this {
      this.mode = 'maybeSingle';
      return this;
    }

    then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown): Promise<unknown> {
      return this.execute().then(resolve, reject);
    }

    async execute(): Promise<{ data: unknown; error: unknown }> {
      const call: Call = {
        table: this.table,
        operation: this.operation,
        payload: this.payload,
        filters: { ...this.filters },
      };
      fake.calls.push(call);
      const handler = fake.handlers[`${this.table}:${this.operation}`] ?? fake.handlers[this.table];
      const result = handler === undefined ? {} : handler(call);
      return {
        data: result.data === undefined ? (this.mode === 'maybeSingle' ? null : []) : result.data,
        error: result.error ?? null,
      };
    }
  }

  return { createTrustedClient: () => ({ from: (table: string) => new FakeQuery(table) }) };
});

vi.mock('@/lib/auth/session', () => ({
  getAppSession: async () => sessionMock.session,
  hasGlobalPermission: (session: any) => session?.globalRole === 'admin',
  hasClubPermission: () => false,
  isGlobalAdmin: (session: any) => session?.globalRole === 'admin',
}));

import { POST } from './route';

function post(fields: Record<string, string>): Promise<Response> {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  const request = new NextRequest('http://localhost:3000/api/admin/custom-roles', {
    method: 'POST',
    body: formData,
    headers: { origin: 'http://localhost:3000' },
  });
  return POST(request);
}

function statusOf(response: Response): string | null {
  const location = response.headers.get('location');
  return location === null ? null : new URL(location).searchParams.get('customRoles');
}

beforeEach(() => {
  fake.handlers = {};
  fake.calls = [];
  sessionMock.session = {
    profile: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', discord_user_id: '111111111111111111' },
    globalRole: 'admin',
    clubRoles: new Map(),
  };
});

describe('custom roles API', () => {
  it('rejects members without staff:manage', async () => {
    sessionMock.session = { ...sessionMock.session, globalRole: 'member' };
    const response = await post({
      action: 'create',
      guildId: GUILD_ID,
      name: 'Event lead',
      permissions: 'clubs:read',
    });
    expect(response.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects mapping a Discord role to a custom role from another guild', async () => {
    fake.handlers['guild_custom_roles:select'] = (call) => ({
      data:
        call.filters.guild_id === GUILD_ID
          ? null
          : [
              {
                id: CUSTOM_ROLE_ID,
                guild_id: OTHER_GUILD_ID,
                name: 'Other guild role',
                permissions: ['clubs:read'],
              },
            ],
    });

    const response = await post({
      action: 'map',
      guildId: GUILD_ID,
      discordRoleId: DISCORD_ROLE_ID,
      target: `custom:${CUSTOM_ROLE_ID}`,
    });

    expect(response.status).toBe(303);
    expect(statusOf(response)).toBe('error');
    expect(
      fake.calls.some((call) => call.table === 'guild_role_mappings' && call.operation === 'upsert'),
    ).toBe(false);
  });

  it('maps a Discord role to a custom role in the same guild and audits it', async () => {
    fake.handlers['guild_custom_roles:select'] = () => ({
      data: [{ id: CUSTOM_ROLE_ID, guild_id: GUILD_ID, name: 'Event lead', permissions: ['sync:run'] }],
    });

    const response = await post({
      action: 'map',
      guildId: GUILD_ID,
      discordRoleId: DISCORD_ROLE_ID,
      target: `custom:${CUSTOM_ROLE_ID}`,
    });

    expect(response.status).toBe(303);
    expect(statusOf(response)).toBe('success');
    const upsert = fake.calls.find(
      (call) => call.table === 'guild_role_mappings' && call.operation === 'upsert',
    );
    expect(upsert?.payload).toMatchObject({
      guild_id: GUILD_ID,
      discord_role_id: DISCORD_ROLE_ID,
      brawlhub_role: null,
      custom_role_id: CUSTOM_ROLE_ID,
    });
    expect(
      fake.calls.some(
        (call) =>
          call.table === 'audit_logs' &&
          call.payload?.action === 'guild.custom_role_mapping.updated' &&
          call.payload?.guild_id === GUILD_ID,
      ),
    ).toBe(true);
  });

  it('requires at least one valid permission checkbox', async () => {
    const response = await post({
      action: 'create',
      guildId: GUILD_ID,
      name: 'Event lead',
      permissions: 'not:a:permission',
    });
    expect(response.status).toBe(303);
    expect(statusOf(response)).toBe('error');
    expect(fake.calls.some((call) => call.table === 'guild_custom_roles')).toBe(false);
  });
});
