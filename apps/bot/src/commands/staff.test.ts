import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';

const mocks = vi.hoisted(() => {
  class MockStaffServiceError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
      super(message);
      this.name = 'StaffServiceError';
      this.code = code;
    }
  }

  class MockAdminServiceError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'AdminServiceError';
      this.code = code;
    }
  }

  return {
    StaffServiceError: MockStaffServiceError,
    AdminServiceError: MockAdminServiceError,
    config: {
      token: undefined,
      clientId: undefined,
      guildId: 'guild-1',
      callbackUrl: undefined,
      logLevel: undefined,
      emojis: {},
      playerProfileUrlTemplate: 'https://example.test/player/{tag}',
      clubProfileUrlTemplate: undefined,
      seasonStartIso: undefined,
    },
    embeds: {
      overview: { kind: 'overview' },
      list: { kind: 'list' },
    },
    embed: {
      buildStaffListEmbed: vi.fn(),
      buildStaffOverviewEmbed: vi.fn(),
    },
    service: {
      listStaff: vi.fn(),
    },
    admin: {
      requireGlobalPermission: vi.fn(),
    },
  };
});

vi.mock('../config', () => ({ getBotConfig: () => mocks.config }));
vi.mock('../staff/service', () => ({
  ...mocks.service,
  StaffServiceError: mocks.StaffServiceError,
}));
vi.mock('../staff/embed', () => mocks.embed);
vi.mock('../admin/service', () => ({
  requireGlobalPermission: mocks.admin.requireGlobalPermission,
  AdminServiceError: mocks.AdminServiceError,
}));
vi.mock('../discord/permissions.js', () => ({ getInteractionMemberRoleIds: () => [] }));

import { handleStaff, handleStaffComponent, staffCommandData } from './staff';

const DISCORD_ID = '111111111111111111';

function actor(globalRole: 'owner' | null = 'owner') {
  return { profileId: 'profile-1', discordUserId: DISCORD_ID, globalRole };
}

function staffMember(index: number) {
  return {
    profileId: `profile-${index}`,
    discordUserId: `${DISCORD_ID.slice(0, -index)}${index}`,
    discordUsername: `Staff ${index}`,
    roles: [],
    highestGlobalRole: 'staff' as const,
    permissions: [],
  };
}

function staffView(count: number) {
  return {
    entries: Array.from({ length: count }, (_, index) => staffMember(index)),
    globalCount: count,
    clubCount: 0,
    generatedAt: new Date('2026-11-18T00:00:00.000Z'),
  };
}

