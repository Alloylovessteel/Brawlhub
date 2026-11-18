import { describe, expect, it } from 'vitest';
import {
  isUuid,
  normalizeCompetitionDescription,
  normalizeCompetitionName,
  parseCompetitionDate,
  parseCompetitionGoal,
  parseCompetitionPeriod,
  parseCompetitionTrophies,
} from './validate';

const NOW = new Date('2026-11-18T12:00:00.000Z');

describe('competition input validation', () => {
  it('accepts ISO offsets and UTC minute values', () => {
    expect(parseCompetitionDate('2026-11-25T18:00Z')).toBe('2026-11-25T18:00:00.000Z');
    expect(parseCompetitionDate('2026-11-25 18:30')).toBe('2026-11-25T18:30:00.000Z');
    expect(parseCompetitionDate('2026-11-25')).toBe('2026-11-25T00:00:00.000Z');
  });

  it('rejects malformed and impossible dates', () => {
    expect(parseCompetitionDate('25/11/2026')).toBeNull();
    expect(parseCompetitionDate('2026-02-30')).toBeNull();
    expect(parseCompetitionDate('2026-11-25 25:00')).toBeNull();
  });

  it('rejects reversed and backdated periods', () => {
    const reversed = parseCompetitionPeriod('2026-11-26T00:00Z', '2026-11-25T00:00Z', NOW);
    expect(reversed.ok).toBe(false);

    const past = parseCompetitionPeriod('2026-11-17T00:00Z', '2026-11-20T00:00Z', NOW);
    expect(past.ok).toBe(false);

    const valid = parseCompetitionPeriod('2026-11-25T00:00Z', '2026-11-26T00:00Z', NOW);
    expect(valid).toEqual({
      ok: true,
      value: {
        startsAt: '2026-11-25T00:00:00.000Z',
        endsAt: '2026-11-26T00:00:00.000Z',
      },
    });
  });

  it('normalises names and descriptions', () => {
    expect(normalizeCompetitionName('  Midseason   Climb  ')).toEqual({ ok: true, value: 'Midseason Climb' });
    expect(normalizeCompetitionName('   ')).toEqual({
      ok: false,
      message: 'Competition names must be between 1 and 100 characters.',
    });
    expect(normalizeCompetitionDescription('  ')).toEqual({ ok: true, value: null });
    expect(normalizeCompetitionDescription(' No camping ')).toEqual({ ok: true, value: 'No camping' });
  });

  it('rejects negative trophy values, fractional values and invalid goals', () => {
    expect(parseCompetitionTrophies(0)).toEqual({ ok: true, value: 0 });
    expect(parseCompetitionTrophies(-1).ok).toBe(false);
    expect(parseCompetitionTrophies(1.5).ok).toBe(false);
    expect(parseCompetitionGoal(0).ok).toBe(false);
    expect(parseCompetitionGoal(null)).toEqual({ ok: true, value: null });
  });

  it('recognises UUID selections', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
  });
});
