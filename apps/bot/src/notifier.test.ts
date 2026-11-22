import { describe, expect, it } from 'vitest';
import type { SyncNotificationInput } from '@brawlhub/sync';
import { buildClubMembershipNoticeEmbed } from './notifier';

function input(overrides: Partial<SyncNotificationInput> = {}): SyncNotificationInput {
  return {
    eventId: 'event-1',
    eventType: 'leave',
    playerTag: '2QGGRYQQRR',
    playerName: 'gynophobe',
    clubName: 'Kuromi Nek',
    fromClubName: 'Kuromi Nek',
    toClubName: undefined,
    ...overrides,
  };
}

describe('buildClubMembershipNoticeEmbed', () => {
  it('uses Unicode detail lines for a club leave', () => {
    const json = buildClubMembershipNoticeEmbed(input()).toJSON();

    expect(json.title).toBe('👥 Club membership update');
    expect(json.description).toBe(
      '🏷️ gynophobe (`2QGGRYQQRR`)\n📝 left **Kuromi Nek**.',
    );
  });

  it('formats joins and transfers the same way', () => {
    const join = buildClubMembershipNoticeEmbed(
      input({ eventType: 'join', fromClubName: undefined }),
    ).toJSON();
    expect(join.description).toContain('📝 joined **Kuromi Nek**.');

    const transfer = buildClubMembershipNoticeEmbed(
      input({
        eventType: 'transfer',
        fromClubName: 'Kuromi Nek',
        toClubName: 'Kuromi Krew',
      }),
    ).toJSON();
    expect(transfer.description).toContain(
      '📝 transferred from **Kuromi Nek** to **Kuromi Krew**.',
    );
  });

  it('strips mention syntax from names', () => {
    const json = buildClubMembershipNoticeEmbed(
      input({ playerName: '<@everyone> gynophobe', clubName: '<#123> Kuromi Nek' }),
    ).toJSON();

    expect(json.description).not.toContain('<@');
    expect(json.description).not.toContain('<#');
    expect(json.description).toContain('gynophobe');
  });
});
