import type { Client } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerificationChallengeRecord } from '../state/index.js';
import type { CheckVerificationResult } from './types.js';

const mocks = vi.hoisted(() => ({
  listChallenges: vi.fn(),
  checkVerification: vi.fn(),
  notifyUser: vi.fn(),
  loadUsername: vi.fn(),
  notifyOperator: vi.fn(),
  reconcileRoles: vi.fn(),
  syncNickname: vi.fn(async () => ({ kind: 'ok' as const })),
}));

vi.mock('../state/index.js', () => ({
  listVerificationChallenges: mocks.listChallenges,
}));

vi.mock('./service.js', () => ({
  checkVerification: mocks.checkVerification,
}));

vi.mock('../operator-notifier.js', () => ({
  notifyVerificationCompleted: mocks.notifyOperator,
}));

vi.mock('../role-automation/index.js', () => ({
  reconcileGuildRolesForPlayer: mocks.reconcileRoles,
}));

vi.mock('../nickname-sync/service.js', () => ({
  syncNicknameAfterVerification: mocks.syncNickname,
}));

import {
  resetVerificationAutoCheckRotationForTests,
  runVerificationAutoCheck,
} from './auto-check.js';

const NOW = 1_700_000_000_000;
const GUILD_ONE = '111111111111111111';
const GUILD_TWO = '222222222222222222';
const DISCORD_USER_ID = '333333333333333333';
const TAG = 'YQPQ0Q2CL';
const TARGET_ICON = {
  id: 28000016,
  name: 'Spike',
  imageUrl: 'https://cdn.brawlify.com/profile-icons/regular/28000016.png',
};

function makeRecord(overrides: Partial<VerificationChallengeRecord> = {}): VerificationChallengeRecord {
  return {
    guildId: GUILD_ONE,
    discordUserId: DISCORD_USER_ID,
    targetPlayerId: 'player-1',
    targetTag: TAG,
    challengeIconId: 28000003,
    status: 'active',
    expiresAt: NOW + 30 * 60 * 1000,
    createdAt: NOW,
    updatedAt: NOW,
    details: {
      profileId: 'profile-1',
      playerName: 'Alpha',
      startingIconId: 28000003,
      targetIconId: TARGET_ICON.id,
      targetIconName: TARGET_ICON.name,
      targetIconUrl: TARGET_ICON.imageUrl,
    },
    ...overrides,
  };
}

function verifiedResult(): CheckVerificationResult {
  return {
    ok: true,
    status: 'verified',
    playerTag: TAG,
    playerName: 'Alpha',
    startingIconId: 28000003,
    targetIconId: TARGET_ICON.id,
    targetIconName: TARGET_ICON.name,
    targetIconUrl: TARGET_ICON.imageUrl,
    currentIconId: TARGET_ICON.id,
  };
}

function pendingResult(): CheckVerificationResult {
  return {
    ok: true,
    status: 'pending',
    playerTag: TAG,
    playerName: 'Alpha',
    startingIconId: 28000003,
    targetIconId: TARGET_ICON.id,
    targetIconName: TARGET_ICON.name,
    targetIconUrl: TARGET_ICON.imageUrl,
    currentIconId: 28000003,
    expiresAt: NOW + 30 * 60 * 1000,
  };
}

function fakeClient(): {
  readonly client: Client;
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue({ id: 'dm-message' });
  const fetch = vi.fn().mockResolvedValue({
    username: 'alpha',
    globalName: 'Alpha',
    send,
  });
  return { client: { users: { fetch } } as unknown as Client, fetch, send };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetVerificationAutoCheckRotationForTests();
  mocks.listChallenges.mockResolvedValue([makeRecord()]);
  mocks.checkVerification.mockResolvedValue(verifiedResult());
  mocks.notifyUser.mockResolvedValue(undefined);
  mocks.loadUsername.mockResolvedValue('Alpha');
  mocks.notifyOperator.mockResolvedValue(undefined);
  mocks.reconcileRoles.mockResolvedValue({
    kind: 'ok',
    rolesAdded: 0,
    rolesRemoved: 0,
    rolesUnchanged: 0,
    errorCount: 0,
    membersNotFound: 0,
  });
  mocks.syncNickname.mockResolvedValue({ kind: 'ok' });
});

