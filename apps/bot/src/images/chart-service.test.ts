import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../players/service.js', () => ({
  loadPlayerHistory: vi.fn(),
  loadPlayerBattles: vi.fn(),
}));

vi.mock('../clubs/service.js', () => ({
  loadHistoryView: vi.fn(),
}));

vi.mock('./chart-render.js', () => ({
  renderChart: vi.fn(async () => ({
    png: Buffer.from('stored-chart-png'),
    width: 1200,
    height: 700,
  })),
}));

import { loadHistoryView } from '../clubs/service.js';
import { loadPlayerBattles, loadPlayerHistory } from '../players/service.js';
import { renderChart } from './chart-render.js';
import { loadOrRenderChart } from './chart-service.js';

type QueryResult = { readonly data: unknown[] | null; readonly error: { message: string } | null };

function chainable(result: QueryResult) {
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'gt', 'in', 'neq']) {
    query[method] = vi.fn(() => query);
  }
  query.limit = vi.fn(async () => result);
  return query;
}

function makeDb(cacheRows: unknown[] = []) {
  const insert = vi.fn(async (_row: Record<string, unknown>) => ({ error: null }));
  const db = {
    from: vi.fn((table: string) => {
      if (table === 'generated_images') {
        return { ...chainable({ data: cacheRows, error: null }), insert };
      }
      return chainable({ data: [], error: null });
    }),
  };
  return { db: db as never, insert, from: db.from };
}

const PLAYER_HISTORY = {
  kind: 'ok',
  value: {
    player: {
      id: 'player-1',
      tag: 'PLAYER1',
      name: 'Tester',
      trophies: 1000,
      highestTrophies: 1200,
      fame: 10,
      fameTierName: 'Bronze',
      totalPrestigeLevel: 2,
      threeVsThreeVictories: 3,
      soloVictories: 4,
      duoVictories: 5,
      rankedElo: 100,
      lastSyncedAt: '2026-11-22T10:00:00.000Z',
      lastBattleAt: '2026-11-22T09:00:00.000Z',
    },
    period: '30d',
    points: [{ capturedAt: '2026-11-20T10:00:00.000Z', trophies: 900 }],
    currentTrophies: 1000,
    highestRecordedTrophies: 1000,
    latestSnapshotAt: '2026-11-20T10:00:00.000Z',
  },
};

const PLAYER_BATTLES = {
  kind: 'ok',
  value: {
    player: PLAYER_HISTORY.value.player,
    period: '30d',
    battles: [
      {
        id: 'battle-1',
        battleTime: '2026-11-21T10:00:00.000Z',
        mode: 'showdown',
        map: 'Map',
        battleType: 'solo',
        result: 'victory',
        trophyChange: 8,
        brawlerName: 'Shelly',
        starPlayerName: null,
      },
    ],
    wins: 1,
    losses: 0,
    draws: 0,
    trophyChange: 8,
    topModes: [],
    firstBattleAt: '2026-11-21T10:00:00.000Z',
    latestBattleAt: '2026-11-21T10:00:00.000Z',
  },
};

describe('loadOrRenderChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadPlayerHistory).mockResolvedValue(PLAYER_HISTORY as never);
    vi.mocked(loadPlayerBattles).mockResolvedValue(PLAYER_BATTLES as never);
    vi.mocked(loadHistoryView).mockResolvedValue({ kind: 'no-default' } as never);
  });

  it('renders from stored loaders and caches a guild-scoped PNG', async () => {
    const { db, insert } = makeDb();
    const result = await loadOrRenderChart({
      db,
      guildId: 'guild-1',
      kind: 'player',
      tag: 'PLAYER1',
      option: 'trophies',
      period: '30d',
      now: new Date('2026-11-22T12:00:00.000Z'),
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.image.png.toString()).toBe('stored-chart-png');
    expect(renderChart).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row['guild_id']).toBe('guild-1');
    expect(row['subject_tag']).toBe('PLAYER1');
    expect(row['club_id']).toBeNull();
    expect(row['png_base64']).toBe(Buffer.from('stored-chart-png').toString('base64'));
  });

  it('reuses a matching cache row instead of rendering twice', async () => {
    const first = makeDb();
    const firstResult = await loadOrRenderChart({
      db: first.db,
      guildId: 'guild-1',
      kind: 'player',
      tag: 'PLAYER1',
      option: 'trophies',
      period: '30d',
      now: new Date('2026-11-22T12:00:00.000Z'),
    });
    expect(firstResult.kind).toBe('ok');
    if (firstResult.kind !== 'ok') return;

    const cachedRow = first.insert.mock.calls[0]?.[0] as Record<string, unknown>;
    const second = makeDb([
      {
        png_base64: cachedRow['png_base64'],
        expires_at: null,
        width: 1200,
        height: 700,
      },
    ]);
    const secondResult = await loadOrRenderChart({
      db: second.db,
      guildId: 'guild-1',
      kind: 'player',
      tag: 'PLAYER1',
      option: 'trophies',
      period: '30d',
      now: new Date('2026-11-22T12:00:00.000Z'),
    });

    expect(secondResult.kind).toBe('ok');
    expect(renderChart).toHaveBeenCalledTimes(1);
    expect(second.insert).not.toHaveBeenCalled();
  });

  it('maps a stored player lookup failure without calling the renderer', async () => {
    vi.mocked(loadPlayerHistory).mockResolvedValue({
      kind: 'not-found',
      tag: 'MISSING',
    } as never);
    const { db } = makeDb();
    const result = await loadOrRenderChart({
      db,
      guildId: 'guild-1',
      kind: 'player',
      tag: 'MISSING',
      option: 'trophies',
    });

    expect(result).toEqual({ kind: 'failure', failure: { kind: 'not-found', tag: 'MISSING' } });
    expect(renderChart).not.toHaveBeenCalled();
  });
});
