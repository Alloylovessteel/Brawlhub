export interface BotRuntimeSnapshot {
  /** Process start time, used as the bot uptime baseline. */
  readonly startedAt: Date;
  /** Whether the Discord gateway client is currently ready. */
  readonly discordReady: boolean;
  /** Most recent transition to ready, when one has occurred. */
  readonly discordReadyAt: Date | null;
}

const processStartedAt = new Date();

let discordReady = false;
let discordReadyAt: Date | null = null;

/** Record a successful Discord gateway connection. */
export function markDiscordReady(at: Date = new Date()): void {
  discordReady = true;
  discordReadyAt = at;
}

/** Record that the Discord gateway is no longer ready. */
export function markDiscordDisconnected(): void {
  discordReady = false;
}

/** Read a fresh snapshot for status reporting. */
export function getBotRuntimeSnapshot(): BotRuntimeSnapshot {
  return {
    startedAt: processStartedAt,
    discordReady,
    discordReadyAt: discordReadyAt === null ? null : new Date(discordReadyAt.getTime()),
  };
}

/** Reset observer state and the uptime baseline (used by tests). */
export function resetBotRuntimeForTests(
  snapshot: Partial<BotRuntimeSnapshot> = {},
): void {
  discordReady = snapshot.discordReady ?? false;
  discordReadyAt = snapshot.discordReadyAt ?? null;
  processStartedAt.setTime((snapshot.startedAt ?? new Date()).getTime());
}
