import type { ClubRow, PlayerRow } from '@/lib/data/types';
import {
  seriesColor,
  type HistorySeries,
} from '@/components/charts/history-chart-data';
import { formatDateTime } from '@/lib/utils';

interface ClubSnapshotLike {
  club_id: string;
  captured_at: string;
}

/**
 * Builds one line per club instead of summing unrelated clubs at a shared
 * timestamp. When several snapshots share a club and timestamp, the last one
 * in the ordered query wins rather than double-counting it.
 */
export function buildClubSeries<Row extends ClubSnapshotLike>(
  rows: readonly Row[],
  clubs: readonly Pick<ClubRow, 'id' | 'name'>[],
  value: (row: Row) => number | null,
): HistorySeries[] {
  const byClub = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const numeric = value(row);
    if (numeric === null || !Number.isFinite(numeric)) continue;
    if (Number.isNaN(Date.parse(row.captured_at))) continue;
    let byTime = byClub.get(row.club_id);
    if (byTime === undefined) {
      byTime = new Map();
      byClub.set(row.club_id, byTime);
    }
    byTime.set(row.captured_at, numeric);
  }

  const knownIds = clubs.map((club) => club.id);
  const known = new Set(knownIds);
  const unknownIds = [...byClub.keys()].filter((id) => !known.has(id)).sort();
  const orderedIds = [...knownIds, ...unknownIds].filter((id) => byClub.has(id));
  const names = new Map(clubs.map((club) => [club.id, club.name]));

  return orderedIds.map((clubId, index) => ({
    key: `series-${index}`,
    name: names.get(clubId) ?? 'Unrecorded club',
    color: seriesColor(index),
    points: [...byClub.get(clubId)!.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([time, numeric]) => ({ time, label: formatDateTime(time), value: numeric })),
  }));
}

/** Builds a single real-snapshot line for the explicitly selected player. */
export function buildPlayerSeries(
  rows: ReadonlyArray<{ player_id: string; captured_at: string; trophies: number | null }>,
  player: Pick<PlayerRow, 'id' | 'name'> | undefined,
): HistorySeries[] {
  if (player === undefined) return [];
  const byTime = new Map<string, number>();
  for (const row of rows) {
    if (row.player_id !== player.id) continue;
    if (row.trophies === null || !Number.isFinite(row.trophies)) continue;
    if (Number.isNaN(Date.parse(row.captured_at))) continue;
    byTime.set(row.captured_at, row.trophies);
  }
  if (byTime.size === 0) return [];
  return [
    {
      key: 'player',
      name: player.name,
      color: '#fbbf24',
      points: [...byTime.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([time, value]) => ({ time, label: formatDateTime(time), value })),
    },
  ];
}
