import {
  getSharedBrawlStarsClient,
  type BrawlStarsClient,
  type EventRotationSlot,
} from '@brawlhub/brawl-stars';
import type { BrawlApiClient } from '@brawlhub/brawlapi';
import { getGameAssetsClient } from '../metadata/assets.js';
import type { EventKind, EventSlotView, EventView } from './types';

const ROTATION_CACHE_TTL_MS = 10 * 60 * 1000;

let rotationCache: { readonly slots: readonly EventRotationSlot[]; readonly at: number } | null =
  null;

export interface LoadEventViewOptions {
  /** Injectable official client. When supplied, the process-wide cache is bypassed. */
  readonly client?: BrawlStarsClient;
  /** Injectable static-metadata client. */
  readonly brawlApi?: BrawlApiClient;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

/** Convert an official `mode` value such as `brawlBall` into `Brawl Ball`. */
export function formatModeLabel(mode: string): string {
  const spaced = mode.trim().replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * The official rotation uses `YYYYMMDDTHHmmss.sssZ` rather than ISO-8601.
 * Normalise it so Discord timestamp formatting and `Date.parse` work reliably.
 */
export function parseOfficialEventTime(value: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/.exec(value.trim());
  if (match === null) {
    const milliseconds = Date.parse(value);
    return Number.isNaN(milliseconds) ? null : new Date(milliseconds).toISOString();
  }
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

async function loadRotation(options: LoadEventViewOptions): Promise<readonly EventRotationSlot[]> {
  if (options.client !== undefined) {
    return options.client.getEventRotation();
  }
  const cached = rotationCache;
  if (cached !== null && Date.now() - cached.at < ROTATION_CACHE_TTL_MS) {
    return cached.slots;
  }
  const slots = await getSharedBrawlStarsClient().getEventRotation();
  rotationCache = { slots, at: Date.now() };
  return slots;
}

/**
 * Load the official live rotation and split it into active or upcoming events.
 * Static map/mode assets are best-effort and cannot change the classification.
 */
export async function loadEventView(
  kind: EventKind,
  options: LoadEventViewOptions = {},
): Promise<EventView> {
  const now = (options.now ?? (() => new Date()))();
  const nowMs = now.getTime();

  let slots: readonly EventRotationSlot[];
  let apiIssue: 'unavailable' | null = null;
  try {
    slots = await loadRotation(options);
  } catch {
    slots = [];
    apiIssue = 'unavailable';
  }

  const matching = slots
    .map((slot) => ({
      slot,
      startAt: parseOfficialEventTime(slot.startTime),
      endAt: parseOfficialEventTime(slot.endTime),
    }))
    .filter((entry) => {
      if (entry.startAt === null || entry.endAt === null) return false;
      const start = Date.parse(entry.startAt);
      const end = Date.parse(entry.endAt);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
      return kind === 'active' ? start <= nowMs && nowMs < end : start > nowMs;
    })
    .sort((a, b) => Date.parse(a.startAt as string) - Date.parse(b.startAt as string));

  const brawlApi = options.brawlApi ?? getGameAssetsClient();
  const views: EventSlotView[] = [];
  for (const entry of matching) {
    const mode = entry.slot.event?.mode ?? '';
    const mapName = entry.slot.event?.map ?? null;
    let assets = null;
    try {
      assets = await brawlApi.resolveGameAssets({ mapName, gameModeName: mode });
    } catch {
      // Static metadata is optional; keep the official names and no images.
    }
    views.push({
      slotId: entry.slot.slotId,
      modeLabel: mode === '' ? 'Unknown mode' : formatModeLabel(mode),
      rawMode: mode,
      mapName,
      eventId: entry.slot.event?.id ?? null,
      startAt: entry.startAt as string,
      endAt: entry.endAt as string,
      mapImageUrl: assets?.mapImageUrl ?? null,
      modeImageUrl: assets?.gameModeImageUrl ?? null,
      modeColor: assets?.gameModeColor ?? null,
    });
  }

  return { kind, slots: views, fetchedAt: now.toISOString(), apiIssue };
}

/** Test helper for resetting the process-wide official rotation cache. */
export function clearEventRotationCache(): void {
  rotationCache = null;
}
