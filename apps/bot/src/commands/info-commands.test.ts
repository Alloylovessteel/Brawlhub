import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import { paginate } from '../discord/pagination';
import { HELP_CATEGORIES } from '../info/catalog';
import { buildAboutEmbed, buildHelpPageEmbed, formatUptime } from '../info/embed';
import type { StatusView } from '../status/service';

const mocks = vi.hoisted(() => {
  class MockAdminServiceError extends Error {
    readonly code = 'forbidden';
  }
  return {
    loadStatusView: vi.fn(),
    requireGlobalPermission: vi.fn(),
    AdminServiceError: MockAdminServiceError,
    loadSyncRun: vi.fn(),
    recordSyncRunAudit: vi.fn(),
    loadSyncStatus: vi.fn(),
    loadGuildSettings: vi.fn(),
    updateGuildSettings: vi.fn(),
    listAuditLogs: vi.fn(),
    recordAdminAudit: vi.fn(),
  };
});

vi.mock('../status/service', () => ({ loadStatusView: mocks.loadStatusView }));
vi.mock('../admin/service', () => ({
  requireGlobalPermission: mocks.requireGlobalPermission,
  AdminServiceError: mocks.AdminServiceError,
  loadSyncRun: mocks.loadSyncRun,
  recordSyncRunAudit: mocks.recordSyncRunAudit,
  loadSyncStatus: mocks.loadSyncStatus,
  loadGuildSettings: mocks.loadGuildSettings,
  updateGuildSettings: mocks.updateGuildSettings,
  listAuditLogs: mocks.listAuditLogs,
  recordAdminAudit: mocks.recordAdminAudit,
}));

import { commands, pendingCommands } from './index';
import { handleAbout } from './about';
import { accountCommandData } from './account';
import { handleHelp, handleHelpComponent, helpCommandData } from './help';
import { infoCommandData } from './info';
import { handleStatus } from './status';
import { verifyCommandData } from './verify';

