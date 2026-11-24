import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR_DISCORD_ID = '111111111111111111';
const TARGET_DISCORD_ID = '222222222222222222';
const CLUB_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  result: { ok: true } as { ok?: boolean; code?: string },
  error: null as { message: string } | null,
}));

vi.mock('@brawlhub/database', () => ({
  createTrustedClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      fake.calls.push({ name, args });
      return Promise.resolve({ data: fake.result, error: fake.error });
    },
  }),
}));

vi.mock('@/lib/api/guards', () => ({
  sameOriginGuard: () => null,
  requireApiGlobalPermission: async () => ({
    session: {
      profile: { id: ACTOR_ID, discord_user_id: ACTOR_DISCORD_ID },
      globalRole: 'owner',
      clubRoles: new Map(),
    },
  }),
  jsonError: (status: number, code: string, message?: string) =>
    NextResponse.json({ error: code, message }, { status }),
}));

vi.mock('@/lib/api/rate-limit', () => ({
  checkRateLimit: () => ({ allowed: true }),
}));

import { POST } from './route';

function post(fields: Record<string, string>): Promise<Response> {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  return POST(
    new NextRequest('http://localhost:3000/api/admin/roles', {
      method: 'POST',
      body: formData,
      headers: { origin: 'http://localhost:3000' },
    }),
  );
}

beforeEach(() => {
  fake.calls = [];
  fake.result = { ok: true };
  fake.error = null;
});

describe('admin roles API', () => {
  it('applies role changes through the atomic RPC', async () => {
    const response = await post({
      action: 'grant',
      discordUserId: TARGET_DISCORD_ID,
      scope: 'club',
      role: 'staff',
      clubId: CLUB_ID,
    });

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location')!).searchParams.get('role')).toBe('success');
    expect(fake.calls).toEqual([
      {
        name: 'apply_manual_role_change',
        args: {
          p_actor_profile_id: ACTOR_ID,
          p_discord_user_id: TARGET_DISCORD_ID,
          p_scope: 'club',
          p_club_id: CLUB_ID,
          p_role: 'staff',
          p_action: 'grant',
        },
      },
    ]);
  });

  it('maps RPC authorization codes to a 403 without mutating directly', async () => {
    fake.result = { ok: false, code: 'forbidden' };
    const response = await post({
      action: 'revoke',
      discordUserId: TARGET_DISCORD_ID,
      scope: 'global',
      role: 'admin',
      clubId: '',
    });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('forbidden');
  });
});
