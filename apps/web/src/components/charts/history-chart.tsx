'use client';

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  mergeHistorySeries,
  type HistoryPoint,
  type HistorySeries,
} from './history-chart-data';

export type { HistoryPoint, HistorySeries } from './history-chart-data';

export function HistoryChart({
  data,
  series,
  valueLabel,
  color = '#7c96ff',
}: {
  /** Legacy single-series input. Prefer `series` for comparisons. */
  data?: HistoryPoint[];
  series?: readonly HistorySeries[];
  valueLabel: string;
  color?: string;
}) {
  const resolvedSeries: HistorySeries[] =
    series !== undefined && series.length > 0
      ? [...series]
      : [
          {
            key: 'value',
            name: valueLabel,
            color,
            points: (data ?? []).map((point) => ({
              ...point,
              time: point.label,
            })),
          },
        ];
  const chartData = mergeHistorySeries(resolvedSeries);

  return (
    <div
      className="h-64 w-full"
      aria-label={`${valueLabel} history chart: ${resolvedSeries.map((item) => item.name).join(', ')}`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#243149" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: '#94a3b8', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: '#243149' }}
            minTickGap={28}
          />
          <YAxis
            tick={{ fill: '#94a3b8', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={64}
            tickFormatter={(value: number) =>
              new Intl.NumberFormat('en-US', { notation: 'compact' }).format(value)
            }
          />
          <Tooltip
            contentStyle={{
              background: '#111827',
              border: '1px solid #243149',
              borderRadius: 10,
              color: '#e8eefc',
              fontSize: 12,
            }}
            labelStyle={{ color: '#94a3b8' }}
            formatter={(value: unknown, name: unknown) => [
              value === null || value === undefined || value === ''
                ? '—'
                : new Intl.NumberFormat('en-US').format(Number(value)),
              typeof name === 'string' && name.length > 0 ? name : valueLabel,
            ]}
          />
          {resolvedSeries.length > 1 ? (
            <Legend
              wrapperStyle={{ color: '#94a3b8', fontSize: 11, paddingTop: 4 }}
              iconType="plainline"
            />
          ) : null}
          {resolvedSeries.map((item) => (
            <Line
              key={item.key}
              type="linear"
              dataKey={item.key}
              name={item.name}
              stroke={item.color}
              strokeWidth={2.5}
              dot={{ r: 3, fill: item.color }}
              activeDot={{ r: 5 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
