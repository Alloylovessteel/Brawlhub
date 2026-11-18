/** Server-side validation for `/push` option values. */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const UTC_MINUTE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))$/;
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INT = 2_147_483_647;

export const DATE_HINT =
  'Use an ISO date/time with an offset (2026-11-25T18:00Z) or UTC minute (2026-11-25 18:00).';

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function part(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

/** Parse a date string without accepting invented or normalised calendar values. */
export function parsePushDate(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const dateOnly = DATE_ONLY.exec(trimmed);
  if (dateOnly !== null) {
    const year = part(dateOnly[1], 0);
    const month = part(dateOnly[2], 0);
    const day = part(dateOnly[3], 0);
    if (!validCalendarDate(year, month, day)) return null;
    return new Date(Date.UTC(year, month - 1, day)).toISOString();
  }

  const utcMinute = UTC_MINUTE.exec(trimmed);
  if (utcMinute !== null) {
    const year = part(utcMinute[1], 0);
    const month = part(utcMinute[2], 0);
    const day = part(utcMinute[3], 0);
    const hour = part(utcMinute[4], -1);
    const minute = part(utcMinute[5], -1);
    if (
      !validCalendarDate(year, month, day) ||
      hour < 0 || hour > 23 ||
      minute < 0 || minute > 59
    ) {
      return null;
    }
    return new Date(Date.UTC(year, month - 1, day, hour, minute)).toISOString();
  }

  const iso = ISO_WITH_OFFSET.exec(trimmed);
  if (iso !== null) {
    const year = part(iso[1], 0);
    const month = part(iso[2], 0);
    const day = part(iso[3], 0);
    const hour = part(iso[4], -1);
    const minute = part(iso[5], -1);
    const second = part(iso[6], 0);
    if (
      !validCalendarDate(year, month, day) ||
      hour < 0 || hour > 23 ||
      minute < 0 || minute > 59 ||
      second < 0 || second > 59
    ) {
      return null;
    }
    const milliseconds = Date.parse(trimmed);
    return Number.isNaN(milliseconds) ? null : new Date(milliseconds).toISOString();
  }

  return null;
}

export interface PushPeriod {
  readonly startsAt: string;
  readonly endsAt: string;
}

/** Validate both dates, their order, and that the competition is not backdated. */
export function parsePushPeriod(start: string, end: string, now: Date): ValidationResult<PushPeriod> {
  const startsAt = parsePushDate(start);
  const endsAt = parsePushDate(end);
  if (startsAt === null || endsAt === null) {
    return { ok: false, message: `That date is not valid. ${DATE_HINT}` };
  }

  const startMs = Date.parse(startsAt);
  const endMs = Date.parse(endsAt);
  if (endMs <= startMs) {
    return { ok: false, message: 'The competition end must be after its start.' };
  }
  if (startMs < now.getTime()) {
    return { ok: false, message: 'The competition start cannot be in the past.' };
  }

  return { ok: true, value: { startsAt, endsAt } };
}

export function normalizePushName(value: string): ValidationResult<string> {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length < 1 || normalized.length > 100) {
    return { ok: false, message: 'Competition names must be between 1 and 100 characters.' };
  }
  return { ok: true, value: normalized };
}

export function normalizePushDescription(value: string | null): ValidationResult<string | null> {
  if (value === null) return { ok: true, value: null };
  const normalized = value.trim();
  if (normalized.length > 1000) {
    return { ok: false, message: 'Descriptions must be 1,000 characters or fewer.' };
  }
  return { ok: true, value: normalized === '' ? null : normalized };
}

export function parsePushGoal(value: number | null): ValidationResult<number | null> {
  if (value === null) return { ok: true, value: null };
  if (!Number.isInteger(value) || value <= 0 || value > MAX_INT) {
    return { ok: false, message: 'Goal must be a positive whole number.' };
  }
  return { ok: true, value };
}

export function parsePushTrophies(value: number): ValidationResult<number> {
  if (!Number.isInteger(value) || value < 0 || value > MAX_INT) {
    return { ok: false, message: 'Trophies must be a whole number of 0 or more.' };
  }
  return { ok: true, value };
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
