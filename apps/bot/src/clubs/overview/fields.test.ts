import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERVIEW_FIELDS,
  OVERVIEW_FIELD_KEYS,
  hasOverviewField,
  isOverviewFieldKey,
  normalizeOverviewFields,
  toggleOverviewField,
} from './fields';

describe('overview field selection', () => {
  it('treats null, empty, and invalid stored values as all defaults', () => {
    expect(normalizeOverviewFields(null)).toEqual([...DEFAULT_OVERVIEW_FIELDS]);
    expect(normalizeOverviewFields([])).toEqual([...DEFAULT_OVERVIEW_FIELDS]);
    expect(normalizeOverviewFields(['nonsense'])).toEqual([...DEFAULT_OVERVIEW_FIELDS]);
  });

  it('keeps only known keys, in first-seen order, without duplicates', () => {
    expect(normalizeOverviewFields(['members', 'bogus', 'staff', 'members'])).toEqual([
      'members',
      'staff',
    ]);
  });

  it('toggles a field on and off without mutating the input', () => {
    const original = ['members', 'staff'];
    const shown = toggleOverviewField(original, 'megaPigEstimate');
    expect(shown).toEqual(['members', 'staff', 'megaPigEstimate']);
    expect(original).toEqual(['members', 'staff']);
    expect(toggleOverviewField(shown, 'megaPigEstimate')).toEqual(['members', 'staff']);
  });

  it('never disables the last remaining field', () => {
    expect(toggleOverviewField(['members'], 'members')).toEqual(['members']);
  });

  it('recognizes the stored Mega Pig estimate key and labels it as estimated', () => {
    expect(isOverviewFieldKey('megaPigEstimate')).toBe(true);
    expect(OVERVIEW_FIELD_KEYS).toContain('megaPigEstimate');
    expect(hasOverviewField(['megaPigEstimate'], 'megaPigEstimate')).toBe(true);
  });
});
