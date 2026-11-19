import { describe, expect, it, vi } from 'vitest';
import type { BrawlStarsClient } from '@brawlhub/brawl-stars';

const fake = vi.hoisted(() => ({
  existing: null as { id: string; tag: string; name: string } | null,
}));

vi.mock('@brawlhub/database', () => ({
  createTrustedClient: () => ({
    from: (table: string) => {
      if (table !== 'clubs') {
        throw new Error(`Unexpected table: ${table}`);
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: fake.existing, error: null }),
            }),
          }),
        }),
      };
    },
  }),
}));

import { previewClubRegistration } from './registration';

const GUILD_ID = '1488531664962326571';

function clientReturning(value: unknown): BrawlStarsClient {
  return {
    getClub: vi.fn(async () => value as never),
    getClubMembers: vi.fn(async () => []),
    getPlayer: vi.fn(async () => ({}) as never),
    getBattleLog: vi.fn(async () => []),
    getBrawlers: vi.fn(async () => []),
    getEventRotation: vi.fn(async () => []),
  };
}

describe('previewClubRegistration', () => {
  it('normalises the tag and returns validated official club data', async () => {
    fake.existing = null;
    const client = clientReturning({
      tag: '2UG9',
      name: 'Alpha',
      description: 'A club',
      trophies: 12345,
      requiredTrophies: 10000,
      badgeId: 7,
      memberCount: 20,
    });

    const preview = await previewClubRegistration(' #2ug9 ', GUILD_ID, { client });

    expect(preview).toEqual({
      tag: '2UG9',
      name: 'Alpha',
      description: 'A club',
      trophies: 12345,
      memberCount: 20,
      guildId: GUILD_ID,
    });
    expect(client.getClub).toHaveBeenCalledWith('2UG9');
  });

  it('rejects invalid tags before calling the API', async () => {
    fake.existing = null;
    const client = clientReturning({});

    await expect(previewClubRegistration('bad tag!', GUILD_ID, { client })).rejects.toThrow(
      'Invalid',
    );
    expect(client.getClub).not.toHaveBeenCalled();
  });

  it('rejects malformed API responses', async () => {
    fake.existing = null;
    const client = clientReturning({ tag: '2UG9' });

    await expect(previewClubRegistration('2UG9', GUILD_ID, { client })).rejects.toThrow(
      /could not be validated/i,
    );
  });

  it('rejects a mismatched API tag', async () => {
    fake.existing = null;
    const client = clientReturning({ tag: 'OTHER', name: 'Wrong', trophies: 1 });

    await expect(previewClubRegistration('2UG9', GUILD_ID, { client })).rejects.toThrow(
      'mismatched',
    );
  });

  it('propagates API failures instead of returning empty data', async () => {
    fake.existing = null;
    const client: BrawlStarsClient = {
      getClub: vi.fn(async () => {
        throw new Error('official API unavailable');
      }),
      getClubMembers: vi.fn(async () => []),
      getPlayer: vi.fn(async () => ({}) as never),
      getBattleLog: vi.fn(async () => []),
      getBrawlers: vi.fn(async () => []),
      getEventRotation: vi.fn(async () => []),
    };

    await expect(previewClubRegistration('2UG9', GUILD_ID, { client })).rejects.toThrow(
      'official API unavailable',
    );
  });
});
