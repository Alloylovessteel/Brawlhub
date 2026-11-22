import { describe, expect, it } from 'vitest';
import type { Page } from './pagination.js';
import { ONLINE_STATUS_NOTE, paginationFooter, periodSummary, sourceFooter } from './ux.js';

function page(overrides: Partial<Page<unknown>> = {}): Page<unknown> {
  return {
    items: [],
    page: 1,
    pageCount: 2,
    total: 16,
    start: 1,
    end: 10,
    ...overrides,
  };
}

describe('shared embed UX copy', () => {
  it('renders compact pagination footers with an optional label', () => {
    expect(paginationFooter(page(), 'History')).toBe('History • Page 1 / 2 • 1–10 of 16');
    expect(paginationFooter(page())).toBe('Page 1 / 2 • 1–10 of 16');
  });

  it('renders source and sync notes without the online-status disclaimer', () => {
    expect(sourceFooter('live', '<t:1795274194:R>')).toBe(
      'Official API data • Synced <t:1795274194:R>',
    );
    expect(sourceFooter('stored', null)).toBe('Stored sync data');
    expect(sourceFooter('live', null)).not.toContain(ONLINE_STATUS_NOTE);
  });

  it('expands match activity abbreviations into plain period labels', () => {
    expect(periodSummary({ today: '5', week: '43', season: '0' })).toBe(
      'Today: 5 • Week: 43 • Season: 0',
    );
    expect(periodSummary({ today: '5', week: null, season: null })).toBe('Today: 5');
    expect(periodSummary({ today: null, week: null, season: null })).toBeNull();
  });
});
