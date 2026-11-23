import { randomUUID } from 'node:crypto';
import {
  clearPersistentSessions,
  createPersistentSession,
  deletePersistentSession,
  listPersistentSessions,
  persistVoid,
  takePersistentSession,
} from '../state/index.js';

export const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export type ConfirmationErrorKind = 'missing' | 'expired' | 'wrong_actor';

/** Expected, user-facing confirmation failures. */
export class ConfirmationError extends Error {
  readonly kind: ConfirmationErrorKind;

  constructor(kind: ConfirmationErrorKind, message: string) {
    super(message);
    this.name = 'ConfirmationError';
    this.kind = kind;
  }
}

interface StoredConfirmation<T> {
  readonly actorDiscordUserId: string;
  readonly guildId: string;
  readonly expiresAt: number;
  readonly payload: T;
}

function normalizeGuildId(guildId: string | null | undefined): string {
  const trimmed = guildId?.trim() ?? '';
  return trimmed === '' ? 'dm' : trimmed;
}

/**
 * Actor- and guild-bound, expiring, single-use confirmation store.
 *
 * The local map is an immediately available mirror, while Supabase is the
 * authoritative single-use source. `take` awaits that authoritative consume
 * before returning a payload, so a confirmation cannot execute twice across
 * process restarts or concurrent mirrors.
 */
export class ConfirmationStore<T> {
  private readonly entries = new Map<string, StoredConfirmation<T>>();
  private hydration: Promise<void> | undefined;

  constructor(
    private readonly ttlMs: number = DEFAULT_CONFIRMATION_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly command: string = 'confirmation',
  ) {}

  private ensureHydrated(): Promise<void> {
    this.hydration ??= listPersistentSessions({ command: this.command })
      .then((rows) => {
        for (const row of rows) {
          if (this.entries.has(row.nonce)) continue;
          const stored = row.payload as unknown as StoredConfirmation<T> | undefined;
          if (
            stored === undefined ||
            typeof stored.actorDiscordUserId !== 'string' ||
            typeof stored.guildId !== 'string' ||
            typeof stored.expiresAt !== 'number'
          ) {
            continue;
          }
          this.entries.set(row.nonce, {
            actorDiscordUserId: stored.actorDiscordUserId,
            guildId: stored.guildId,
            expiresAt: stored.expiresAt,
            payload: stored.payload,
          });
        }
      })
      .catch(() => undefined);
    return this.hydration;
  }

  create(actorDiscordUserId: string, payload: T, guildId?: string | null): string {
    void this.ensureHydrated();
    const nonce = randomUUID();
    const entry: StoredConfirmation<T> = {
      actorDiscordUserId,
      guildId: normalizeGuildId(guildId),
      expiresAt: this.now() + this.ttlMs,
      payload,
    };
    this.entries.set(nonce, entry);
    persistVoid(
      createPersistentSession({
        guildId: entry.guildId,
        command: this.command,
        kind: 'confirmation',
        actorDiscordUserId,
        nonce,
        payload: entry as unknown as Record<string, unknown>,
        expiresAt: entry.expiresAt,
      }),
      `create confirmation ${this.command}`,
    );
    return nonce;
  }

  async take(nonce: string, actorDiscordUserId: string, guildId?: string | null): Promise<T> {
    await this.ensureHydrated();
    const entry = this.entries.get(nonce);
    if (entry === undefined) {
      throw new ConfirmationError('missing', 'That confirmation is no longer valid.');
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(nonce);
      await deletePersistentSession({
        guildId: entry.guildId,
        command: this.command,
        actorDiscordUserId: entry.actorDiscordUserId,
        nonce,
      });
      throw new ConfirmationError('expired', 'That confirmation has expired. Run the command again.');
    }
    if (
      entry.actorDiscordUserId !== actorDiscordUserId ||
      (guildId !== undefined && entry.guildId !== normalizeGuildId(guildId))
    ) {
      throw new ConfirmationError('wrong_actor', 'That confirmation belongs to another user.');
    }

    this.entries.delete(nonce);
    const result = await takePersistentSession({
      guildId: entry.guildId,
      command: this.command,
      actorDiscordUserId: entry.actorDiscordUserId,
      nonce,
    });
    if (result.kind !== 'ok') {
      throw new ConfirmationError(
        result.kind === 'expired' ? 'expired' : result.kind === 'wrong_actor' ? 'wrong_actor' : 'missing',
        result.kind === 'expired'
          ? 'That confirmation has expired. Run the command again.'
          : result.kind === 'wrong_actor'
            ? 'That confirmation belongs to another user.'
            : 'That confirmation is no longer valid.',
      );
    }
    return entry.payload;
  }

  clear(): void {
    this.entries.clear();
    persistVoid(clearPersistentSessions(this.command), `clear confirmations ${this.command}`);
  }
}
