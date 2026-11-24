import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  buildClubLogDigestImage,
  buildClubLogEventImage,
  buildClubLogPageImage,
} from './image';
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

describe('buildClubLogDigestImage', () => {
  it('renders trophy progression without a changes section', async () => {
    const image = await buildClubLogDigestImage(view(), 'Daily');

    expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const metadata = await sharp(image).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBeGreaterThanOrEqual(620);
    expect(metadata.height).toBeLessThan(820);
  });

  it('renders an empty digest without failing', async () => {
    const image = await buildClubLogDigestImage(
      view({ rows: [], unavailable: 0, latestSnapshotAt: null, latestSyncAt: null }),
    );

    const metadata = await sharp(image).metadata();
    expect(metadata.format).toBe('png');
  });

  it('renders a full 30-member digest with zero changes', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      rank: index + 1,
      member: {
        tag: `PLAYER${index + 1}`,
        name: `Player ${index + 1}`,
        trophies: 50_000 - index,
        role: 'member',
        playerId: `player-${index + 1}`,
        highestTrophies: null,
      },
      change: 0,
    }));

    const image = await buildClubLogDigestImage(view({ rows, unavailable: 30 }), 'Daily');
    const metadata = await sharp(image).metadata();

    expect(metadata.format).toBe('png');
    expect(metadata.height).toBeGreaterThan(1_400);
  });
});

describe('buildClubLogEventImage', () => {
  it('renders membership, role and capacity changes without trophy rows', async () => {
    const image = await buildClubLogEventImage({ name: 'Alpha Club', tag: 'ALPHA' }, [
      event(),
      event({
        id: 'event-2',
        kind: 'role',
        description: '#PLAYER3 role changed Member → Senior',
      }),
      event({ id: 'event-3', kind: 'capacity', description: 'Club open (28/30)' }),
    ]);

    expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const metadata = await sharp(image).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBeGreaterThanOrEqual(620);
  });

  it('renders an empty event log and strips mention syntax', async () => {
    const image = await buildClubLogEventImage(
      { name: 'Alpha & <Club>', tag: 'ALPHA' },
      [event({ description: '<@everyone> joined & left' })],
    );

    const metadata = await sharp(image).metadata();
    expect(metadata.format).toBe('png');
  });
});
