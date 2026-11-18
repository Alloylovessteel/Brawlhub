import { describe, expect, it } from 'vitest';
import {
  isUuid,
  normalizePushDescription,
  normalizePushName,
  parsePushDate,
  parsePushGoal,
  parsePushPeriod,
  parsePushTrophies,
} from './validate';

const NOW = new Date('2026-11-18T12:00:00.000Z');

describe('push input validation', () => {
  it('accepts ISO offsets and UTC minute values', () => {
    expect(parsePushDate('2026-11-25T18:00Z')).toBe('2026-11-25T18:00:00.000Z');
    expect(parsePushDate('2026-11-25 18:30')).toBe('2026-11-25T18:30:00.000Z');
    expect(parsePushDate('2026-11-25')).toBe('2026-11-25T00:00:00.000Z');
  });

  it('rejects malformed and impossible dates', () => {
    expect(parsePushDate('25/11/2026')).toBeNull();
    expect(parsePushDate('2026-02-30')).toBeNull();
    expect(parsePushDate('2026-11-25 25:00')).toBeNull();
  });

  it('rejects reversed and backdated periods', () => {
    const reversed = parsePushPeriod('2026-11-26T00:00Z', '2026-11-25T00:00Z', NOW);
    expect(reversed.ok).toBe(false);

    const past = parsePushPeriod('2026-11-17T00:00Z', '2026-11-20T00:00Z', NOW);
    expect(past.ok).toBe(false);

    const valid = parsePushPeriod('2026-11-25T00:00Z', '2026-11-26T00:00Z', NOW);
    expect(valid).toEqual({
      ok: true,
      value: {
        startsAt: '2026-11-25T00:00:00.000Z',
        endsAt: '2026-11-26T00:00:00.000Z',
      },
    });
  });

  it('normalises names and descriptions', () => {
    expect(normalizePushName('  Midseason   Push  ')).toEqual({ ok: true, value: 'Midseason Push' });
    expect(normalizePushName('   ')).toEqual({
      ok: false,
      message: 'Competition names must be between 1 and 100 characters.',
    });
    expect(normalizePushDescription('  ')).toEqual({ ok: true, value: null });
    expect(normalizePushDescription(' No camping ')).toEqual({ ok: true, value: 'No camping' });
  });

  it('rejects negative trophy values, fractional values and invalid goals', () => {
    expect(parsePushTrophies(0)).toEqual({ ok: true, value: 0 });
    expect(parsePushTrophies(-1).ok).toBe(false);
    expect(parsePushTrophies(1.5).ok).toBe(false);
    expect(parsePushGoal(0).ok).toBe(false);
    expect(parsePushGoal(null)).toEqual({ ok: true, value: null });
  });

  it('recognises UUID selections', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
  });
});
