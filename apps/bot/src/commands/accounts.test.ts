import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { mdBold, mdCode } from '../discord/embed-format';

const mocks = vi.hoisted(() => ({
  listLinkedAccounts: vi.fn(),
  setMainVerification: vi.fn(),
}));

vi.mock('../verification/index', () => mocks);

import { handleAccounts, handleAccountsAutocomplete } from './accounts';

const accounts = [
  {
    verificationId: 'v-alt',
    tag: '2UG9UGQJY',
    name: 'Alt Player',
    isMain: false,
    method: 'api_snapshot',
    verifiedAt: '2026-11-20T00:00:00.000Z',
  },
  {
    verificationId: 'v-main',
    tag: 'YQPQ0Q2CL',
    name: 'Alloylovessteel',
    isMain: true,
    method: 'api_snapshot',
    verifiedAt: '2026-11-19T00:00:00.000Z',
  },
];

function interaction(options: Record<string, unknown> = {}): ChatInputCommandInteraction {
  return {
    user: { id: '983248496884875286' },
    options: {
      getSubcommand: vi.fn(() => options['subcommand'] ?? 'list'),
      getString: vi.fn((name: string) => options[name] ?? null),
    },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function editPayload(mockInteraction: ChatInputCommandInteraction): any {
  return (mockInteraction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
}

beforeEach(() => {
  mocks.listLinkedAccounts.mockReset().mockResolvedValue(accounts);
  mocks.setMainVerification.mockReset().mockResolvedValue({ kind: 'ok', tag: '2UG9UGQJY' });
});

describe('/verify accounts', () => {
  it('lists accounts with MAIN and Alt labels', async () => {
    const mockInteraction = interaction();

    await handleAccounts(mockInteraction);

    const payload = editPayload(mockInteraction);
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain(
      `${mdBold('MAIN')} — Alloylovessteel (${mdCode('#YQPQ0Q2CL')})`,
    );
    expect(description).toContain(`Alt — Alt Player (${mdCode('#2UG9UGQJY')})`);
    expect(mocks.listLinkedAccounts).toHaveBeenCalledWith('983248496884875286');
  });

  it('sets the chosen account as main', async () => {
    mocks.listLinkedAccounts
      .mockResolvedValueOnce(accounts)
      .mockResolvedValueOnce(accounts.map((account) => ({ ...account, isMain: !account.isMain })));
    const mockInteraction = interaction({ subcommand: 'set-main', tag: '2UG9UGQJY' });

    await handleAccounts(mockInteraction);

    expect(mocks.setMainVerification).toHaveBeenCalledWith('983248496884875286', '2UG9UGQJY');
    expect(editPayload(mockInteraction).content).toContain('Main account set to #2UG9UGQJY');
  });
});

describe('/verify accounts autocomplete', () => {
  it('offers only the caller’s linked accounts', async () => {
    const respond = vi.fn(async () => undefined);
    const mockInteraction = {
      user: { id: '983248496884875286' },
      options: { getFocused: vi.fn(() => ({ name: 'tag', value: '2UG' })) },
      respond,
    } as unknown as AutocompleteInteraction;

    await handleAccountsAutocomplete(mockInteraction);

    expect(respond).toHaveBeenCalledWith([
      { name: 'Alt — Alt Player (#2UG9UGQJY)', value: '2UG9UGQJY' },
    ]);
  });
});
