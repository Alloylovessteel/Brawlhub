import sharp from 'sharp';

/**
 * Sharp/SVG chart renderer. It receives an already-built data model; it never
 * reads Discord or the official Brawl Stars API. All values are stored-data
 * derived and supplied by the chart service.
 */

export type ChartOption =
  | 'trophies'
  | 'mastery'
  | 'fame'
  | 'record'
  | 'activity'
  | 'monthly_activity'
  | 'vs_wins'
  | 'solo_wins'
  | 'duo_wins';

export const CHART_OPTIONS: readonly ChartOption[] = [
  'trophies',
  'mastery',
  'fame',
  'record',
  'activity',
  'monthly_activity',
  'vs_wins',
  'solo_wins',
  'duo_wins',
];

export function isChartOption(value: string): value is ChartOption {
  return CHART_OPTIONS.some((option) => option === value);
}

export interface ChartDatum {
  readonly label: string;
  readonly value: number;
}

export interface ChartStat {
  readonly label: string;
  readonly value: string;
}

export interface ChartModel {
  readonly kind: 'player' | 'club';
  readonly subject: string;
  readonly title: string;
  readonly subtitle: string;
  readonly option: ChartOption;
  readonly series: readonly ChartDatum[];
  readonly stats: readonly ChartStat[];
  readonly footer: string;
}

export interface RenderedChart {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
}

