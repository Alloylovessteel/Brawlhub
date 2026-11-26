import { describe, expect, it } from 'vitest';
import { currentClubLogDigestBoundary, dueClubLogDigests } from './digest';

const CONFIG = {
  seasonStartIso: '2026-11-05T08:00:00.000Z',
  seasonEndIso: '2026-12-03T08:00:00.000Z',
};

describe('currentClubLogDigestBoundary', () => {
  it('describes the current UTC day rather than the completed day', () => {
    const now = new Date('2026-11-22T17:30:00.000Z');
    const boundary = currentClubLogDigestBoundary(now);

    expect(boundary).toEqual({
      period: 'today',
      periodKey: '2026-11-22',
      windowStart: new Date('2026-11-22T00:00:00.000Z'),
      windowEnd: now,
      label: 'Nov 22',
    });
    expect(dueClubLogDigests(now, CONFIG)[0]?.periodKey).toBe('2026-11-21');
  });

  it('handles a UTC month rollover', () => {
    const boundary = currentClubLogDigestBoundary(new Date('2026-12-01T00:05:00.000Z'));

    expect(boundary.periodKey).toBe('2026-12-01');
    expect(boundary.label).toBe('Dec 1');
    expect(boundary.windowStart.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('dueClubLogDigests', () => {
  it('always returns the completed UTC day and the most recent completed week', () => {
    const boundaries = dueClubLogDigests(new Date('2026-11-22T17:30:00.000Z'), CONFIG);

    expect(boundaries).toHaveLength(2);
    expect(boundaries[0]).toMatchObject({
      period: 'today',
      periodKey: '2026-11-21',
      label: 'Nov 21',
    });
    expect(boundaries[0]?.windowStart.toISOString()).toBe('2026-11-21T00:00:00.000Z');
    expect(boundaries[0]?.windowEnd.toISOString()).toBe('2026-11-21T23:59:59.999Z');
  });

  it('checks the most recent completed week on every poll', () => {
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
    expect(tuesday.map((boundary) => boundary.period)).toEqual(['today', 'week']);
    expect(tuesday[1]?.periodKey).toBe('2026-11-16');
  });

  it('does not post a season digest before the season reset', () => {
    const boundaries = dueClubLogDigests(new Date('2026-12-03T09:00:00.000Z'), CONFIG);
    expect(boundaries.map((boundary) => boundary.period)).toEqual(['today', 'week']);
  });

  it('posts the completed season at the first UTC midnight after the reset', () => {
    const boundaries = dueClubLogDigests(new Date('2026-12-04T00:00:30.000Z'), CONFIG);

    expect(boundaries).toHaveLength(3);
    expect(boundaries[2]).toMatchObject({
      period: 'season',
      periodKey: '2026-12-03',
      label: 'Nov 5 – Dec 3, 2026',
    });
    expect(boundaries[2]?.windowStart.toISOString()).toBe(CONFIG.seasonStartIso);
    expect(boundaries[2]?.windowEnd.toISOString()).toBe('2026-12-03T07:59:59.999Z');
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
      ['today', 'week'],
    );
    expect(
      dueClubLogDigests(new Date('2026-12-04T00:00:00.000Z'), {
        seasonStartIso: 'not-a-date',
        seasonEndIso: CONFIG.seasonEndIso,
      }).map((b) => b.period),
    ).toEqual(['today', 'week']);
  });
});
