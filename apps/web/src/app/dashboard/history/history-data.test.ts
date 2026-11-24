import { describe, expect, it } from 'vitest';
import { mergeHistorySeries } from '@/components/charts/history-chart-data';
import { buildClubSeries, buildPlayerSeries } from './history-data';

const CLUBS = [
  { id: 'club-a', name: 'Alpha' },
  { id: 'club-b', name: 'Beta' },
];

describe('history series', () => {
  it('plots each club separately instead of summing snapshots at a shared timestamp', () => {
    const series = buildClubSeries(
      [
        { club_id: 'club-a', captured_at: '2026-11-20T10:00:00.000Z', trophies: 10_000 },
        { club_id: 'club-b', captured_at: '2026-11-20T10:00:00.000Z', trophies: 20_000 },
      ],
      CLUBS,
      (row) => row.trophies,
    );

    expect(series).toHaveLength(2);
    expect(series.map((item) => item.name)).toEqual(['Alpha', 'Beta']);
    expect(series[0]?.points).toEqual([
      {
        time: '2026-11-20T10:00:00.000Z',
        label: series[0]!.points[0]!.label,
        value: 10_000,
      },
    ]);
    expect(series[1]?.points[0]?.value).toBe(20_000);
  });

  it('lets the latest duplicate snapshot win instead of double-counting a club', () => {
    const series = buildClubSeries(
      [
        { club_id: 'club-a', captured_at: '2026-11-20T10:00:00.000Z', member_count: 10 },
        { club_id: 'club-a', captured_at: '2026-11-20T10:00:00.000Z', member_count: 12 },
      ],
      CLUBS,
      (row) => row.member_count,
    );

    expect(series).toHaveLength(1);
    expect(series[0]?.points).toHaveLength(1);
    expect(series[0]?.points[0]?.value).toBe(12);
  });

  it('only plots snapshots for the explicitly selected player', () => {
    const series = buildPlayerSeries(
      [
        { player_id: 'player-a', captured_at: '2026-11-20T10:00:00.000Z', trophies: 5_000 },
        { player_id: 'player-b', captured_at: '2026-11-20T10:00:00.000Z', trophies: 9_000 },
      ],
      { id: 'player-b', name: 'Bravo' },
    );

    expect(series).toHaveLength(1);
    expect(series[0]?.name).toBe('Bravo');
    expect(series[0]?.points[0]?.value).toBe(9_000);
  });

  it('aligns series by stored timestamp and leaves missing values empty', () => {
    const rows = mergeHistorySeries([
      {
        key: 'club-a',
        name: 'Alpha',
        color: '#fff',
        points: [
          { time: '2026-11-20T10:00:00.000Z', label: 'Nov 20, 10:00 AM', value: 100 },
          { time: '2026-11-21T10:00:00.000Z', label: 'Nov 21, 10:00 AM', value: 120 },
        ],
      },
      {
        key: 'club-b',
        name: 'Beta',
        color: '#000',
        points: [{ time: '2026-11-21T10:00:00.000Z', label: 'Nov 21, 10:00 AM', value: 200 }],
      },
    ]);

    expect(rows.map((row) => row.time)).toEqual([
      '2026-11-20T10:00:00.000Z',
      '2026-11-21T10:00:00.000Z',
    ]);
    expect(rows[0]).toMatchObject({ 'club-a': 100 });
    expect(rows[0]?.['club-b']).toBeUndefined();
    expect(rows[1]).toMatchObject({ 'club-a': 120, 'club-b': 200 });
  });
});
