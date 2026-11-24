import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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
  requireApiClubPermission: async () => ({
    session: {
      profile: { id: ACTOR_ID, discord_user_id: '111111111111111111' },
      globalRole: 'admin',
      clubRoles: new Map([[CLUB_ID, 'owner']]),
    },
  }),
}));

vi.mock('@/lib/api/rate-limit', () => ({
  checkRateLimit: () => ({ allowed: true }),
}));

import { POST } from './route';

function post(fields: Record<string, string>): Promise<Response> {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  return POST(
    new NextRequest(`http://localhost:3000/api/clubs/${CLUB_ID}/staff`, {
      method: 'POST',
      body: formData,
      headers: { origin: 'http://localhost:3000' },
    }),
    { params: Promise.resolve({ clubId: CLUB_ID }) },
  );
}

beforeEach(() => {
  fake.calls = [];
  fake.result = { ok: true };
  fake.error = null;
});

describe('club staff API', () => {
  it('applies staff changes through the atomic RPC', async () => {
    const response = await post({
      action: 'grant',
      discordUserId: TARGET_DISCORD_ID,
      role: 'staff',
    });

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location')!).searchParams.get('staff')).toBe('success');
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

  it('maps a concurrent authorization failure to a 403', async () => {
    fake.result = { ok: false, code: 'forbidden' };
    const response = await post({
      action: 'revoke',
      discordUserId: TARGET_DISCORD_ID,
      role: 'staff',
    });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('forbidden');
  });
});
