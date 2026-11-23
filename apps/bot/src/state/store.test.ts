import { beforeEach, describe, expect, it } from 'vitest';
import {
  acquireRuntimeLease,
  cancelVerificationChallenge,
  ChallengeConflictError,
  clearStateCachesForTests,
  consumeVerificationChallenge,
  createPersistentSession,
  createVerificationChallenge,
  hasPersistentReplay,
  readRuntimeLease,
  readVerificationChallenge,
  recordPersistentReplay,
  releaseRuntimeLease,
  renewRuntimeLease,
  takePersistentSession,
  type VerificationChallengeRecord,
} from './index.js';

const SESSION_KEY = {
  guildId: 'guild-1',
  command: 'test-command',
  actorDiscordUserId: 'actor-1',
  nonce: 'nonce-1',
};

function challenge(tag: string): VerificationChallengeRecord {
  const now = Date.now();
  return {
    guildId: 'guild-1',
    discordUserId: 'actor-1',
    targetPlayerId: 'player-1',
    targetTag: tag,
    challengeIconId: 28000003,
    status: 'active',
    expiresAt: now + 30 * 60 * 1000,
    createdAt: now,
    updatedAt: now,
    details: {
      profileId: 'profile-1',
      playerName: 'Alpha',
      startingIconId: 28000003,
      targetIconId: 28000016,
      targetIconName: 'Spike',
      targetIconUrl: 'https://example.test/spike.png',
    },
  };
}

beforeEach(() => {
  clearStateCachesForTests();
});

describe('persistent interaction sessions (memory fallback)', () => {
  it('takes a single-use session atomically', async () => {
    await createPersistentSession({
      ...SESSION_KEY,
      kind: 'single-use',
      payload: { value: 'payload' },
      expiresAt: Date.now() + 60_000,
    });

    const first = await takePersistentSession(SESSION_KEY);
    expect(first.kind).toBe('ok');
    if (first.kind === 'ok') expect(first.session.payload).toEqual({ value: 'payload' });
    expect(await takePersistentSession(SESSION_KEY)).toEqual({ kind: 'missing' });
  });

  it('does not let a wrong actor consume a session', async () => {
    await createPersistentSession({
      ...SESSION_KEY,
      kind: 'single-use',
      payload: {},
      expiresAt: Date.now() + 60_000,
    });

    expect(await takePersistentSession({ ...SESSION_KEY, actorDiscordUserId: 'actor-2' })).toEqual({
      kind: 'wrong_actor',
    });

    expect((await takePersistentSession(SESSION_KEY)).kind).toBe('ok');
  });

  it('reports expired sessions', async () => {
    await createPersistentSession({
      ...SESSION_KEY,
      kind: 'single-use',
      payload: {},
      expiresAt: Date.now() - 1,
    });

    expect(await takePersistentSession(SESSION_KEY)).toEqual({ kind: 'expired' });
  });
});

describe('persistent replay markers (memory fallback)', () => {
  it('records a guild/actor/nonce/action replay once', async () => {
    const replay = { ...SESSION_KEY, actionKey: 'section:summary', expiresAt: Date.now() + 5000 };
    expect(await hasPersistentReplay(replay)).toBe(false);
    await recordPersistentReplay(replay);
    expect(await hasPersistentReplay(replay)).toBe(true);
    expect(await hasPersistentReplay({ ...replay, actorDiscordUserId: 'actor-2' })).toBe(false);
  });
});

