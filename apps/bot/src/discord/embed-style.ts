/**
 * Shared embed palette. Colors are visual-only markers and never carry data.
 * Keep the same color for the same kind of response across every command.
 */
export const EMBED_COLORS = {
  neutral: 0x5865_f2,
  info: 0x3498_db,
  success: 0x57f2_87,
  warning: 0xfaa_61a,
  danger: 0xed_4245,
  player: 0x9b59_b6,
  leaderboard: 0xf1c4_0f,
  competition: 0xe67e_22,
  report: 0x3498_db,
} as const;
