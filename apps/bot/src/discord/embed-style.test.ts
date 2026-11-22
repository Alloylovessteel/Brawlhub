import { describe, expect, it } from 'vitest';
import { EMBED_COLORS } from './embed-style';

describe('embed palette', () => {
  it('uses one stable visual language for status and command categories', () => {
    expect(EMBED_COLORS).toEqual({
      neutral: 0x5865_f2,
      info: 0x3498_db,
      success: 0x57f2_87,
      warning: 0xfaa_61a,
      danger: 0xed_4245,
      player: 0x9b59_b6,
      leaderboard: 0xf1c4_0f,
      competition: 0xe67e_22,
      report: 0x3498_db,
    });
    expect(new Set(Object.values(EMBED_COLORS)).size).toBeGreaterThan(4);
  });
});
