import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';
import { provisionIdentity } from './provision';

const DISCORD_ID = '111111111111111111';
const AUTH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLUB_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface RpcCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

const fake = vi.hoisted(() => ({
  state: {
    calls: [] as RpcCall[],
    errors: {} as Record<string, { message: string } | undefined>,
  },
}));

vi.mock('@brawlhub/database', () => ({
  createTrustedClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      fake.state.calls.push({ name, args });
      return Promise.resolve({ data: { ok: true }, error: fake.state.errors[name] ?? null });
    },
  }),
}));

function user(): User {
  return {
    id: AUTH_ID,
    app_metadata: {},
    user_metadata: { provider_id: DISCORD_ID, username: ' Player ' },
    aud: 'authenticated',
    created_at: '2026-11-24T00:00:00.000Z',
  } as User;
}

beforeEach(() => {
  fake.state.calls = [];
  fake.state.errors = {};
});

describe('provisionIdentity', () => {
  it('claims the Discord identity before refreshing role grants', async () => {
    const grants = [
      { scope: 'global' as const, clubId: null, role: 'member' as const },
      { scope: 'club' as const, clubId: CLUB_A, role: 'staff' as const },
    ];

    const identity = await provisionIdentity({ user: user(), grants });

    expect(identity).toEqual({ id: DISCORD_ID, username: 'Player', avatarUrl: null });
    expect(fake.state.calls.map((call) => call.name)).toEqual([
      'claim_bot_identity',
      'refresh_discord_role_grants',
    ]);
    expect(fake.state.calls[0]?.args).toEqual({
      p_auth_user_id: AUTH_ID,
      p_discord_user_id: DISCORD_ID,
      p_username: 'Player',
      p_avatar_url: null,
    });
    expect(fake.state.calls[1]?.args).toEqual({
      p_profile_id: AUTH_ID,
      p_grants: grants,
    });
  });

  it('leaves manual grants to the database reconciliation RPC', async () => {
    await provisionIdentity({
      user: user(),
      grants: [{ scope: 'club', clubId: CLUB_A, role: 'member' }],
    });

    const payload = fake.state.calls[1]?.args['p_grants'] as Array<Record<string, unknown>>;
    expect(payload).toEqual([
      { scope: 'club', clubId: CLUB_A, role: 'member' },
    ]);
    expect(payload.every((grant) => grant['source'] === undefined)).toBe(true);
  });

  it('surfaces identity and grant reconciliation failures', async () => {
    fake.state.errors['claim_bot_identity'] = { message: 'claim down' };
    await expect(provisionIdentity({ user: user(), grants: [] })).rejects.toThrow(
      'Unable to claim Discord identity: claim down',
    );
    expect(fake.state.calls).toHaveLength(1);

    fake.state.errors['claim_bot_identity'] = undefined;
    fake.state.errors['refresh_discord_role_grants'] = { message: 'grants down' };
    await expect(provisionIdentity({ user: user(), grants: [] })).rejects.toThrow(
      'Unable to refresh Discord role grants: grants down',
    );
  });
});
