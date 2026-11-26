import { describe, expect, it } from 'vitest';
import type { SyncNotificationInput } from '@brawlhub/sync';
import { buildClubMembershipNoticeContent } from './notifier';

function input(overrides: Partial<SyncNotificationInput> = {}): SyncNotificationInput {
  return {
    eventId: 'event-1',
    eventType: 'leave',
    playerTag: '2QGGRYQQRR',
    playerName: 'gynophobe',
    clubName: 'Kuromi Nek',
    fromClubName: 'Kuromi Nek',
    toClubName: undefined,
    occurredAt: '2026-11-23T23:18:00.000Z',
    remainingMembers: 29,
    ...overrides,
  };
}

describe('buildClubMembershipNoticeContent', () => {
  it('states the player name and club name as plain text', () => {
    expect(buildClubMembershipNoticeContent(input())).toBe('gynophobe left Kuromi Nek');
  });

  it('formats joins and transfers the same way', () => {
    const join = buildClubMembershipNoticeContent(
      input({ eventType: 'join', fromClubName: undefined }),
    );
    expect(join).toBe('gynophobe joined Kuromi Nek');

    const transfer = buildClubMembershipNoticeContent(
      input({
        eventType: 'transfer',
        fromClubName: 'Kuromi Nek',
        toClubName: 'Kuromi Krew',
      }),
    );
    expect(transfer).toBe('gynophobe transferred from Kuromi Nek to Kuromi Krew');
  });

  it('strips mention syntax from names', () => {
    const content = buildClubMembershipNoticeContent(
      input({ eventType: 'join', playerName: '<@everyone> gynophobe', clubName: '<#123> Kuromi Nek' }),
    );

    expect(content).toBe('gynophobe joined Kuromi Nek');
    expect(content).not.toContain('<@');
    expect(content).not.toContain('<#');
  });

  it('falls back to the player tag and a generic club name when data is missing', () => {
    const content = buildClubMembershipNoticeContent(
      input({ eventType: 'join', playerName: '', playerTag: 'YQPQ0Q2CL', clubName: '' }),
    );

    expect(content).toBe('#YQPQ0Q2CL joined the club');
  });
});