function chat(): ChatInputCommandInteraction {
  const interaction = {
    replied: false,
    deferred: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  return interaction as unknown as ChatInputCommandInteraction;
}

function button(customId: string): ButtonInteraction {
  const interaction = {
    customId,
    replied: false,
    deferred: false,
    deferUpdate: vi.fn(async () => undefined),
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

function statusView(overrides: Partial<StatusView> = {}): StatusView {
  return {
    generatedAt: new Date('2026-11-18T00:10:00.000Z'),
    version: 'v0.1.0',
    overall: 'operational',
    discord: {
      state: 'ok',
      detail: 'Discord gateway is connected.',
      uptimeMs: 600_000,
      connectedAt: new Date('2026-11-18T00:00:01.000Z'),
    },
    database: { state: 'ok', detail: 'Database responded.', clubCount: 5 },
    api: { state: 'ok', detail: 'Official API responded for a registered club.' },
    sync: {
      state: 'ok',
      detail: 'Stored synchronisation status is available.',
      status: 'completed',
      lastTimestamp: new Date('2026-11-18T00:05:00.000Z'),
      running: false,
    },
    ...overrides,
  };
}

beforeEach(() => {
  mocks.loadStatusView.mockReset();
  mocks.loadStatusView.mockResolvedValue(statusView());
  mocks.requireGlobalPermission.mockReset();
});

describe('command registration', () => {
  it('registers the consolidated account, verify and info commands', () => {
    const names = commands.map((command) => command.data.name);
    expect(names).toContain('help');
    expect(names).toContain('account');
    expect(names).toContain('verify');
    expect(names).toContain('info');
    for (const retired of [
      'about',
      'status',
      'accounts',
      'member-verify',
      'verify-info',
      'verify-settings',
      'sync-status',
      'tag',
      'register-list',
      'find',
    ]) {
      expect(names).not.toContain(retired);
    }
    expect(commands.find((command) => command.data.name === 'help')?.handleComponent).toBeTypeOf('function');
    expect(helpCommandData.toJSON().name).toBe('help');
    expect(accountCommandData.toJSON().name).toBe('account');
    expect(verifyCommandData.toJSON().name).toBe('verify');
    expect(infoCommandData.toJSON().name).toBe('info');
  });

  it('does not add pending commands to the public help directory', () => {
    const helpNames = new Set(HELP_CATEGORIES.flatMap((category) => category.entries.map((entry) => entry.name)));
    const pendingNames = pendingCommands.map((command) => command.data.name);

    for (const name of pendingNames) {
      expect(helpNames.has(name)).toBe(false);
    }
  });
});

describe('/help', () => {
  it('lists exactly the currently active commands', () => {
    const activeNames = commands.map((command) => command.data.name).sort();
    const helpNames = HELP_CATEGORIES.flatMap((category) =>
      category.entries.map((entry) => entry.name),
    ).sort();

    expect(helpNames).toEqual(activeNames);
  });

  it('uses all required categories with descriptions and examples', () => {
    expect(HELP_CATEGORIES.map((category) => category.name)).toEqual([
      'Club',
      'Player',
      'Leaderboard',
      'Game data',
      'Competition',
      'Membership',
      'Staff and moderation',
      'Administration',
      'Information',
    ]);
    for (const category of HELP_CATEGORIES) {
      for (const entry of category.entries) {
        expect(entry.description.length).toBeGreaterThan(10);
        expect(entry.usage).toContain(`/${entry.name}`);
      }
    }
  });

  it('paginates category embeds within Discord limits', () => {
    for (let page = 1; page <= 5; page += 1) {
      const paged = paginate(HELP_CATEGORIES, page, 2);
      const embed = buildHelpPageEmbed(paged).toJSON();
      expect(embed.fields?.length ?? 0).toBeGreaterThan(0);
      expect(JSON.stringify(embed).length).toBeLessThan(6000);
      for (const field of embed.fields ?? []) {
        expect(field.value.length).toBeLessThanOrEqual(1024);
      }
    }
  });

  it('replies with the first page and pagination controls', async () => {
    const interaction = chat();

    await handleHelp(interaction);

    const reply = payload(interaction, 'reply');
    expect(reply.allowedMentions).toEqual({ parse: [] });
    expect(reply.ephemeral).not.toBe(true);
    expect(reply.components[0].components[0].data.custom_id).toBe('help:page:2');
  });

  it('renders a later page from a pagination button', async () => {
    const interaction = button('help:page:2');

    await handleHelpComponent(interaction);

    const edit = payload(interaction, 'editReply');
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(edit.content).toBeNull();
    expect(edit.embeds).toHaveLength(1);
    expect(edit.embeds[0].data.description).toContain('Page 2 of 5');
    const customIds = edit.components[0].components.map(
      (component: any) => component.data.custom_id,
    );
    expect(customIds).toContain('help:page:1');
    expect(customIds).toContain('help:page:3');
  });

  it('ignores unrelated component IDs', async () => {
    const interaction = button('audit:page:2');

    await handleHelpComponent(interaction);

    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });
});

describe('/info about', () => {
  it('states the project purpose, data sources and limitations honestly', async () => {
    const interaction = chat();

    await handleAbout(interaction);

    const reply = payload(interaction, 'reply');
    const text = JSON.stringify(reply.embeds[0].toJSON());
    expect(text).toContain('independent community project');
    expect(text).toContain('not affiliated with or endorsed by Supercell');
    expect(text).toContain('official Brawl Stars API');
    expect(text).toContain('Multi-club tools');
    expect(text).toContain('Important limitations');
    expect(text).not.toContain('official partner');
    expect(text).not.toContain('endorsed by BrawlHub');
  });

  it('is publicly accessible', async () => {
    const interaction = chat();

    await handleAbout(interaction);

    expect(mocks.requireGlobalPermission).not.toHaveBeenCalled();
    expect(payload(interaction, 'reply').ephemeral).not.toBe(true);
  });
});

describe('/info status', () => {
  it('shows real loaded status information without requiring admin permission', async () => {
    const interaction = chat();

    await handleStatus(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.loadStatusView).toHaveBeenCalledWith({ guildId: undefined });
    expect(mocks.requireGlobalPermission).not.toHaveBeenCalled();
    const reply = payload(interaction, 'editReply');
    const text = JSON.stringify(reply.embeds[0].toJSON());
    expect(text).toContain('BrawlHub status: operational');
    expect(text).toContain('Registered clubs: 5');
    expect(text).toContain('completed');
  });

  it('distinguishes degraded status from online-only health', async () => {
    mocks.loadStatusView.mockResolvedValueOnce(
      statusView({
        overall: 'degraded',
        api: { state: 'unavailable', detail: 'Official API key is not configured.' },
      }),
    );
    const interaction = chat();

    await handleStatus(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    const text = JSON.stringify(payload(interaction, 'editReply').embeds[0].toJSON());
    expect(text).toContain('BrawlHub status: degraded');
    expect(text).toContain('Unavailable — Official API key is not configured.');
  });

  it('omits sensitive configuration and raw errors from the public reply', async () => {
    mocks.loadStatusView.mockResolvedValueOnce(
      statusView({
        overall: 'degraded',
        database: { state: 'error', detail: 'Database check failed.', clubCount: null },
        api: { state: 'error', detail: 'Official API check failed.', clubCount: undefined },
      } as never),
    );
    const interaction = chat();

    await handleStatus(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    const text = JSON.stringify(payload(interaction, 'editReply'));
    expect(text).not.toMatch(/Bearer/i);
    expect(text).not.toMatch(/SUPABASE_/i);
    expect(text).not.toContain('stack');
  });

  it('formats uptime accurately', () => {
    expect(formatUptime(90_061_000)).toBe('1d 1h 1m 1s');
    expect(formatUptime(3_661_000)).toBe('0d 1h 1m 1s');
    expect(formatUptime(-5)).toBe('0d 0h 0m 0s');
  });

  it('uses the real about embed builder without exposing admin details', () => {
    const text = JSON.stringify(buildAboutEmbed().toJSON());
    expect(text).not.toContain('audit:read');
    expect(text).not.toContain('guild.settings.updated');
  });
});
