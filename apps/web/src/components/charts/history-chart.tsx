'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface HistoryPoint {
  label: string;
  value: number;
}

export function HistoryChart({
  data,
  valueLabel,
  color = '#7c96ff',
}: {
  data: HistoryPoint[];
  valueLabel: string;
  color?: string;
}) {
  return (
    <div className="h-64 w-full" aria-label={`${valueLabel} history chart`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
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
            tickFormatter={(value: number) => new Intl.NumberFormat('en-US', { notation: 'compact' }).format(value)}
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
            formatter={(value: unknown) => [
              new Intl.NumberFormat('en-US').format(Number(value)),
              valueLabel,
            ]}
          />
          <Line
            type="linear"
            dataKey="value"
            stroke={color}
            strokeWidth={2.5}
            dot={{ r: 3, fill: color }}
            activeDot={{ r: 5 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
