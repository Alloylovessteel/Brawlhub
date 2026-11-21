import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BATTLE_RAW_RETENTION_DAYS, battleRawCutoff, trimOldBattleRaw } from './service';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  update: vi.fn(),
  lt: vi.fn(),
  neq: vi.fn(),
  select: vi.fn(),
}));

vi.mock('@brawlhub/database', () => ({
  createTrustedClient: () => ({ from: mocks.from }),
}));

describe('battleRawCutoff', () => {
  it('uses a 90-day window by default', () => {
    expect(BATTLE_RAW_RETENTION_DAYS).toBe(90);
    expect(battleRawCutoff(new Date('2026-11-21T00:00:00.000Z'))).toBe('2026-08-23T00:00:00.000Z');
  });

  it('respects an explicit day count', () => {
    expect(battleRawCutoff(new Date('2026-11-21T00:00:00.000Z'), 7)).toBe('2026-11-14T00:00:00.000Z');
  });
});

describe('trimOldBattleRaw', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockReturnValue({ update: mocks.update });
    mocks.update.mockReturnValue({ lt: mocks.lt });
    mocks.lt.mockReturnValue({ neq: mocks.neq });
    mocks.neq.mockReturnValue({ select: mocks.select });
    mocks.select.mockResolvedValue({ data: [{ id: 'battle-1' }], error: null });
  });

  it('compares the jsonb raw column with a valid JSON literal string', async () => {
    const result = await trimOldBattleRaw(new Date('2026-11-21T00:00:00.000Z'));

    expect(mocks.from).toHaveBeenCalledWith('player_battles');
    expect(mocks.update).toHaveBeenCalledWith({ raw: {} });
    expect(mocks.lt).toHaveBeenCalledWith('battle_time', '2026-08-23T00:00:00.000Z');
    expect(mocks.neq).toHaveBeenCalledWith('raw', '{}');
    expect(mocks.select).toHaveBeenCalledWith('id');
    expect(result).toEqual({
      trimmed: 1,
      cutoff: '2026-08-23T00:00:00.000Z',
    });
  });
});
