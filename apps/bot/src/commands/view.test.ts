import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';

const ACTOR_ID = '111111111111111111';
const OTHER_ID = '999999999999999999';
const GUILD_ID = '123456789012345678';
const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLUB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_CLUB_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const CLUB_A = { id: CLUB_ID, tag: '2UG9', name: 'Alpha' };
const CLUB_B = { id: OTHER_CLUB_ID, tag: 'Q8VR', name: 'Bravo' };

const mocks = vi.hoisted(() => {
  class MockAdminServiceError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
      super(message);
      this.name = 'AdminServiceError';
      this.code = code;
    }
  }

  return {
    AdminServiceError: MockAdminServiceError,
    service: {
      requireGlobalPermission: vi.fn(),
    },
    adminErrors: {
      replyAdminError: vi.fn(),
    },
    clubs: {
      getRegisteredClubs: vi.fn(),
      filterRegisteredClubs: vi.fn(),
    },
    overviewEmbed: {
      buildViewTagsEmbed: vi.fn(),
    },
    overviewService: {
      refreshOverviewNow: vi.fn(),
    },
    viewTags: {
      addViewTag: vi.fn(),
      removeViewTag: vi.fn(),
      readViewTags: vi.fn(),
      loadViewTagSummaries: vi.fn(),
    },
    config: {
      getBotConfig: vi.fn(),
    },
    permissions: {
      getInteractionMemberRoleIds: vi.fn(),
    },
  };
});

vi.mock('../admin/service', () => ({
  ...mocks.service,
  AdminServiceError: mocks.AdminServiceError,
}));
vi.mock('../admin/errors', () => mocks.adminErrors);
vi.mock('../clubs/service', () => mocks.clubs);
vi.mock('../clubs/overview/embed', () => mocks.overviewEmbed);
vi.mock('../clubs/overview/service', () => mocks.overviewService);
vi.mock('../clubs/view-tags', () => mocks.viewTags);
vi.mock('../config', () => mocks.config);
vi.mock('../discord/permissions.js', () => mocks.permissions);

import { handleView, handleViewAutocomplete, viewCommandData } from './view';

function actor() {
  return { profileId: PROFILE_ID, discordUserId: ACTOR_ID, globalRole: 'admin' as const };
}

function forbidden(): InstanceType<typeof mocks.AdminServiceError> {
  return new mocks.AdminServiceError('forbidden', 'You do not have permission.');
}

function chat(
  subcommand: string | null,
  options: Record<string, unknown> = {},
): ChatInputCommandInteraction {
  const interaction = {
    user: { id: ACTOR_ID, username: 'actor' },
    guildId: GUILD_ID,
    guild: { id: GUILD_ID, name: 'Test Guild', ownerId: OTHER_ID },
    member: null,
    memberPermissions: null,
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getString: vi.fn((name: string) => options[name] ?? null),
      getFocused: vi.fn(),
    },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  return interaction as unknown as ChatInputCommandInteraction;
}

function autocomplete(
  subcommand: string,
  name = 'tag',
  value = '',
): AutocompleteInteraction {
  return {
    user: { id: ACTOR_ID, username: 'actor' },
    guildId: GUILD_ID,
    guild: { id: GUILD_ID, name: 'Test Guild', ownerId: OTHER_ID },
    member: null,
    memberPermissions: null,
    options: {
      getFocused: vi.fn(() => ({ name, value })),
      getSubcommand: vi.fn(() => subcommand),
    },
    respond: vi.fn(async () => undefined),
  } as unknown as AutocompleteInteraction;
}

