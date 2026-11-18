import { describe, expect, it } from 'vitest';
import {
  buildPaginationRow,
  buildPaginationRowWithState,
  paginate,
  paginationCustomId,
  paginationCustomIdWithState,
  parsePaginationCustomId,
  parsePaginationCustomIdWithState,
} from './pagination';

describe('pagination helpers', () => {
  it('clamps pages and returns one-based ranges', () => {
    const page = paginate(['a', 'b', 'c', 'd', 'e'], 9, 2);
    expect(page).toMatchObject({ page: 3, pageCount: 3, total: 5, start: 5, end: 5 });
    expect(page.items).toEqual(['e']);
  });

  it('handles empty lists without invalid ranges', () => {
    expect(paginate([], 1, 10)).toMatchObject({
      items: [],
      page: 1,
      pageCount: 1,
      total: 0,
      start: 0,
      end: 0,
    });
  });

  it('round-trips pagination custom IDs', () => {
    const customId = paginationCustomId('club-members', 4);
    expect(customId).toBe('club-members:page:4');
    expect(parsePaginationCustomId(customId, 'club-members')).toBe(4);
    expect(parsePaginationCustomId(customId, 'club-history')).toBeNull();
  });

  it('omits navigation when there is only one page', () => {
    expect(buildPaginationRow('club-members', 1, 1)).toBeNull();
  });

  it('builds Previous and Next buttons for middle pages', () => {
    const row = buildPaginationRow('club-members', 2, 3);
    expect(row).not.toBeNull();
    const json = row!.toJSON();
    expect(json.components.map((component) => (component as { custom_id?: string }).custom_id))
      .toEqual(['club-members:page:1', 'club-members:page:3']);
  });

  it('round-trips opaque state through pagination custom IDs', () => {
    const customId = paginationCustomIdWithState('club-history', 3, '30d|2C0Y');

    expect(customId).toBe('club-history:page:3:30d|2C0Y');
    expect(parsePaginationCustomIdWithState(customId, 'club-history')).toEqual({
      page: 3,
      state: '30d|2C0Y',
    });
    expect(parsePaginationCustomIdWithState(customId, 'club-members')).toBeNull();
    expect(parsePaginationCustomIdWithState('club-history:page:0:all', 'club-history')).toBeNull();
    expect(parsePaginationCustomIdWithState('club-history:page:1:', 'club-history')).toBeNull();
  });

  it('preserves state in generated pagination buttons', () => {
    const row = buildPaginationRowWithState('club-members', 2, 3, '2C0Y');

    expect(row).not.toBeNull();
    const json = row!.toJSON();
    expect(json.components.map((component) => (component as { custom_id?: string }).custom_id))
      .toEqual(['club-members:page:1:2C0Y', 'club-members:page:3:2C0Y']);
  });
});
