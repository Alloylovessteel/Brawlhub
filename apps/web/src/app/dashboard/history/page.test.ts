import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionMock = vi.hoisted(() => ({
  scope: ['club-a', 'club-b'] as string[] | null,
}));

vi.mock('@/lib/auth/session', () => ({
  requirePageSession: vi.fn(async () => ({})),
  getAccessibleReadClubIds: vi.fn(() => sessionMock.scope),
}));

const queryMock = vi.hoisted(() => ({
  getClubs: vi.fn(),
  getPlayers: vi.fn(),
  getAllClubSnapshots: vi.fn(),
  getAllPlayerSnapshots: vi.fn(),
  getSnapshotCollectionStart: vi.fn(),
}));

vi.mock('@/lib/data/queries', () => queryMock);

vi.mock('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
  formatDateTime: (value: string | null | undefined) => `formatted:${value ?? 'none'}`,
  formatDate: (value: string | null | undefined) => `date:${value ?? 'none'}`,
  formatNumber: (value: number | null | undefined) => String(value ?? 'none'),
  formatTag: (value: string) => `#${value}`,
}));

import { loadHistoryViewModel } from './history-view-model';

const CLUB_A = { id: 'club-a', name: 'Alpha' };
const CLUB_B = { id: 'club-b', name: 'Beta' };
const PLAYER_A = { id: 'player-a', name: 'Ann' };
const PLAYER_B = { id: 'player-b', name: 'Bo' };

function setQueries(): void {
  queryMock.getClubs.mockResolvedValue({ rows: [CLUB_A, CLUB_B], count: 2, error: null });
  queryMock.getPlayers.mockImplementation(async (input: { clubId?: string }) => ({
    rows: input.clubId === 'club-b' ? [PLAYER_B] : [PLAYER_A, PLAYER_B],
    count: 2,
    error: null,
  }));
  const clubSnapshots = [
    {
      id: 'cs-1',
      club_id: 'club-a',
      sync_run_id: 'run-1',
      captured_at: '2026-11-20T10:00:00.000Z',
      trophies: 10_000,
      member_count: 10,
      payload_hash: 'hash-1',
    },
    {
      id: 'cs-2',
      club_id: 'club-b',
      sync_run_id: 'run-1',
      captured_at: '2026-11-20T10:00:00.000Z',
      trophies: 20_000,
      member_count: 20,
      payload_hash: 'hash-2',
    },
  ];
  queryMock.getAllClubSnapshots.mockImplementation(
    async (_days: number | undefined, options: { clubIds?: string[] }) => ({
      rows:
        options.clubIds === undefined
          ? clubSnapshots
          : clubSnapshots.filter((row) => options.clubIds!.includes(row.club_id)),
      count: clubSnapshots.length,
      error: null,
    }),
  );
  queryMock.getAllPlayerSnapshots.mockResolvedValue({
    rows: [
      {
        id: 'ps-1',
        player_id: 'player-a',
        sync_run_id: 'run-1',
        captured_at: '2026-11-20T10:00:00.000Z',
        trophies: 5_000,
        payload_hash: 'hash-3',
      },
    ],
    count: 1,
    error: null,
  });
  queryMock.getSnapshotCollectionStart.mockResolvedValue({
    capturedAt: '2026-01-01T00:00:00.000Z',
    error: null,
  });
}

describe('history view model', () => {
  beforeEach(() => {
    sessionMock.scope = ['club-a', 'club-b'];
    for (const mock of Object.values(queryMock)) mock.mockClear();
    setQueries();
  });

  it('pushes the selected club and player into the snapshot queries', async () => {
    const model = await loadHistoryViewModel({
      range: '7',
      club: 'club-a',
      player: 'player-a',
    });

    expect(queryMock.getPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ clubId: 'club-a', allowedClubIds: ['club-a', 'club-b'] }),
    );
    expect(queryMock.getAllClubSnapshots).toHaveBeenCalledWith(7, { clubIds: ['club-a'] });
    expect(queryMock.getAllPlayerSnapshots).toHaveBeenCalledWith(7, {
      clubIds: ['club-a'],
      playerIds: ['player-a'],
    });
    expect(queryMock.getSnapshotCollectionStart).toHaveBeenCalledWith({
      clubIds: ['club-a', 'club-b'],
    });
    expect(model.clubTrophySeries.map((series) => series.name)).toEqual(['Alpha']);
    expect(model.playerTrophySeries[0]?.points[0]?.value).toBe(5_000);
    expect(model.collectionStart).toBe('2026-01-01T00:00:00.000Z');
  });

  it('plots all clubs as separate series and uses the unrestricted collection start', async () => {
    sessionMock.scope = null;

    const model = await loadHistoryViewModel({
      range: '7',
      club: 'unauthorized',
      player: 'player-a',
    });

    expect(queryMock.getAllClubSnapshots).toHaveBeenCalledWith(7, {});
    expect(queryMock.getSnapshotCollectionStart).toHaveBeenCalledWith({});
    expect(model.clubTrophySeries.map((series) => series.name)).toEqual(['Alpha', 'Beta']);
    expect(model.clubTrophySeries.map((series) => series.points[0]?.value)).toEqual([
      10_000, 20_000,
    ]);
  });
});
