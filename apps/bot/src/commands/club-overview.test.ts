import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

const GUILD_ID = '123456789012345678';
const OTHER_GUILD_ID = '999999999999999999';
const USER_ID = '111111111111111111';
const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const mocks = vi.hoisted(() => ({
  service: {
    requireGlobalPermission: vi.fn(),
    loadGuildSettings: vi.fn(),
    updateGuildOverviewFields: vi.fn(),
  },
  adminErrors: { replyAdminError: vi.fn() },
  overviewService: { refreshOverviewNow: vi.fn() },
  permissions: { getInteractionMemberRoleIds: vi.fn() },
}));

vi.mock('../admin/service', () => mocks.service);
vi.mock('../admin/errors', () => mocks.adminErrors);
vi.mock('../clubs/overview/service', () => mocks.overviewService);
vi.mock('../discord/permissions.js', () => mocks.permissions);

import {
  clubOverviewCommandData,
  handleClubOverview,
  handleClubOverviewComponent,
} from './club-overview';

function actor() {
  return { profileId: PROFILE_ID, discordUserId: USER_ID, globalRole: 'admin' as const };
}

function settings(fields: string[]) {
  return {
    guildId: GUILD_ID,
    overviewFields: fields,
    overviewChannelId: '888888888888888888',
  };
}

function chat(): ChatInputCommandInteraction {
  const interaction = {
    user: { id: USER_ID, username: 'actor' },
    guildId: GUILD_ID,
    guild: {
      id: GUILD_ID,
      name: 'Test Guild',
      ownerId: OTHER_GUILD_ID,
      iconURL: vi.fn(() => 'https://example.com/icon.png'),
    },
    member: null,
    memberPermissions: null,
    options: { getSubcommand: vi.fn(() => 'menu') },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  };
  return interaction as unknown as ChatInputCommandInteraction;
}

function component(customId: string, values: string[] = [], guildId = GUILD_ID) {
  const interaction = {
    user: { id: USER_ID, username: 'actor' },
    guildId,
    guild: {
      id: guildId,
      name: 'Test Guild',
      ownerId: OTHER_GUILD_ID,
      iconURL: vi.fn(() => 'https://example.com/icon.png'),
    },
    member: null,
    memberPermissions: null,
    customId,
    values,
    isStringSelectMenu: vi.fn(() => true),
    deferred: false,
    replied: false,
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  };
  return interaction;
}

function payload(interaction: unknown): any {
  const editReply = (interaction as any).editReply as ReturnType<typeof vi.fn>;
  return editReply.mock.calls[0]?.[0] as any;
}

beforeEach(() => {
  mocks.service.requireGlobalPermission.mockReset();
  mocks.service.requireGlobalPermission.mockResolvedValue(actor());
  mocks.service.loadGuildSettings.mockReset();
  mocks.service.loadGuildSettings.mockResolvedValue(settings(['members', 'staff']));
  mocks.service.updateGuildOverviewFields.mockReset();
  mocks.service.updateGuildOverviewFields.mockImplementation(async (input: any) => settings(input.fields));
  mocks.adminErrors.replyAdminError.mockReset();
  mocks.adminErrors.replyAdminError.mockImplementation(async () => undefined);
  mocks.overviewService.refreshOverviewNow.mockReset();
  mocks.overviewService.refreshOverviewNow.mockResolvedValue({ posted: true, messageId: 'm1' });
  mocks.permissions.getInteractionMemberRoleIds.mockReset();
  mocks.permissions.getInteractionMemberRoleIds.mockReturnValue([]);
});

describe('club-overview command', () => {
  it('registers a single menu subcommand', () => {
    const json = clubOverviewCommandData.toJSON();
    expect(json.name).toBe('club-overview');
    expect(json.options).toHaveLength(1);
    expect(json.options?.[0]?.name).toBe('menu');
  });

  it('opens a menu reflecting the stored fields', async () => {
    const interaction = chat();
    await handleClubOverview(interaction);

    const body = JSON.parse(JSON.stringify(payload(interaction)));
    const options = body.components[0].components[0].options;
    expect(options).toHaveLength(10);
    expect(options.find((o: any) => o.value === 'members')?.label).toContain('✅');
    expect(options.find((o: any) => o.value === 'megaPigEstimate')?.label).toContain('❌');
  });

  it('toggles a field, saves it, and refreshes the overview', async () => {
    const interaction = component(
      `club-overview:toggle:${GUILD_ID}`,
      ['megaPigEstimate'],
    );
    await handleClubOverviewComponent(interaction as any);

    expect(mocks.service.updateGuildOverviewFields).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: GUILD_ID,
        fields: expect.arrayContaining(['members', 'staff', 'megaPigEstimate']),
      }),
    );
    expect(mocks.overviewService.refreshOverviewNow).toHaveBeenCalledWith(GUILD_ID, {
      label: 'Test Guild',
      iconUrl: 'https://example.com/icon.png',
    });
    expect(payload(interaction).embeds[0].data.description).toContain('enabled');
  });

  it('ignores a component from a different guild', async () => {
    const interaction = component(
      `club-overview:toggle:${GUILD_ID}`,
      ['members'],
      OTHER_GUILD_ID,
    );
    await handleClubOverviewComponent(interaction as any);

    expect(mocks.service.updateGuildOverviewFields).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });
});
