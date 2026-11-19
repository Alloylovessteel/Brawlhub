/**
 * Read-only view models for the official Brawl Stars event rotation.
 *
 * The official API is the only source for live mode/map data. BrawlAPI is used
 * solely to attach presentation assets (map and game-mode images) and never to
 * decide which events are active or upcoming.
 */

export type EventKind = 'active' | 'upcoming';

export interface EventSlotView {
  readonly slotId: number;
  /** Human-readable mode name derived from the official `mode` value. */
  readonly modeLabel: string;
  /** Raw official `mode` value (for example `brawlBall`). */
  readonly rawMode: string;
  readonly mapName: string | null;
  readonly eventId: number | null;
  /** Normalised ISO timestamp, ready for Discord timestamp formatting. */
  readonly startAt: string;
  readonly endAt: string;
  readonly mapImageUrl: string | null;
  readonly modeImageUrl: string | null;
  readonly modeColor: string | null;
}

export interface EventView {
  readonly kind: EventKind;
  readonly slots: readonly EventSlotView[];
  readonly fetchedAt: string;
  /** Set when the official rotation could not be loaded. */
  readonly apiIssue: 'unavailable' | null;
}