describe('runVerificationAutoCheck', () => {
  it('verifies a matching icon and notifies only the challenge guild', async () => {
    const { client } = fakeClient();

    const summary = await runVerificationAutoCheck(client, {
      now: () => NOW,
      notifyUser: mocks.notifyUser,
      loadUsername: mocks.loadUsername,
      notifyOperator: mocks.notifyOperator,
      reconcileRoles: mocks.reconcileRoles,
      syncNickname: mocks.syncNickname,
    });

    expect(summary).toMatchObject({ candidates: 1, checked: 1, verified: 1 });
    expect(mocks.checkVerification).toHaveBeenCalledWith({
      discordUserId: DISCORD_USER_ID,
      guildId: GUILD_ONE,
    });
    expect(mocks.notifyUser).toHaveBeenCalledWith({
      discordUserId: DISCORD_USER_ID,
      content: expect.stringContaining('Verification complete for Alpha'),
    });
    expect(mocks.notifyOperator).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: GUILD_ONE,
        playerTag: TAG,
        discordUserId: DISCORD_USER_ID,
        discordUsername: 'Alpha',
        method: 'icon-verified',
      }),
    );
    expect(mocks.reconcileRoles).toHaveBeenCalledWith(GUILD_ONE, DISCORD_USER_ID, { client });
    expect(mocks.syncNickname).toHaveBeenCalledWith(client, GUILD_ONE, DISCORD_USER_ID, {
      playerName: 'Alpha',
      playerTag: TAG,
    });
  });

  it('leaves a mismatched challenge pending without sending notices', async () => {
    const { client } = fakeClient();
    mocks.checkVerification.mockResolvedValue(pendingResult());

    const summary = await runVerificationAutoCheck(client, {
      now: () => NOW,
      notifyUser: mocks.notifyUser,
      loadUsername: mocks.loadUsername,
      notifyOperator: mocks.notifyOperator,
      reconcileRoles: mocks.reconcileRoles,
    });

    expect(summary).toMatchObject({ candidates: 1, checked: 1, pending: 1, verified: 0 });
    expect(mocks.notifyUser).not.toHaveBeenCalled();
    expect(mocks.notifyOperator).not.toHaveBeenCalled();
    expect(mocks.reconcileRoles).not.toHaveBeenCalled();
  });

  it('does not check challenges that already expired', async () => {
    const { client } = fakeClient();
    mocks.listChallenges.mockResolvedValue([
      makeRecord({ expiresAt: NOW - 1 }),
    ]);

    const summary = await runVerificationAutoCheck(client, {
      now: () => NOW,
      notifyUser: mocks.notifyUser,
      loadUsername: mocks.loadUsername,
      notifyOperator: mocks.notifyOperator,
      reconcileRoles: mocks.reconcileRoles,
    });

    expect(summary).toMatchObject({ candidates: 0, skipped: 0, checked: 0 });
    expect(mocks.checkVerification).not.toHaveBeenCalled();
  });

  it('keeps each challenge scoped to its own guild', async () => {
    const { client } = fakeClient();
    mocks.listChallenges.mockResolvedValue([
      makeRecord({ guildId: GUILD_ONE, targetTag: 'TAGONE' }),
      makeRecord({ guildId: GUILD_TWO, targetTag: 'TAGTWO', discordUserId: '444444444444444444' }),
    ]);

    await runVerificationAutoCheck(client, {
      now: () => NOW,
      notifyUser: mocks.notifyUser,
      loadUsername: mocks.loadUsername,
      notifyOperator: mocks.notifyOperator,
      reconcileRoles: mocks.reconcileRoles,
    });

    expect(mocks.checkVerification.mock.calls).toEqual([
      [{ discordUserId: DISCORD_USER_ID, guildId: GUILD_ONE }],
      [{ discordUserId: '444444444444444444', guildId: GUILD_TWO }],
    ]);
    expect(mocks.notifyOperator.mock.calls.map((call) => call[0].guildId)).toEqual([
      GUILD_ONE,
      GUILD_TWO,
    ]);
    expect(mocks.reconcileRoles.mock.calls.map((call) => call[0])).toEqual([
      GUILD_ONE,
      GUILD_TWO,
    ]);
  });

  it('skips overlapping polls so a challenge cannot be verified twice', async () => {
    const { client } = fakeClient();
    let resolveCheck: ((value: CheckVerificationResult) => void) | undefined;
    mocks.checkVerification.mockImplementation(
      () =>
        new Promise<CheckVerificationResult>((resolve) => {
          resolveCheck = resolve;
        }),
    );

    const first = runVerificationAutoCheck(client, {
      now: () => NOW,
      notifyUser: mocks.notifyUser,
      loadUsername: mocks.loadUsername,
      notifyOperator: mocks.notifyOperator,
      reconcileRoles: mocks.reconcileRoles,
    });
    await vi.waitFor(() => expect(mocks.checkVerification).toHaveBeenCalledTimes(1));

    const overlapping = await runVerificationAutoCheck(client, {
      now: () => NOW,
      notifyUser: mocks.notifyUser,
      loadUsername: mocks.loadUsername,
      notifyOperator: mocks.notifyOperator,
      reconcileRoles: mocks.reconcileRoles,
    });
    expect(overlapping.checked).toBe(0);

    resolveCheck?.(verifiedResult());
    await first;

    expect(mocks.checkVerification).toHaveBeenCalledTimes(1);
    expect(mocks.notifyOperator).toHaveBeenCalledTimes(1);
  });

  it('limits each poll to the configured batch size', async () => {
    const { client } = fakeClient();
    mocks.listChallenges.mockResolvedValue([
      makeRecord({ targetTag: 'TAGONE' }),
      makeRecord({ targetTag: 'TAGTWO' }),
      makeRecord({ targetTag: 'TAGTHREE' }),
    ]);

    const summary = await runVerificationAutoCheck(client, {
      now: () => NOW,
      batchSize: 1,
      notifyUser: mocks.notifyUser,
      loadUsername: mocks.loadUsername,
      notifyOperator: mocks.notifyOperator,
      reconcileRoles: mocks.reconcileRoles,
    });

    expect(summary).toMatchObject({ candidates: 3, checked: 1, verified: 1 });
    expect(mocks.checkVerification).toHaveBeenCalledTimes(1);
  });

  it('rotates the bounded batch so a pending challenge cannot starve newer ones', async () => {
    const { client } = fakeClient();
    mocks.listChallenges.mockResolvedValue([
      makeRecord({ targetTag: 'OLDEST', discordUserId: 'user-oldest', expiresAt: NOW + 1000 }),
      makeRecord({ targetTag: 'SECOND', discordUserId: 'user-second', expiresAt: NOW + 2000 }),
      makeRecord({ targetTag: 'NEWEST', discordUserId: 'user-newest', expiresAt: NOW + 3000 }),
    ]);
    mocks.checkVerification.mockResolvedValue(pendingResult());

    const deps = {
      now: () => NOW,
      batchSize: 1,
      notifyUser: mocks.notifyUser,
      loadUsername: mocks.loadUsername,
      notifyOperator: mocks.notifyOperator,
      reconcileRoles: mocks.reconcileRoles,
    };
    for (let poll = 0; poll < 4; poll += 1) {
      await runVerificationAutoCheck(client, deps);
    }

    expect(
      mocks.checkVerification.mock.calls.map(([input]) => (input as { discordUserId: string }).discordUserId),
    ).toEqual(['user-oldest', 'user-second', 'user-newest', 'user-oldest']);
  });

  it('sends the automatic DM with mentions disabled', async () => {
    const { client, send } = fakeClient();

    await runVerificationAutoCheck(client, {
      now: () => NOW,
      loadUsername: mocks.loadUsername,
      notifyOperator: mocks.notifyOperator,
      reconcileRoles: mocks.reconcileRoles,
    });

    expect(send).toHaveBeenCalledWith({
      content: expect.stringContaining('Verification complete for Alpha'),
      allowedMentions: { parse: [] },
    });
    expect(mocks.notifyOperator).toHaveBeenCalledTimes(1);
  });

  it('skips role reconciliation for DM-only challenges', async () => {
    const { client } = fakeClient();
    mocks.listChallenges.mockResolvedValue([makeRecord({ guildId: 'dm' })]);

    await runVerificationAutoCheck(client, {
      now: () => NOW,
      notifyUser: mocks.notifyUser,
      loadUsername: mocks.loadUsername,
      notifyOperator: mocks.notifyOperator,
      reconcileRoles: mocks.reconcileRoles,
    });

    expect(mocks.reconcileRoles).not.toHaveBeenCalled();
    expect(mocks.notifyOperator).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'dm' }),
    );
  });
});
