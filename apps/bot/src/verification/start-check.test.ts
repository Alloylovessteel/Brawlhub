import { beforeEach, describe, expect, it, vi } from 'vitest';

interface QueryResponse {
  readonly data: unknown;
  readonly error: unknown;
}

const mocks = vi.hoisted(() => ({
  getPlayer: vi.fn(),
  pickIcon: vi.fn(),
  handlers: {} as Record<string, (payload: unknown) => QueryResponse>,
}));

vi.mock('@brawlhub/database', () => {
  class FakeQuery {
    private operation: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
    private payload: unknown = undefined;

    constructor(private readonly table: string) {}

    select(): this {
      this.operation = 'select';
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

    eq(): this {
      return this;
    }

    in(): this {
      return this;
    }

    is(): this {
      return this;
    }

    order(): this {
      return this;
    }

    limit(): this {
      return this;
    }

    maybeSingle(): this {
      return this;
    }

    single(): this {
      return this;
    }

    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: QueryResponse) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2) | null,
    ): Promise<TResult1 | TResult2> {
      const handler = mocks.handlers[`${this.table}:${this.operation}`];
      const response: QueryResponse =
        handler === undefined ? { data: null, error: null } : handler(this.payload);
      return Promise.resolve(response).then(onfulfilled, onrejected);
    }
  }

  return {
    createTrustedClient: () => ({
      from: (table: string) => new FakeQuery(table),
    }),
  };
});

vi.mock('@brawlhub/brawl-stars', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brawlhub/brawl-stars')>();
  return {
    ...actual,
    createBrawlStarsClient: () => ({ getPlayer: mocks.getPlayer }),
    getSharedBrawlStarsClient: () => ({ getPlayer: mocks.getPlayer }),
  };
});

vi.mock('./icons.js', () => ({
  pickRandomVerificationIconAsync: mocks.pickIcon,
}));

import { readVerificationChallenge } from '../state/index.js';
import {
  checkVerification,
  clearVerificationChallengesForTests,
  getVerificationChallenge,
  startVerification,
} from './service';

const DISCORD_USER_ID = '111111111111111111';
const TAG = 'YQPQ0Q2CL';
const TARGET_ICON = {
  id: 28000016,
  name: 'Spike',
  imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000016.png',
};

function setDefaultHandlers(): void {
  mocks.handlers = {
    'profiles:select': () => ({ data: { id: 'profile-1' }, error: null }),
    'players:select': () => ({
      data: { id: 'player-1', tag: TAG, name: 'Alpha' },
      error: null,
    }),
    'player_verifications:select': () => ({ data: null, error: null }),
    'player_verifications:insert': () => ({ data: null, error: null }),
  };
}

beforeEach(() => {
  clearVerificationChallengesForTests();
  vi.clearAllMocks();
  setDefaultHandlers();
  mocks.getPlayer.mockResolvedValue({
    name: 'Alpha',
    trophies: 100,
    icon: { id: 28000003 },
  });
  mocks.pickIcon.mockResolvedValue(TARGET_ICON);
});

describe('startVerification active challenge handling', () => {
  it('resumes the same challenge when start is repeated for the same player', async () => {
    const first = await startVerification({
      discordUserId: DISCORD_USER_ID,
      tagInput: `#${TAG}`,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await startVerification({
      discordUserId: DISCORD_USER_ID,
      tagInput: TAG.toLowerCase(),
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.reused).toBe(true);
    expect(second.challenge).toEqual(first.challenge);
    expect(mocks.getPlayer).toHaveBeenCalledTimes(1);
    expect(mocks.pickIcon).toHaveBeenCalledTimes(1);
  });

  it('does not silently replace the challenge when start uses a different tag', async () => {
    const first = await startVerification({
      discordUserId: DISCORD_USER_ID,
      tagInput: `#${TAG}`,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await startVerification({
      discordUserId: DISCORD_USER_ID,
      tagInput: '#2U8G9',
    });

    expect(second).toMatchObject({
      ok: false,
      code: 'active-challenge',
      challenge: { playerTag: TAG, targetIconId: TARGET_ICON.id },
    });
    if (!second.ok && second.code === 'active-challenge') {
      expect(second.message).toContain(`#${TAG}`);
      expect(second.message).not.toContain('#2U8G9');
    }
    expect(mocks.getPlayer).toHaveBeenCalledTimes(1);
    expect(getVerificationChallenge({ discordUserId: DISCORD_USER_ID })?.targetIconId).toBe(
      TARGET_ICON.id,
    );
  });

  it('scopes an active challenge to its guild', async () => {
    const first = await startVerification({
      discordUserId: DISCORD_USER_ID,
      tagInput: `#${TAG}`,
      guildId: 'guild-1',
    });
    expect(first.ok).toBe(true);

    const stored = await readVerificationChallenge({
      guildId: 'guild-1',
      discordUserId: DISCORD_USER_ID,
    });
    expect(stored?.targetTag).toBe(TAG);
    expect(stored?.challengeIconId).toBe(28000003);
    expect(stored?.details.targetIconId).toBe(TARGET_ICON.id);

    expect(await checkVerification({ discordUserId: DISCORD_USER_ID, guildId: 'guild-2' })).toMatchObject({
      ok: false,
      code: 'no-challenge',
    });
    expect(getVerificationChallenge({ discordUserId: DISCORD_USER_ID, guildId: 'guild-2' })).toBeNull();
    expect(getVerificationChallenge({ discordUserId: DISCORD_USER_ID, guildId: 'guild-1' })?.targetIconId)
      .toBe(TARGET_ICON.id);
  });

  it('keeps the required icon long enough for official API propagation', async () => {
    const result = await startVerification({
      discordUserId: DISCORD_USER_ID,
      tagInput: `#${TAG}`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.challenge.expiresAt - result.challenge.createdAt).toBe(30 * 60 * 1000);
  });

  it('still verifies when a resumed challenge reaches the required icon', async () => {
    const first = await startVerification({
      discordUserId: DISCORD_USER_ID,
      tagInput: `#${TAG}`,
    });
    expect(first.ok).toBe(true);
    await startVerification({ discordUserId: DISCORD_USER_ID, tagInput: `#${TAG}` });
    mocks.getPlayer.mockResolvedValue({
      name: 'Alpha',
      trophies: 100,
      icon: { id: TARGET_ICON.id },
    });

    const result = await checkVerification({ discordUserId: DISCORD_USER_ID });

    expect(result).toMatchObject({
      ok: true,
      status: 'verified',
      playerTag: TAG,
      targetIconId: TARGET_ICON.id,
      currentIconId: TARGET_ICON.id,
    });
    expect(getVerificationChallenge({ discordUserId: DISCORD_USER_ID })).toBeNull();
  });
});