function payload(interaction: any, method: 'editReply' | 'reply' | 'followUp'): any {
  return (interaction[method] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as any;
}

function choices(interaction: AutocompleteInteraction): any {
  return (interaction.respond as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
}

beforeEach(() => {
  mocks.service.requireGlobalPermission.mockReset();
  mocks.service.requireGlobalPermission.mockResolvedValue(actor());
  mocks.adminErrors.replyAdminError.mockReset();
  mocks.adminErrors.replyAdminError.mockImplementation(async (interaction: any, error: unknown) => {
    await interaction.editReply({
      content: error instanceof Error ? error.message : 'Unexpected error',
      components: [],
    });
  });
  mocks.clubs.getRegisteredClubs.mockReset();
  mocks.clubs.getRegisteredClubs.mockResolvedValue([CLUB_A, CLUB_B]);
  mocks.clubs.filterRegisteredClubs.mockReset();
  mocks.clubs.filterRegisteredClubs.mockImplementation((clubs: any[], query: string) => {
    const needle = String(query ?? '')
      .trim()
      .replace(/^#/, '')
      .toLowerCase();
    return clubs
      .filter(
        (club) =>
          needle === '' ||
          String(club.name).toLowerCase().includes(needle) ||
          String(club.tag).toLowerCase().includes(needle),
      )
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  });
  mocks.overviewEmbed.buildViewTagsEmbed.mockReset();
  mocks.overviewEmbed.buildViewTagsEmbed.mockReturnValue({ kind: 'view-tags' });
  mocks.overviewService.refreshOverviewNow.mockReset();
  mocks.overviewService.refreshOverviewNow.mockResolvedValue({ posted: false, messageId: null });
  mocks.viewTags.addViewTag.mockReset();
  mocks.viewTags.addViewTag.mockResolvedValue({ kind: 'added', total: 1 });
  mocks.viewTags.removeViewTag.mockReset();
  mocks.viewTags.removeViewTag.mockResolvedValue({ kind: 'removed' });
  mocks.viewTags.readViewTags.mockReset();
  mocks.viewTags.readViewTags.mockResolvedValue([]);
  mocks.viewTags.loadViewTagSummaries.mockReset();
  mocks.viewTags.loadViewTagSummaries.mockResolvedValue([]);
  mocks.config.getBotConfig.mockReset();
  mocks.config.getBotConfig.mockReturnValue({ token: undefined, appUrl: 'https://example.test' });
  mocks.permissions.getInteractionMemberRoleIds.mockReset();
  mocks.permissions.getInteractionMemberRoleIds.mockReturnValue(null);
});

describe('/view command data', () => {
  it('registers flat add, remove and list subcommands', () => {
    const json = viewCommandData.toJSON() as any;

    expect(json.name).toBe('view');
    expect(json.options.map((option: any) => option.name)).toEqual([
      'add',
      'remove',
      'list',
    ]);
  });
});

describe('/view permission handling', () => {
  it('defers ephemerally and denies users without clubs:write', async () => {
    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const interaction = chat('list');

    await handleView(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(mocks.service.requireGlobalPermission).toHaveBeenCalledWith(
      ACTOR_ID,
      'clubs:write',
      expect.objectContaining({ guildId: GUILD_ID }),
    );
    expect(mocks.viewTags.loadViewTagSummaries).not.toHaveBeenCalled();
    expect(mocks.overviewService.refreshOverviewNow).not.toHaveBeenCalled();
    expect(payload(interaction, 'editReply').content).toContain('permission');
    expect(mocks.adminErrors.replyAdminError).toHaveBeenCalledOnce();
  });

  it('still checks permission before reporting an unknown action', async () => {
    const interaction = chat('other', { tag: '2UG9' });

    await handleView(interaction);

    expect(mocks.service.requireGlobalPermission).toHaveBeenCalledWith(
      ACTOR_ID,
      'clubs:write',
      expect.objectContaining({ guildId: GUILD_ID }),
    );
    expect(payload(interaction, 'editReply').content).toContain('Unknown `/view` action');
  });
});

describe('/view list', () => {
  it('renders the current overview and refreshes without posting a second message', async () => {
    const summaries = [{ club: CLUB_A }];
    mocks.viewTags.loadViewTagSummaries.mockResolvedValue(summaries);
    const interaction = chat('list');

    await handleView(interaction);

    expect(mocks.viewTags.loadViewTagSummaries).toHaveBeenCalledWith(GUILD_ID);
    expect(mocks.overviewEmbed.buildViewTagsEmbed).toHaveBeenCalledWith(
      expect.objectContaining({
        summaries,
        trackedSummaries: summaries,
        guildLabel: 'Test Guild',
        action: 'list',
        detail: null,
      }),
    );
    expect(payload(interaction, 'editReply').embeds).toEqual([{ kind: 'view-tags' }]);
    expect(mocks.overviewService.refreshOverviewNow).toHaveBeenCalledOnce();
    expect(mocks.overviewService.refreshOverviewNow).toHaveBeenCalledWith(GUILD_ID, {
      label: 'Test Guild',
      iconUrl: null,
    });
  });

  it('still replies when the overview refresh fails', async () => {
    mocks.overviewService.refreshOverviewNow.mockRejectedValueOnce(new Error('network offline'));
    const interaction = chat('list');

    await expect(handleView(interaction)).resolves.toBeUndefined();

    expect(payload(interaction, 'editReply').embeds).toEqual([{ kind: 'view-tags' }]);
    expect(mocks.adminErrors.replyAdminError).not.toHaveBeenCalled();
  });
});

describe('/view add', () => {
  it('resolves a club tag to a registered club and adds it', async () => {
    const interaction = chat('add', { tag: '#2ug9' });

    await handleView(interaction);

    expect(mocks.clubs.getRegisteredClubs).toHaveBeenCalledWith(GUILD_ID);
    expect(mocks.viewTags.addViewTag).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      clubId: CLUB_ID,
      actor: actor(),
    });
    expect(mocks.overviewEmbed.buildViewTagsEmbed).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'added',
        detail: expect.stringContaining('Added Alpha (#2UG9)'),
      }),
    );
    expect(mocks.overviewService.refreshOverviewNow).toHaveBeenCalledOnce();
    expect(payload(interaction, 'editReply').embeds).toEqual([{ kind: 'view-tags' }]);
  });

  it('resolves a club id as well as a tag', async () => {
    const interaction = chat('add', { tag: OTHER_CLUB_ID });

    await handleView(interaction);

    expect(mocks.viewTags.addViewTag).toHaveBeenCalledWith(
      expect.objectContaining({ clubId: OTHER_CLUB_ID }),
    );
  });

  it('reports an already-present club without treating it as a failure', async () => {
    mocks.viewTags.addViewTag.mockResolvedValueOnce({ kind: 'already-present' });
    const interaction = chat('add', { tag: '2UG9' });

    await handleView(interaction);

    expect(mocks.overviewEmbed.buildViewTagsEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining('already in this server') }),
    );
    expect(mocks.overviewService.refreshOverviewNow).toHaveBeenCalledOnce();
  });

  it('stops when the overview is full', async () => {
    mocks.viewTags.addViewTag.mockResolvedValueOnce({ kind: 'limit-reached', limit: 25 });
    const interaction = chat('add', { tag: '2UG9' });

    await handleView(interaction);

    expect(payload(interaction, 'editReply').content).toContain('already tracks 25 clubs');
    expect(mocks.overviewEmbed.buildViewTagsEmbed).not.toHaveBeenCalled();
    expect(mocks.overviewService.refreshOverviewNow).not.toHaveBeenCalled();
  });

  it('does not report success when the club became unavailable during add', async () => {
    mocks.viewTags.addViewTag.mockResolvedValueOnce({ kind: 'not-found' });
    const interaction = chat('add', { tag: '2UG9' });

    await handleView(interaction);

    expect(payload(interaction, 'editReply').content).toContain('no longer active');
    expect(mocks.overviewEmbed.buildViewTagsEmbed).not.toHaveBeenCalled();
    expect(mocks.overviewService.refreshOverviewNow).not.toHaveBeenCalled();
  });
});

