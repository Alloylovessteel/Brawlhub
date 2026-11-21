import { createLogger } from '@brawlhub/logging';
import { BATTLE_RAW_RETENTION_DAYS, trimOldBattleRaw } from './service';

const logger = createLogger('bot/retention');
const DAY_MS = 86_400_000;
const INITIAL_DELAY_MS = 60_000;
const REDACTED = '[REDACTED]';

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const token = process.env.DISCORD_TOKEN?.trim();
  return token !== undefined && token !== '' && message.includes(token)
    ? message.split(token).join(REDACTED)
    : message;
}

/** Start the daily cleanup of old full battle payloads; returns a stop function. */
export function startBattleRawRetentionSchedule(): () => void {
  const tick = (): void => {
    void trimOldBattleRaw().then(
      (result) => {
        if (result.trimmed > 0) {
          logger.info('Trimmed old battle raw payloads', {
            trimmed: result.trimmed,
            cutoff: result.cutoff,
          });
        }
      },
      (error: unknown) => {
        logger.warn('Battle raw retention failed', { error: safeError(error) });
      },
    );
  };

  const intervalTimer = setInterval(tick, DAY_MS);
  const initialTimer = setTimeout(tick, INITIAL_DELAY_MS);
  logger.info('Battle raw retention enabled', {
    retentionDays: BATTLE_RAW_RETENTION_DAYS,
    initialDelayMs: INITIAL_DELAY_MS,
    intervalMs: DAY_MS,
  });

  return () => {
    clearInterval(intervalTimer);
    clearTimeout(initialTimer);
  };
}
