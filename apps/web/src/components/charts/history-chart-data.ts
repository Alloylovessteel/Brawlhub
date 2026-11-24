export interface HistoryPoint {
  label: string;
  value: number | null;
}

export interface HistorySeriesPoint extends HistoryPoint {
  /** Original ISO timestamp, used to align and sort series without parsing labels. */
  time: string;
}

export interface HistorySeries {
  key: string;
  name: string;
  color: string;
  points: HistorySeriesPoint[];
}

export interface HistoryChartRow {
  time: string;
  label: string;
  [seriesKey: string]: string | number | null;
}

const PALETTE = [
  '#7c96ff',
  '#34d399',
  '#fbbf24',
  '#f472b6',
  '#22d3ee',
  '#a78bfa',
  '#fb923c',
  '#4ade80',
] as const;

export function seriesColor(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}

/** Aligns series on their original timestamps, leaving gaps empty. */
export function mergeHistorySeries(series: readonly HistorySeries[]): HistoryChartRow[] {
  const rows = new Map<string, HistoryChartRow>();
  for (const item of series) {
    for (const point of item.points) {
      let row = rows.get(point.time);
      if (row === undefined) {
        row = { time: point.time, label: point.label };
        rows.set(point.time, row);
      }
      row[item.key] = point.value;
    }
  }
  return [...rows.values()].sort((a, b) => a.time.localeCompare(b.time));
}
