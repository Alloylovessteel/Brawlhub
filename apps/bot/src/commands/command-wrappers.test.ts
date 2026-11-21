import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';

const mocks = vi.hoisted(() => ({
  handleAccounts: vi.fn(async () => undefined),
  handleAccountsAutocomplete: vi.fn(async () => undefined),
  handleMemberVerify: vi.fn(async () => undefined),
  handleVerifyInfo: vi.fn(async () => undefined),
  handleVerifySettings: vi.fn(async () => undefined),
  handleTag: vi.fn(async () => undefined),
  handleRegisterList: vi.fn(async () => undefined),
  handleFind: vi.fn(async () => undefined),
  handleAbout: vi.fn(async () => undefined),
  handleStatus: vi.fn(async () => undefined),
}));

vi.mock('./accounts.js', () => ({
  handleAccounts: mocks.handleAccounts,
  handleAccountsAutocomplete: mocks.handleAccountsAutocomplete,
}));
vi.mock('./member-verify.js', () => ({ handleMemberVerify: mocks.handleMemberVerify }));
vi.mock('./admin-identity.js', () => ({
  handleTag: mocks.handleTag,
  handleRegisterList: mocks.handleRegisterList,
  handleFind: mocks.handleFind,
}));
vi.mock('./verification-info.js', () => ({
  handleVerifyInfo: mocks.handleVerifyInfo,
  handleVerifySettings: mocks.handleVerifySettings,
}));
vi.mock('./about.js', () => ({ handleAbout: mocks.handleAbout }));
vi.mock('./status.js', () => ({ handleStatus: mocks.handleStatus }));

import { accountCommandData, handleAccount, handleAccountAutocomplete } from './account';
import { infoCommandData, handleInfo } from './info';
import { verifyCommandData, handleVerify } from './verify';

function chat(group: string | null, subcommand: string | null): ChatInputCommandInteraction {
  return {
    options: {
      getSubcommandGroup: vi.fn(() => group),
      getSubcommand: vi.fn(() => subcommand),
    },
    reply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function autocomplete(subcommand: string | null): AutocompleteInteraction {
  return {
    options: {
      getSubcommand: vi.fn(() => subcommand),
    },
    respond: vi.fn(async () => undefined),
  } as unknown as AutocompleteInteraction;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockClear();
  }
});

describe('consolidated command data', () => {
  it('defines /members account list, set-main and the verify group', () => {
    const json = accountCommandData.toJSON() as any;
    expect(json.name).toBe('account');
    expect(json.options.map((option: any) => option.name)).toEqual(['list', 'set-main', 'verify']);
    expect(json.options[2].options.map((option: any) => option.name)).toEqual([
      'start',
      'check',
      'cancel',
      'status',
    ]);
  });

  it('defines /members verify info, settings, list, tag and find actions', () => {
    const json = verifyCommandData.toJSON() as any;
    expect(json.name).toBe('verify');
    expect(json.options.map((option: any) => option.name)).toEqual([
      'info',
      'settings',
      'list',
      'tag',
      'find',
    ]);
    expect(json.options[3].options.map((option: any) => option.name)).toEqual(['set']);
    expect(json.options[4].options.map((option: any) => option.name)).toEqual(['user', 'tag']);
  });

  it('defines /help about and status', () => {
    const json = infoCommandData.toJSON() as any;
    expect(json.name).toBe('info');
    expect(json.options.map((option: any) => option.name)).toEqual(['about', 'status']);
  });
});

describe('/members account dispatch', () => {
  it('routes account management to the existing handler', async () => {
    await handleAccount(chat(null, 'list'));

    expect(mocks.handleAccounts).toHaveBeenCalledOnce();
    expect(mocks.handleMemberVerify).not.toHaveBeenCalled();
  });

  it('routes the verify group to the existing verification handler', async () => {
    await handleAccount(chat('verify', 'start'));

    expect(mocks.handleMemberVerify).toHaveBeenCalledOnce();
    expect(mocks.handleAccounts).not.toHaveBeenCalled();
  });

  it('routes only set-main autocomplete to the existing handler', async () => {
    await handleAccountAutocomplete(autocomplete('set-main'));

    expect(mocks.handleAccountsAutocomplete).toHaveBeenCalledOnce();
  });

  it('returns no autocomplete choices for other actions', async () => {
    const interaction = autocomplete('list');

    await handleAccountAutocomplete(interaction);

    expect(mocks.handleAccountsAutocomplete).not.toHaveBeenCalled();
    expect(interaction.respond).toHaveBeenCalledWith([]);
  });
});

describe('/members verify dispatch', () => {
  it.each([
    ['info', 'handleVerifyInfo'],
    ['settings', 'handleVerifySettings'],
    ['list', 'handleRegisterList'],
  ] as const)('routes %s to the existing handler', async (subcommand, mockName) => {
    await handleVerify(chat(null, subcommand));

    expect(mocks[mockName]).toHaveBeenCalledOnce();
  });

  it('routes the tag group to the existing staff-link handler', async () => {
    await handleVerify(chat('tag', 'set'));

    expect(mocks.handleTag).toHaveBeenCalledOnce();
  });

  it('routes the find group to the existing lookup handler', async () => {
    await handleVerify(chat('find', 'user'));

    expect(mocks.handleFind).toHaveBeenCalledOnce();
  });

  it('replies ephemerally for an unknown action', async () => {
    const interaction = chat(null, 'unknown');

    await handleVerify(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: 64, content: 'Unknown verification action.' }),
    );
  });
});

describe('/help dispatch', () => {
  it.each([
    ['about', 'handleAbout'],
    ['status', 'handleStatus'],
  ] as const)('routes %s to the existing handler', async (subcommand, mockName) => {
    await handleInfo(chat(null, subcommand));

    expect(mocks[mockName]).toHaveBeenCalledOnce();
  });

  it('replies ephemerally for an unknown action', async () => {
    const interaction = chat(null, 'unknown');

    await handleInfo(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: 64, content: 'Unknown information action.' }),
    );
  });
});
