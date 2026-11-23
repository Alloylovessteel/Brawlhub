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

const WHEN = '23:18 UTC, 23 Nov 2026';

describe('buildClubMembershipNoticeContent', () => {
  it('states the leave time/date and remaining members as plain text', () => {
    expect(buildClubMembershipNoticeContent(input())).toBe(
      `gynophobe (#2QGGRYQQRR) left the club at ${WHEN}\nremaining members: 29`,
    );
  });

  it('formats joins and transfers the same way', () => {
    const join = buildClubMembershipNoticeContent(
      input({ eventType: 'join', fromClubName: undefined }),
    );
    expect(join).toContain(`gynophobe (#2QGGRYQQRR) joined the club at ${WHEN}`);

    const transfer = buildClubMembershipNoticeContent(
      input({
        eventType: 'transfer',
        fromClubName: 'Kuromi Nek',
        toClubName: 'Kuromi Krew',
      }),
    );
    expect(transfer).toContain(
      `gynophobe (#2QGGRYQQRR) transferred from Kuromi Nek to Kuromi Krew at ${WHEN}`,
    );
    expect(transfer).toContain('remaining members: 29');
  });

  it('strips mention syntax from names', () => {
    const content = buildClubMembershipNoticeContent(
      input({ playerName: '<@everyone> gynophobe', clubName: '<#123> Kuromi Nek' }),
    );

    expect(content).not.toContain('<@');
    expect(content).not.toContain('<#');
    expect(content).toContain('gynophobe');
  });
});