function chatInteraction(subcommand: string | null) {
  return {
    user: { id: DISCORD_ID, username: 'actor' },
    guildId: 'guild-1',
    guild: { ownerId: '999999999999999999' },
    member: { roles: { cache: new Map() } },
    memberPermissions: null,
    options: {
      getSubcommand: vi.fn(() => subcommand),
    },
    replied: false,
    deferred: false,
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function buttonInteraction(customId: string, discordUserId = DISCORD_ID) {
  const interaction = {
    customId,
    user: { id: discordUserId, username: 'actor' },
    guildId: 'guild-1',
    guild: { ownerId: '999999999999999999' },
    member: { roles: { cache: new Map() } },
    memberPermissions: null,
    replied: false,
    deferred: false,
    deferUpdate: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  return interaction as unknown as ButtonInteraction;
}

function payload(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  method: 'reply' | 'editReply' | 'followUp',
): any {
  return (interaction[method] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as any;
}

function allowStaff() {
  mocks.admin.requireGlobalPermission.mockResolvedValue(actor());
}

function denyStaff() {
  mocks.admin.requireGlobalPermission.mockRejectedValue(
    new mocks.AdminServiceError('forbidden', 'You do not have permission.'),
  );
}

beforeEach(() => {
  for (const fn of Object.values(mocks.service)) fn.mockReset();
  for (const fn of Object.values(mocks.embed)) fn.mockReset();
  mocks.admin.requireGlobalPermission.mockReset();
  mocks.embed.buildStaffOverviewEmbed.mockReturnValue(mocks.embeds.overview);
  mocks.embed.buildStaffListEmbed.mockReturnValue(mocks.embeds.list);
  allowStaff();
  mocks.service.listStaff.mockResolvedValue(staffView(12));
});

describe('/staff command registration', () => {
  it('registers the list subcommand', () => {
    const json = staffCommandData.toJSON() as any;
    expect(json.name).toBe('staff');
    expect(json.description).toBe('View BrawlHub staff information');
    expect(json.options?.map((option: any) => option.name)).toEqual(['list']);
    expect(json.options?.[0]?.description).toBe(
      'List registered BrawlHub staff (authorised staff only)',
    );
  });
});

describe('/staff command handlers', () => {
  it('shows the overview embed for the base command', async () => {
    const interaction = chatInteraction(null);

    await handleStaff(interaction);

    expect(mocks.embed.buildStaffOverviewEmbed).toHaveBeenCalledWith();
    expect(payload(interaction, 'reply')).toMatchObject({
      embeds: [mocks.embeds.overview],
      allowedMentions: { parse: [] },
    });
    expect(mocks.admin.requireGlobalPermission).not.toHaveBeenCalled();
    expect(mocks.service.listStaff).not.toHaveBeenCalled();
  });

  it('replies ephemerally when staff permission is missing', async () => {
    denyStaff();
    const interaction = chatInteraction('list');

    await handleStaff(interaction);

    expect(payload(interaction, 'reply')).toMatchObject({ flags: 64 });
    expect(payload(interaction, 'reply').content).toContain('permission');
    expect(mocks.service.listStaff).not.toHaveBeenCalled();
  });

  it('lists staff with five entries per page and pagination controls', async () => {
    const view = staffView(7);
    mocks.service.listStaff.mockResolvedValue(view);
    const interaction = chatInteraction('list');

    await handleStaff(interaction);

    expect(mocks.admin.requireGlobalPermission).toHaveBeenCalledWith(
      DISCORD_ID,
      'staff:manage',
      expect.objectContaining({ guildId: 'guild-1' }),
    );
    expect(mocks.embed.buildStaffListEmbed).toHaveBeenCalledWith(
      view,
      expect.objectContaining({ page: 1, pageCount: 2, total: 7 }),
    );
    const reply = payload(interaction, 'reply');
    expect(reply.flags).toBe(64);
    expect(reply.embeds).toEqual([mocks.embeds.list]);
    expect(reply.components[0].components[0].data.custom_id).toBe('staff:page:2');
  });

  it('rejects club staff again on a pagination button', async () => {
    denyStaff();
    const button = buttonInteraction('staff:page:2');

    await handleStaffComponent(button);

    expect(button.deferUpdate).toHaveBeenCalled();
    expect(mocks.admin.requireGlobalPermission).toHaveBeenCalledWith(
      DISCORD_ID,
      'staff:manage',
      expect.objectContaining({ guildId: 'guild-1' }),
    );
    expect(payload(button, 'followUp')).toMatchObject({ flags: 64 });
    expect(payload(button, 'followUp').content).toContain('permission');
    expect(button.editReply).not.toHaveBeenCalled();
  });

  it('renders the requested page after rechecking access', async () => {
    const button = buttonInteraction('staff:page:2');

    await handleStaffComponent(button);

    expect(mocks.embed.buildStaffListEmbed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ page: 2, pageCount: 3, total: 12 }),
    );
    expect(payload(button, 'editReply')).toMatchObject({
      embeds: [mocks.embeds.list],
      content: null,
      allowedMentions: { parse: [] },
    });
  });

  it('ignores buttons that are not staff pagination', async () => {
    const button = buttonInteraction('competition:page:2');

    await handleStaffComponent(button);

    expect(button.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.service.listStaff).not.toHaveBeenCalled();
  });
});