describe('persistent verification challenges (memory fallback)', () => {
  it('reads and consumes a challenge keyed by guild, user and tag', async () => {
    await createVerificationChallenge(challenge('YQPQ0Q2CL'));

    const active = await readVerificationChallenge({ guildId: 'guild-1', discordUserId: 'actor-1' });
    expect(active?.targetTag).toBe('YQPQ0Q2CL');
    expect(active?.details.targetIconId).toBe(28000016);

    expect(
      await readVerificationChallenge({ guildId: 'guild-2', discordUserId: 'actor-1' }),
    ).toBeNull();

    expect(
      await consumeVerificationChallenge({
        guildId: 'guild-1',
        discordUserId: 'actor-1',
        targetTag: 'YQPQ0Q2CL',
      }),
    ).toBe(true);
    expect(await readVerificationChallenge({ guildId: 'guild-1', discordUserId: 'actor-1' })).toBeNull();
  });

  it('replaces challenge details when the same tag is verified again after cancellation', async () => {
    await createVerificationChallenge(challenge('YQPQ0Q2CL'));
    expect(
      await cancelVerificationChallenge({
        guildId: 'guild-1',
        discordUserId: 'actor-1',
        targetTag: 'YQPQ0Q2CL',
      }),
    ).toBe(true);

    const restarted = challenge('YQPQ0Q2CL');
    await createVerificationChallenge({
      ...restarted,
      details: { ...restarted.details, targetIconId: 28000099, targetIconName: 'New Icon' },
    });

    const active = await readVerificationChallenge({
      guildId: 'guild-1',
      discordUserId: 'actor-1',
      targetTag: 'YQPQ0Q2CL',
    });
    expect(active?.details.targetIconId).toBe(28000099);
    expect(active?.details.targetIconName).toBe('New Icon');
  });

  it('clears challenge details on terminal transitions', async () => {
    await createVerificationChallenge(challenge('YQPQ0Q2CL'));
    expect(
      await consumeVerificationChallenge({
        guildId: 'guild-1',
        discordUserId: 'actor-1',
        targetTag: 'YQPQ0Q2CL',
      }),
    ).toBe(true);

    const restarted = challenge('YQPQ0Q2CL');
    await createVerificationChallenge({
      ...restarted,
      details: { ...restarted.details, targetIconId: 123456 },
    });
    const active = await readVerificationChallenge({ guildId: 'guild-1', discordUserId: 'actor-1' });
    expect(active?.details.targetIconId).toBe(123456);
  });

  it('allows only one active challenge per guild and Discord user', async () => {
    await createVerificationChallenge(challenge('YQPQ0Q2CL'));

    await expect(createVerificationChallenge(challenge('2U8G9'))).rejects.toBeInstanceOf(
      ChallengeConflictError,
    );

    expect(
      await cancelVerificationChallenge({
        guildId: 'guild-1',
        discordUserId: 'actor-1',
        targetTag: 'YQPQ0Q2CL',
      }),
    ).toBe(true);
    await expect(createVerificationChallenge(challenge('2U8G9'))).resolves.toBeDefined();
  });
});

describe('persistent runtime leases (memory fallback)', () => {
  it('keeps one owner until release, then allows re-acquisition', async () => {
    const acquired = await acquireRuntimeLease({
      leaseKind: 'managed-sync',
      scope: 'all-guilds',
      ownerId: 'owner-1',
      ttlMs: 60_000,
    });
    expect(acquired.kind).toBe('acquired');

    const held = await acquireRuntimeLease({
      leaseKind: 'managed-sync',
      scope: 'all-guilds',
      ownerId: 'owner-2',
      ttlMs: 60_000,
    });
    expect(held.kind).toBe('held');

    if (acquired.kind === 'acquired') {
      expect(await renewRuntimeLease(acquired.lease, 120_000)).toBe(true);
      expect(await releaseRuntimeLease(acquired.lease)).toBe(true);
    }
    expect((await readRuntimeLease({ leaseKind: 'managed-sync', scope: 'all-guilds' }))?.releasedAt)
      .not.toBeNull();

    const next = await acquireRuntimeLease({
      leaseKind: 'managed-sync',
      scope: 'all-guilds',
      ownerId: 'owner-2',
      ttlMs: 60_000,
    });
    expect(next.kind).toBe('acquired');
  });
});
