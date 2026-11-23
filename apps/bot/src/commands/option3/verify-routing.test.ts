import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

const mocks = vi.hoisted(() => ({
  handleAccounts: vi.fn(async () => undefined),
  handleFind: vi.fn(async () => undefined),
  handleMemberVerify: vi.fn(async () => undefined),
  handleUnverifyOne: vi.fn(async () => undefined),
  handleVerifyInfo: vi.fn(async () => undefined),
  handleVerifySettings: vi.fn(async () => undefined),
  handleRegisterList: vi.fn(async () => undefined),
  handleTag: vi.fn(async () => undefined),
  handleUnverifyAll: vi.fn(async () => undefined),
  handleDeleteMe: vi.fn(async () => undefined),
  handleSettings: vi.fn(async () => undefined),
}));

vi.mock('../accounts.js', async (importActual) => ({
  ...(await importActual<typeof import('../accounts.js')>()),
  handleAccounts: mocks.handleAccounts,
}));
vi.mock('../admin-identity.js', async (importActual) => ({
  ...(await importActual<typeof import('../admin-identity.js')>()),
  handleFind: mocks.handleFind,
  handleRegisterList: mocks.handleRegisterList,
  handleTag: mocks.handleTag,
  handleUnverifyAll: mocks.handleUnverifyAll,
  handleUnverifyOne: mocks.handleUnverifyOne,
}));
vi.mock('../delete-me.js', async (importActual) => ({
  ...(await importActual<typeof import('../delete-me.js')>()),
  handleDeleteMe: mocks.handleDeleteMe,
}));
vi.mock('../member-verify.js', () => ({ handleMemberVerify: mocks.handleMemberVerify }));
vi.mock('../settings.js', () => ({ handleSettings: mocks.handleSettings }));
vi.mock('../verification-info.js', async (importActual) => ({
  ...(await importActual<typeof import('../verification-info.js')>()),
  handleVerifyInfo: mocks.handleVerifyInfo,
  handleVerifySettings: mocks.handleVerifySettings,
}));

import { handleVerifyAnchor } from './verify-anchor';

function chat(group: string | null, subcommand: string | null): ChatInputCommandInteraction {
  return {
    options: {
      getSubcommandGroup: vi.fn(() => group),
      getSubcommand: vi.fn(() => subcommand),
    },
    reply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
});

describe('/verify routing', () => {
  it('routes grouped find tag to the staff lookup handler', async () => {
    await handleVerifyAnchor(chat('find', 'tag'));

    expect(mocks.handleFind).toHaveBeenCalledOnce();
    expect(mocks.handleMemberVerify).not.toHaveBeenCalled();
  });

  it('routes grouped unverify-one tag to the staff revoke handler', async () => {
    await handleVerifyAnchor(chat('unverify-one', 'tag'));

    expect(mocks.handleUnverifyOne).toHaveBeenCalledOnce();
    expect(mocks.handleMemberVerify).not.toHaveBeenCalled();
  });

  it('routes top-level tag to the personal verification handler', async () => {
    await handleVerifyAnchor(chat(null, 'tag'));

    expect(mocks.handleMemberVerify).toHaveBeenCalledOnce();
    expect(mocks.handleFind).not.toHaveBeenCalled();
  });
});
