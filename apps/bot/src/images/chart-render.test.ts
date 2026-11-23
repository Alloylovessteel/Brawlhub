import { describe, expect, it } from 'vitest';
import { isChartOption, renderChart } from './chart-render.js';

describe('chart renderer', () => {
  it('accepts only the declared chart options', () => {
    expect(isChartOption('monthly_activity')).toBe(true);
    expect(isChartOption('official_api')).toBe(false);
  });

  it('renders a PNG with the expected dimensions', async () => {
    const result = await renderChart({
      kind: 'player',
      subject: '#PLAYER1',
      title: 'Tester · trophies',
      subtitle: 'Stored player data',
      option: 'trophies',
      series: [
        { label: '2026-11-20', value: 900 },
        { label: '2026-11-21', value: 1000 },
      ],
      stats: [{ label: 'Trophies', value: '1,000' }],
      footer: 'Stored data only',
    });

    expect(result.width).toBe(1200);
    expect(result.height).toBe(700);
    expect(result.png.subarray(1, 4).toString()).toBe('PNG');
  });

  it('keeps a defensive empty-series state in the PNG renderer', async () => {
    const result = await renderChart({
      kind: 'player',
      subject: '#PLAYER1',
      title: 'Tester · trophies',
      subtitle: 'Stored player data',
      option: 'trophies',
      series: [],
      stats: [],
      footer: 'Stored data only',
    });

    expect(result.width).toBe(1200);
    expect(result.height).toBe(700);
    expect(result.png.subarray(1, 4).toString()).toBe('PNG');
  });
});
