import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonInteraction } from 'discord.js';

const mocks = vi.hoisted(() => {
  class MockAdminServiceError extends Error {
    readonly code = 'forbidden';
  }
  return {
    AdminServiceError: MockAdminServiceError,
    requireGlobalPermission: vi.fn(),
    loadGuildRankedRoleState: vi.fn(),
    saveGuildRankedRoleMapping: vi.fn(),
    refreshMemberRankedRole: vi.fn(),
    refreshGuildRankedRoles: vi.fn(),
    setupGuildAutomation: vi.fn(),
    buildVerificationMessage: vi.fn(),
  };
});

vi.mock('../admin/service', () => ({
  AdminServiceError: mocks.AdminServiceError,
  requireGlobalPermission: mocks.requireGlobalPermission,
}));

vi.mock('../ranked-roles/service', () => ({
  RANKED_TIERS: ['BRONZE', 'SILVER', 'GOLD', 'DIAMOND', 'MYTHIC', 'LEGENDARY', 'MASTERS', 'PRO'],
  loadGuildRankedRoleState: mocks.loadGuildRankedRoleState,
  saveGuildRankedRoleMapping: mocks.saveGuildRankedRoleMapping,
  refreshMemberRankedRole: mocks.refreshMemberRankedRole,
  refreshGuildRankedRoles: mocks.refreshGuildRankedRoles,
  setupGuildAutomation: mocks.setupGuildAutomation,
  buildVerificationMessage: mocks.buildVerificationMessage,
}));

import { handleAutoComponent } from './auto.js';
import { handleFnComponent } from './fn.js';
import { handleUpdateComponent } from './update.js';

const GUILD_ID = '1488531664962326571';
const OTHER_GUILD_ID = '1488531664962326572';

function button(customId: string, guildId: string | null): ButtonInteraction & {
  readonly calls: Record<string, ReturnType<typeof vi.fn>>;
} {
  const calls = {
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  return {
    customId,
    guildId,
    guild: guildId === null ? null : { id: guildId },
    user: { id: '983248496884875286', username: 'staff' },
    member: null,
    memberPermissions: null,
    deferred: false,
    replied: false,
    calls,
    ...calls,
  } as unknown as ButtonInteraction & { readonly calls: Record<string, ReturnType<typeof vi.fn>> };
}

beforeEach(() => {
  for (const mock of [
    mocks.requireGlobalPermission,
    mocks.loadGuildRankedRoleState,
    mocks.saveGuildRankedRoleMapping,
    mocks.refreshMemberRankedRole,
    mocks.refreshGuildRankedRoles,
    mocks.setupGuildAutomation,
    mocks.buildVerificationMessage,
  ]) {
    mock.mockReset();
  }
  mocks.requireGlobalPermission.mockResolvedValue({
    profileId: 'profile-1',
    discordUserId: '983248496884875286',
    globalRole: 'admin',
  });
  mocks.refreshMemberRankedRole.mockResolvedValue({ kind: 'ok', tier: 'GOLD' });
  mocks.refreshGuildRankedRoles.mockResolvedValue({
    planned: 1,
    processed: 1,
    membersNotFound: 0,
    cleanedMembers: 0,
  });
  mocks.loadGuildRankedRoleState.mockResolvedValue({
    guildId: GUILD_ID,
    mapping: {},
    verificationChannelId: null,
    verificationMessageId: null,
  });
  mocks.buildVerificationMessage.mockReturnValue({ embeds: [], components: [], allowedMentions: { parse: [] } });
});

describe('Phase 4 component guild isolation', () => {
  it('ignores /fn component interactions from another guild', async () => {
    const interaction = button(`fn:me:${GUILD_ID}`, OTHER_GUILD_ID);
    await handleFnComponent(interaction);
    expect(interaction.calls.deferReply).not.toHaveBeenCalled();
    expect(mocks.refreshMemberRankedRole).not.toHaveBeenCalled();
  });

  it('ignores /auto guide interactions from another guild', async () => {
    const interaction = button(`auto:guide:${GUILD_ID}`, OTHER_GUILD_ID);
    await handleAutoComponent(interaction);
    expect(interaction.calls.deferReply).not.toHaveBeenCalled();
    expect(mocks.buildVerificationMessage).not.toHaveBeenCalled();
  });

  it('ignores /update confirmation from another guild', async () => {
    const interaction = button(`update:run:${GUILD_ID}`, OTHER_GUILD_ID);
    await handleUpdateComponent(interaction);
    expect(interaction.calls.deferReply).not.toHaveBeenCalled();
    expect(mocks.refreshGuildRankedRoles).not.toHaveBeenCalled();
  });

  it('runs a confirmed refresh only in the matching guild', async () => {
    const interaction = button(`update:run:${GUILD_ID}`, GUILD_ID);
    await handleUpdateComponent(interaction);
    expect(mocks.requireGlobalPermission).toHaveBeenCalledOnce();
    expect(mocks.refreshGuildRankedRoles).toHaveBeenCalledOnce();
    expect(interaction.calls.editReply).toHaveBeenCalledOnce();
  });
});
