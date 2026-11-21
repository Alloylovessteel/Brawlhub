import { describe, expect, it } from 'vitest';
import { BATTLE_RAW_RETENTION_DAYS, battleRawCutoff } from './service';

describe('battleRawCutoff', () => {
  it('uses a 90-day window by default', () => {
    expect(BATTLE_RAW_RETENTION_DAYS).toBe(90);
    expect(battleRawCutoff(new Date('2026-11-21T00:00:00.000Z'))).toBe('2026-08-23T00:00:00.000Z');
  });

  it('respects an explicit day count', () => {
    expect(battleRawCutoff(new Date('2026-11-21T00:00:00.000Z'), 7)).toBe('2026-11-14T00:00:00.000Z');
  });
});
