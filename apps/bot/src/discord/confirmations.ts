import { randomUUID } from 'node:crypto';

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
  readonly expiresAt: number;
  readonly payload: T;
}

/**
 * Actor-bound, expiring, single-use confirmation store.
 *
 * The nonce is removed before a payload is returned, so a confirmation can
 * never be replayed even if the subsequent operation fails.
 */
export class ConfirmationStore<T> {
  private readonly entries = new Map<string, StoredConfirmation<T>>();

  constructor(
    private readonly ttlMs: number = DEFAULT_CONFIRMATION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  create(actorDiscordUserId: string, payload: T): string {
    const nonce = randomUUID();
    this.entries.set(nonce, {
      actorDiscordUserId,
      expiresAt: this.now() + this.ttlMs,
      payload,
    });
    return nonce;
  }

  take(nonce: string, actorDiscordUserId: string): T {
    const entry = this.entries.get(nonce);
    if (entry === undefined) {
      throw new ConfirmationError('missing', 'That confirmation is no longer valid.');
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(nonce);
      throw new ConfirmationError('expired', 'That confirmation has expired. Run the command again.');
    }
    if (entry.actorDiscordUserId !== actorDiscordUserId) {
      throw new ConfirmationError('wrong_actor', 'That confirmation belongs to another user.');
    }

    this.entries.delete(nonce);
    return entry.payload;
  }

  clear(): void {
    this.entries.clear();
  }
}