const WIDTH = 1200;
const HEIGHT = 700;
const PLOT_X = 96;
const PLOT_Y = 300;
const PLOT_WIDTH = 1008;
const PLOT_HEIGHT = 300;
const MAX_INPUT_PIXELS = 24_000_000;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function clean(value: string, maxLength: number, fallback = '—'): string {
  const sanitized = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(sanitized);
  const clipped =
    characters.length <= maxLength ? sanitized : `${characters.slice(0, maxLength - 1).join('')}…`;
  return escapeXml(clipped === '' ? fallback : clipped);
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (absolute >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return new Intl.NumberFormat('en-US').format(Math.trunc(value));
}

function useLineChart(model: ChartModel): boolean {
  return (
    model.series.length > 1 &&
    ['trophies', 'fame', 'activity', 'monthly_activity'].includes(model.option)
  );
}

function gridMarkup(max: number): string {
  return [0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => {
      const y = PLOT_Y + PLOT_HEIGHT * (1 - fraction);
      const value = Math.round(max * fraction);
      return `<line x1="${PLOT_X}" y1="${y}" x2="${PLOT_X + PLOT_WIDTH}" y2="${y}" stroke="#ffffff" stroke-opacity="0.08"/>
        <text x="${PLOT_X - 16}" y="${y + 5}" text-anchor="end" font-size="13" fill="#8e88bd">${compactNumber(value)}</text>`;
    })
    .join('');
}

function labelMarkup(series: readonly ChartDatum[]): string {
  const step = Math.max(1, Math.ceil(series.length / 6));
  return series
    .map((datum, index) => ({ datum, index }))
    .filter(({ index }) => index % step === 0 || index === series.length - 1)
    .map(({ datum, index }) => {
      const x = PLOT_X + (series.length === 1 ? PLOT_WIDTH / 2 : (PLOT_WIDTH * index) / (series.length - 1));
      return `<text x="${x}" y="${PLOT_Y + PLOT_HEIGHT + 30}" text-anchor="middle" font-size="12" fill="#8e88bd">${clean(datum.label, 14)}</text>`;
    })
    .join('');
}

function lineMarkup(series: readonly ChartDatum[], max: number): string {
  const points = series.map((datum, index) => ({
    x: PLOT_X + (series.length === 1 ? PLOT_WIDTH / 2 : (PLOT_WIDTH * index) / (series.length - 1)),
    y: PLOT_Y + PLOT_HEIGHT - (max === 0 ? 0 : (PLOT_HEIGHT * datum.value) / max),
    datum,
  }));
  const path = points.map((point) => `${point.x},${point.y}`).join(' ');
  return `<polyline points="${path}" fill="none" stroke="#46d6ff" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>
    ${points
      .map(
        (point) =>
          `<circle cx="${point.x}" cy="${point.y}" r="5" fill="#8f82ff" stroke="#f7f6ff" stroke-opacity="0.8" stroke-width="2"><title>${clean(point.datum.label, 24)}: ${compactNumber(point.datum.value)}</title></circle>`,
      )
      .join('')}`;
}

function barMarkup(series: readonly ChartDatum[], max: number): string {
  const slot = PLOT_WIDTH / Math.max(series.length, 1);
  const barWidth = Math.max(8, Math.min(72, slot * 0.6));
  return series
    .map((datum, index) => {
      const height = max === 0 ? 0 : (PLOT_HEIGHT * Math.max(0, datum.value)) / max;
      const x = PLOT_X + slot * index + (slot - barWidth) / 2;
      const y = PLOT_Y + PLOT_HEIGHT - height;
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${Math.max(height, 2)}" rx="8" fill="url(#bar)">
        <title>${clean(datum.label, 24)}: ${compactNumber(datum.value)}</title>
      </rect>
      <text x="${x + barWidth / 2}" y="${y - 10}" text-anchor="middle" font-size="13" font-weight="700" fill="#f7f6ff">${compactNumber(datum.value)}</text>`;
    })
    .join('');
}

function statMarkup(stats: readonly ChartStat[]): string {
  const shown = stats.slice(0, 4);
  if (shown.length === 0) return '';
  const width = 262;
  const gap = 16;
  const totalWidth = shown.length * width + (shown.length - 1) * gap;
  const startX = (WIDTH - totalWidth) / 2;
  return shown
    .map(
      (stat, index) => `<rect x="${startX + index * (width + gap)}" y="146" width="${width}" height="78" rx="18" fill="#ffffff" fill-opacity="0.055" stroke="#ffffff" stroke-opacity="0.09"/>
        <text x="${startX + index * (width + gap) + 20}" y="174" font-size="13" font-weight="700" letter-spacing="1.6" fill="#8f82ff">${clean(stat.label.toUpperCase(), 22)}</text>
        <text x="${startX + index * (width + gap) + 20}" y="205" font-size="21" font-weight="700" fill="#f7f6ff">${clean(stat.value, 24)}</text>`,
    )
    .join('');
}

/** Render a chart model into PNG bytes. */
export async function renderChart(model: ChartModel): Promise<RenderedChart> {
  const series = model.series.slice(0, 60);
  const max = Math.max(1, ...series.map((datum) => (Number.isFinite(datum.value) ? datum.value : 0)));
  const chartMarkup =
    series.length === 0
      ? `<rect x="${PLOT_X}" y="${PLOT_Y}" width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" rx="20" fill="#ffffff" fill-opacity="0.035"/>
         <text x="${WIDTH / 2}" y="${PLOT_Y + PLOT_HEIGHT / 2}" text-anchor="middle" font-size="22" fill="#aaa5d6">No stored data yet — syncs populate these charts.</text>`
      : `${gridMarkup(max)}
         ${useLineChart(model) ? lineMarkup(series, max) : barMarkup(series, max)}
         ${labelMarkup(series)}`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#11102b"/>
      <stop offset="58%" stop-color="#1b1645"/>
      <stop offset="100%" stop-color="#39226f"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#8f82ff"/>
      <stop offset="100%" stop-color="#46d6ff"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#background)"/>
  <circle cx="1120" cy="24" r="240" fill="#9a7dff" fill-opacity="0.1"/>
  <circle cx="1090" cy="${HEIGHT - 30}" r="180" fill="#46d6ff" fill-opacity="0.06"/>
  <rect x="42" y="34" width="330" height="44" rx="22" fill="#ffffff" fill-opacity="0.08"/>
  <text x="64" y="63" font-size="17" font-weight="700" letter-spacing="2.2" fill="#dcd6ff">BRAWLHUB • STORED DATA CHART</text>
  <text x="1158" y="63" text-anchor="end" font-size="14" font-weight="700" letter-spacing="1.4" fill="#aaa5d6">${clean(model.kind.toUpperCase(), 12)}</text>
  <text x="60" y="126" font-size="36" font-weight="700" fill="#f7f6ff">${clean(model.title, 36)}</text>
  <text x="60" y="255" font-size="18" fill="#aaa5d6">${clean(model.subtitle, 80)}</text>
  ${statMarkup(model.stats)}
  <rect x="42" y="250" width="1116" height="390" rx="30" fill="#ffffff" fill-opacity="0.035" stroke="#ffffff" stroke-opacity="0.08"/>
  ${chartMarkup}
  <text x="42" y="${HEIGHT - 24}" font-size="13" fill="#8e88bd">${clean(model.footer, 110)}</text>
  <text x="1158" y="${HEIGHT - 24}" text-anchor="end" font-size="13" fill="#8e88bd">${clean(model.subject, 30)}</text>
</svg>`;

  const png = await sharp(Buffer.from(svg), { limitInputPixels: MAX_INPUT_PIXELS })
    .png()
    .toBuffer();
  return { png, width: WIDTH, height: HEIGHT };
}
