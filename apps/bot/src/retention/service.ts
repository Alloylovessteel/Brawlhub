import { createTrustedClient } from '@brawlhub/database';

/** Full official battle payloads older than this are trimmed to `{}`. */
export const BATTLE_RAW_RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;

/** Return the ISO cutoff used by the battle raw retention job. */
export function battleRawCutoff(now: Date, days: number = BATTLE_RAW_RETENTION_DAYS): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

export interface BattleRawRetentionResult {
  readonly trimmed: number;
  readonly cutoff: string;
}

/**
 * Replace old full battle JSON with an empty object. History rows, results and
 * derived fields are kept, so stats and battle history remain intact while the
 * large payloads are reclaimed.
 */
export async function trimOldBattleRaw(now: Date = new Date()): Promise<BattleRawRetentionResult> {
  const cutoff = battleRawCutoff(now);
  const db = createTrustedClient();
  const { data, error } = await db
    .from('player_battles')
    .update({ raw: {} })
    .lt('battle_time', cutoff)
    // postgrest-js stringifies filter values into the query string; a plain
    // object would become "[object Object]" and fail as jsonb input.
    .neq('raw', '{}')
    .select('id');
  if (error) {
    throw new Error(`Battle raw retention failed: ${error.message}`);
  }
  return { trimmed: Array.isArray(data) ? data.length : 0, cutoff };
}
