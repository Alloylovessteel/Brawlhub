import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { buildClubLogPageImage } from './image';
import type { ClubLogView } from '../types';
import type { ClubLogEvent } from './types';

vi.setConfig({ testTimeout: 20_000 });

function view(overrides: Partial<ClubLogView> = {}): ClubLogView {
  return {
    club: {
      id: 'club-1',
      tag: 'ALPHA',
      name: 'Alpha Club',
      description: null,
      trophies: 100_000,
      requiredTrophies: 30_000,
      memberCount: 30,
      lastSyncedAt: '2026-11-21T08:00:00.000Z',
    },
    period: 'today',
    rows: [
      {
        rank: 1,
        member: {
          tag: 'PLAYER1',
          name: 'Kuromi Blaze',
          trophies: 60_000,
          role: 'senior',
          playerId: 'player-1',
          highestTrophies: 65_000,
        },
        change: 1_250,
      },
      {
        rank: 2,
        member: {
          tag: 'PLAYER2',
          name: 'Night Owl',
          trophies: 55_000,
          role: 'member',
          playerId: 'player-2',
          highestTrophies: 58_000,
        },
        change: -45,
      },
    ],
    unavailable: 1,
    latestSnapshotAt: '2026-11-21T08:00:00.000Z',
    latestSyncAt: '2026-11-21T08:05:00.000Z',
    ...overrides,
  };
}

function event(overrides: Partial<ClubLogEvent> = {}): ClubLogEvent {
  return {
    kind: 'membership',
    id: 'event-1',
    clubId: 'club-1',
    playerTag: 'PLAYER3',
    playerName: 'New Member',
    description: '#PLAYER3 joined the club',
    detectedAt: '2026-11-21T07:30:00.000Z',
    ...overrides,
  };
}

describe('buildClubLogPageImage', () => {
  it('renders the trophy page and recent changes as one long PNG', async () => {
    const image = await buildClubLogPageImage(view(), [event()]);

    expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const metadata = await sharp(image).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBeGreaterThan(720);
    expect(metadata.height).toBeLessThan(1_500);
  });

  it('renders an empty stored page without failing', async () => {
    const image = await buildClubLogPageImage(
      view({ rows: [], unavailable: 0, latestSnapshotAt: null, latestSyncAt: null }),
      [],
    );

    const metadata = await sharp(image).metadata();
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBeGreaterThanOrEqual(760);
  });

  it('escapes XML characters and strips injected mention syntax', async () => {
    const image = await buildClubLogPageImage(
      view({
        club: { ...view().club, name: 'Alpha & <Club> "Kuromi" \'Gang\'' },
        rows: [
          {
            rank: 1,
            member: {
              tag: 'P&<1',
              name: '<@everyone> & "O\'Neil"',
              trophies: 10_000,
              role: 'vice_president',
              playerId: null,
              highestTrophies: null,
            },
            change: 0,
          },
        ],
      }),
      [event({ description: '<@123456789012345678> joined & left' })],
    );

    const metadata = await sharp(image).metadata();
    expect(metadata.format).toBe('png');
  });
});
