/** Shared user-facing copy, so command embeds use the same short, plain labels. */

import type { Page } from './pagination.js';

/**
 * Compact pagination footer shared by every paged embed.
 * Example: `History • Page 1 / 2 • 1–10 of 16`.
 */
export function paginationFooter(page: Page<unknown>, label?: string): string {
  const parts: string[] = [];
  if (label !== undefined && label !== '') parts.push(label);
  parts.push(`Page ${page.page} / ${page.pageCount}`);
  parts.push(`${page.start}–${page.end} of ${page.total}`);
  return parts.join(' • ');
}

/** Short source note for footers, without repeating the online-status disclaimer. */
export function sourceFooter(source: 'live' | 'stored', syncedAt: string | null): string {
  const label = source === 'live' ? 'Official API data' : 'Stored sync data';
  return syncedAt === null ? label : `${label} • Synced ${syncedAt}`;
}

interface PeriodValues {
  readonly today: string | null;
  readonly week: string | null;
  readonly season: string | null;
}

/** Expand `T / W / S` into plain labels, e.g. `Today: 5 • Week: 43 • Season: 0`. */
export function periodSummary(values: PeriodValues): string | null {
  const parts: string[] = [];
  if (values.today !== null) parts.push(`Today: ${values.today}`);
  if (values.week !== null) parts.push(`Week: ${values.week}`);
  if (values.season !== null) parts.push(`Season: ${values.season}`);
  return parts.length === 0 ? null : parts.join(' • ');
}

/** Short, consistent note wherever player activity is displayed. */
export const ONLINE_STATUS_NOTE = 'Online status is not exposed by the official API';