describe('/view remove', () => {
  it('removes the club and reports that it remains registered', async () => {
    const interaction = chat('remove', { tag: '2UG9' });

    await handleView(interaction);

    expect(mocks.viewTags.removeViewTag).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      clubId: CLUB_ID,
      actor: actor(),
    });
    expect(mocks.overviewEmbed.buildViewTagsEmbed).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'removed',
        detail: expect.stringContaining('still registered'),
      }),
    );
    expect(mocks.overviewService.refreshOverviewNow).toHaveBeenCalledOnce();
  });

  it('reports a club that was not in the overview', async () => {
    mocks.viewTags.removeViewTag.mockResolvedValueOnce({ kind: 'not-found' });
    const interaction = chat('remove', { tag: '2UG9' });

    await handleView(interaction);

    expect(mocks.overviewEmbed.buildViewTagsEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining('was not in this server') }),
    );
  });
});

describe('/view unregistered clubs', () => {
  it('refuses to add or remove a club that is not registered in the guild', async () => {
    mocks.clubs.getRegisteredClubs.mockResolvedValue([]);
    const add = chat('add', { tag: 'ZZZZ' });
    const remove = chat('remove', { tag: 'ZZZZ' });

    await handleView(add);
    await handleView(remove);

    for (const interaction of [add, remove]) {
      expect(payload(interaction, 'editReply').content).toContain('not registered in this server');
    }
    expect(mocks.viewTags.addViewTag).not.toHaveBeenCalled();
    expect(mocks.viewTags.removeViewTag).not.toHaveBeenCalled();
    expect(mocks.overviewService.refreshOverviewNow).not.toHaveBeenCalled();
  });
});

describe('/view autocomplete', () => {
  it('offers all registered clubs for add', async () => {
    const interaction = autocomplete('add', 'tag', '');

    await handleViewAutocomplete(interaction);

    expect(mocks.service.requireGlobalPermission).toHaveBeenCalledWith(
      ACTOR_ID,
      'clubs:write',
      expect.objectContaining({ guildId: GUILD_ID }),
    );
    expect(mocks.viewTags.readViewTags).not.toHaveBeenCalled();
    expect(choices(interaction)).toEqual([
      { name: 'Alpha (#2UG9)', value: CLUB_ID },
      { name: 'Bravo (#Q8VR)', value: OTHER_CLUB_ID },
    ]);
  });

  it('offers only currently tagged clubs for remove', async () => {
    mocks.viewTags.readViewTags.mockResolvedValue([
      { guildId: GUILD_ID, clubId: CLUB_ID, addedBy: PROFILE_ID, addedAt: null },
    ]);
    const interaction = autocomplete('remove', 'tag', '');

    await handleViewAutocomplete(interaction);

    expect(mocks.viewTags.readViewTags).toHaveBeenCalledWith(GUILD_ID);
    expect(choices(interaction)).toEqual([{ name: 'Alpha (#2UG9)', value: CLUB_ID }]);
  });

  it('returns no choices to unauthorised users', async () => {
    mocks.service.requireGlobalPermission.mockRejectedValueOnce(forbidden());
    const interaction = autocomplete('add', 'tag', '2U');

    await handleViewAutocomplete(interaction);

    expect(mocks.clubs.getRegisteredClubs).not.toHaveBeenCalled();
    expect(choices(interaction)).toEqual([]);
  });

  it('ignores unfocused options without resolving permission', async () => {
    const interaction = autocomplete('add', 'other', '2U');

    await handleViewAutocomplete(interaction);

    expect(mocks.service.requireGlobalPermission).not.toHaveBeenCalled();
    expect(choices(interaction)).toEqual([]);
  });
});
