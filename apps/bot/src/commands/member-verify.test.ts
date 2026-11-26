import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

const challenge = {
  guildId: 'guild-1',
  discordUserId: 'user-1',
  profileId: 'profile-1',
  playerDbId: 'player-1',
  playerTag: 'ABC',
  playerName: 'Player',
  startingIconId: 0,
  targetIconId: 42,
  targetIconName: 'Shelly',
  targetIconUrl: 'https://assets.example/shelly.png',
  createdAt: Date.now(),
  expiresAt: Date.now() + 30 * 60_000,
};

const mocks = vi.hoisted(() => ({
  startVerification: vi.fn(async () => ({ ok: true as const, challenge })),
  checkVerification: vi.fn(async () => ({
    ok: true as const,
    status: 'verified' as const,
    playerTag: challenge.playerTag,
    playerName: challenge.playerName,
    startingIconId: challenge.startingIconId,
    targetIconId: challenge.targetIconId,
    targetIconName: challenge.targetIconName,
    targetIconUrl: challenge.targetIconUrl,
    currentIconId: challenge.targetIconId,
  })),
  cancelVerification: vi.fn(
    async (): Promise<{ ok: true; hadChallenge: boolean } | { ok: false; message: string }> => ({
      ok: true,
      hadChallenge: true,
    }),
  ),
  getVerificationChallenge: vi.fn(() => challenge),
  checkBotRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
  notifyVerificationCompleted: vi.fn(async () => undefined),
  notifyVerificationFailed: vi.fn(async () => undefined),
  reconcileGuildRolesForPlayer: vi.fn(async () => ({
    kind: 'ok' as const,
    rolesAdded: 0,
    rolesRemoved: 0,
    rolesUnchanged: 1,
    errorCount: 0,
    membersNotFound: 0,
  })),
  syncNicknameAfterVerification: vi.fn(async () => ({ kind: 'ok' as const })),
}));

vi.mock('../verification/index.js', () => ({
  startVerification: mocks.startVerification,
  checkVerification: mocks.checkVerification,
  cancelVerification: mocks.cancelVerification,
  getVerificationChallenge: mocks.getVerificationChallenge,
}));
vi.mock('../discord/rate-limit.js', () => ({ checkBotRateLimit: mocks.checkBotRateLimit }));
vi.mock('../operator-notifier.js', () => ({
  notifyVerificationCompleted: mocks.notifyVerificationCompleted,
  notifyVerificationFailed: mocks.notifyVerificationFailed,
}));
vi.mock('../role-automation/index.js', () => ({
  reconcileGuildRolesForPlayer: mocks.reconcileGuildRolesForPlayer,
}));
vi.mock('../nickname-sync/service.js', () => ({
  syncNicknameAfterVerification: mocks.syncNicknameAfterVerification,
}));

import { handleMemberVerify } from './member-verify.js';

function interactionFor(subcommand: string): ChatInputCommandInteraction {
  const client = {};
  return {
    client,
    deferred: true,
    replied: false,
    guildId: 'guild-1',
    channelId: 'channel-1',
    user: { id: 'user-1', username: 'user', globalName: null },
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getString: vi.fn(() => '#ABC'),
    },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
});

describe('member verification guild scoping', () => {
  it('starts challenges with the invoking guild id', async () => {
    await handleMemberVerify(interactionFor('start'));

    expect(mocks.startVerification).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'guild-1', discordUserId: 'user-1' }),
    );
  });

  it('checks challenges with the invoking guild id and reconciles auto roles after success', async () => {
    const interaction = interactionFor('check');

    await handleMemberVerify(interaction);

    expect(mocks.checkVerification).toHaveBeenCalledWith({
      discordUserId: 'user-1',
      guildId: 'guild-1',
    });
    expect(mocks.reconcileGuildRolesForPlayer).toHaveBeenCalledWith(
      'guild-1',
      'user-1',
      { client: interaction.client },
    );
    expect(mocks.syncNicknameAfterVerification).toHaveBeenCalledWith(
      interaction.client,
      'guild-1',
      'user-1',
      { playerName: 'Player', playerTag: 'ABC' },
    );
  });

  it('cancels challenges with the invoking guild id', async () => {
    await handleMemberVerify(interactionFor('cancel'));

    expect(mocks.cancelVerification).toHaveBeenCalledWith({
      discordUserId: 'user-1',
      guildId: 'guild-1',
    });
  });

  it('reports a failed persistent cancellation', async () => {
    mocks.cancelVerification.mockResolvedValueOnce({ ok: false, message: 'db failed' });
    const interaction = interactionFor('cancel');

    await handleMemberVerify(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Could not cancel verification right now. Please try again later.',
    });
  });

  it('reads challenge status with the invoking guild id', async () => {
    await handleMemberVerify(interactionFor('status'));

    expect(mocks.getVerificationChallenge).toHaveBeenCalledWith({
      discordUserId: 'user-1',
      guildId: 'guild-1',
    });
  });
});
