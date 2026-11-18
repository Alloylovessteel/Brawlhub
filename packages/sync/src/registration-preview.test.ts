import { describe, expect, it, vi } from 'vitest';
import type { BrawlStarsClient } from '@brawlhub/brawl-stars';
import { previewClubRegistration } from './registration';

function clientReturning(value: unknown): BrawlStarsClient {
  return {
    getClub: vi.fn(async () => value as never),
    getClubMembers: vi.fn(async () => []),
    getPlayer: vi.fn(async () => ({}) as never),
  };
}

describe('previewClubRegistration', () => {
  it('normalises the tag and returns validated official club data', async () => {
    const client = clientReturning({
      tag: '2UG9',
      name: 'Alpha',
      description: 'A club',
      trophies: 12345,
      requiredTrophies: 10000,
      badgeId: 7,
      memberCount: 20,
    });

    const preview = await previewClubRegistration(' #2ug9 ', { client });

    expect(preview).toEqual({
      tag: '2UG9',
      name: 'Alpha',
      description: 'A club',
      trophies: 12345,
      memberCount: 20,
    });
    expect(client.getClub).toHaveBeenCalledWith('2UG9');
  });

  it('rejects invalid tags before calling the API', async () => {
    const client = clientReturning({});

    await expect(previewClubRegistration('bad tag!', { client })).rejects.toThrow('Invalid');
    expect(client.getClub).not.toHaveBeenCalled();
  });

  it('rejects malformed API responses', async () => {
    const client = clientReturning({ tag: '2UG9' });

    await expect(previewClubRegistration('2UG9', { client })).rejects.toThrow('malformed');
  });

  it('rejects a mismatched API tag', async () => {
    const client = clientReturning({ tag: 'OTHER', name: 'Wrong', trophies: 1 });

    await expect(previewClubRegistration('2UG9', { client })).rejects.toThrow('mismatched');
  });

  it('propagates API failures instead of returning empty data', async () => {
    const client: BrawlStarsClient = {
      getClub: vi.fn(async () => {
        throw new Error('official API unavailable');
      }),
      getClubMembers: vi.fn(async () => []),
      getPlayer: vi.fn(async () => ({}) as never),
    };

    await expect(previewClubRegistration('2UG9', { client })).rejects.toThrow('official API unavailable');
  });
});
