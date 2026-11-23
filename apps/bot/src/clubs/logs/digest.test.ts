import { describe, expect, it } from 'vitest';
import { dueClubLogDigests } from './digest';

const CONFIG = {
  seasonStartIso: '2026-11-05T08:00:00.000Z',
  seasonEndIso: '2026-12-03T08:00:00.000Z',
};

describe('dueClubLogDigests', () => {
  it('always returns the completed UTC day', () => {
    const boundaries = dueClubLogDigests(new Date('2026-11-22T17:30:00.000Z'), CONFIG);

    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]).toMatchObject({
      period: 'today',
      periodKey: '2026-11-21',
      label: 'Nov 21',
    });
    expect(boundaries[0]?.windowStart.toISOString()).toBe('2026-11-21T00:00:00.000Z');
    expect(boundaries[0]?.windowEnd.toISOString()).toBe('2026-11-21T23:59:59.999Z');
  });

  it('adds the completed week only on Monday 00:00 UTC', () => {
    const monday = dueClubLogDigests(new Date('2026-11-23T00:05:00.000Z'), CONFIG);

    expect(monday).toHaveLength(2);
    expect(monday[1]).toMatchObject({
      period: 'week',
      periodKey: '2026-11-16',
      label: 'Nov 16 – Nov 22, 2026',
    });
    expect(monday[1]?.windowStart.toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(monday[1]?.windowEnd.toISOString()).toBe('2026-11-22T23:59:59.999Z');

    const tuesday = dueClubLogDigests(new Date('2026-11-24T00:05:00.000Z'), CONFIG);
    expect(tuesday.map((boundary) => boundary.period)).toEqual(['today']);
  });

  it('does not post a season digest before the season reset', () => {
    const boundaries = dueClubLogDigests(new Date('2026-12-03T09:00:00.000Z'), CONFIG);
    expect(boundaries.map((boundary) => boundary.period)).toEqual(['today']);
  });

  it('posts the completed season at the first UTC midnight after the reset', () => {
    const boundaries = dueClubLogDigests(new Date('2026-12-04T00:00:30.000Z'), CONFIG);

    expect(boundaries).toHaveLength(2);
    expect(boundaries[1]).toMatchObject({
      period: 'season',
      periodKey: '2026-12-03',
      label: 'Nov 5 – Dec 3, 2026',
    });
    expect(boundaries[1]?.windowStart.toISOString()).toBe(CONFIG.seasonStartIso);
    expect(boundaries[1]?.windowEnd.toISOString()).toBe('2026-12-03T07:59:59.999Z');
  });

  it('infers subsequent season resets from the configured interval', () => {
    const boundaries = dueClubLogDigests(new Date('2027-01-01T00:00:00.000Z'), CONFIG);
    const season = boundaries.find((boundary) => boundary.period === 'season');

    expect(season?.periodKey).toBe('2026-12-31');
    expect(season?.windowStart.toISOString()).toBe('2026-12-03T08:00:00.000Z');
    expect(season?.windowEnd.toISOString()).toBe('2026-12-31T07:59:59.999Z');
  });

  it('omits the season digest when the season boundaries are missing or invalid', () => {
    expect(dueClubLogDigests(new Date('2026-12-04T00:00:00.000Z'), {}).map((b) => b.period)).toEqual(
      ['today'],
    );
    expect(
      dueClubLogDigests(new Date('2026-12-04T00:00:00.000Z'), {
        seasonStartIso: 'not-a-date',
        seasonEndIso: CONFIG.seasonEndIso,
      }).map((b) => b.period),
    ).toEqual(['today']);
  });
});
