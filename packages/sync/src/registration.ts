import { createBrawlStarsClient, clubSchema, type BrawlStarsClient, type Club } from '@brawlhub/brawl-stars';
import { createTrustedClient } from '@brawlhub/database';
import { brawlTagSchema, SUPPORTED_CLUB_RANGE } from '@brawlhub/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation, sanitizeError, withTimeout } from './sync';

const REGISTRATION_API_TIMEOUT_MS = 30_000;

export interface RegistrationResult {
  registered: number;
  rejected: Array<{ tag: string; reason: string }>;
}

interface ClubRow {
  id: string;
  tag: string;
  name: string;
}

function readPositiveTimeout(): number {
  const raw = process.env.SYNC_API_TIMEOUT_MS?.trim();
  if (raw === undefined || raw.length === 0) {
    return REGISTRATION_API_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : REGISTRATION_API_TIMEOUT_MS;
}

/**
 * Validates the API response without inventing fields the official client may
 * strip. badgeId/memberCount are read defensively from the raw payload.
 */
function profileFromApi(raw: unknown, expectedTag: string): {
  name: string;
  description: string | null;
  badgeId: number | null;
  trophies: number;
  requiredTrophies: number | null;
  memberCount: number | null;
} {
  const parsed = clubSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Official API returned malformed club data');
  }
  const club: Club = parsed.data;
  const tagCheck = brawlTagSchema.safeParse(club.tag);
  if (!tagCheck.success || tagCheck.data !== expectedTag) {
    throw new Error(`Official API returned a mismatched club tag (${club.tag})`);
  }

  const rawRecord = raw as unknown as Record<string, unknown>;
  const badgeId = typeof rawRecord['badgeId'] === 'number' ? rawRecord['badgeId'] : null;
  const apiMemberCount =
    typeof rawRecord['memberCount'] === 'number' ? rawRecord['memberCount'] : null;

  return {
    name: club.name,
    description: club.description ?? null,
    badgeId,
    trophies: club.trophies,
    requiredTrophies: club.requiredTrophies ?? null,
    memberCount: apiMemberCount ?? (club.members?.length ?? null),
  };
}

async function registerClubsWith(
  db: SupabaseClient,
  client: BrawlStarsClient,
  tags: readonly string[],
): Promise<RegistrationResult> {
  const rejected: Array<{ tag: string; reason: string }> = [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  // 1. Normalise and reject invalid / duplicated input tags up front.
  for (const rawTag of tags) {
    const parsed = brawlTagSchema.safeParse(rawTag);
    if (!parsed.success) {
      rejected.push({ tag: rawTag, reason: 'Invalid Brawl Stars tag' });
      continue;
    }
    const tag = parsed.data;
    if (seen.has(tag)) {
      rejected.push({ tag, reason: 'Duplicate tag in input' });
      continue;
    }
    seen.add(tag);
    normalized.push(tag);
  }

  // 2. Pre-check against existing clubs (the UNIQUE constraint handles races).
  const clubsResult = await db.from('clubs').select('id, tag');
  if (clubsResult.error !== null && clubsResult.error !== undefined) {
    throw new Error(`Unable to read registered clubs: ${sanitizeError(clubsResult.error)}`);
  }
  const existingRows = (clubsResult.data ?? []) as ClubRow[];
  const existingTags = new Set(existingRows.map((row) => row.tag));
  const existingCount = existingRows.length;

  const toFetch: string[] = [];
  for (const tag of normalized) {
    if (existingTags.has(tag)) {
      rejected.push({ tag, reason: 'Club is already registered' });
    } else {
      toFetch.push(tag);
    }
  }

  // 3. Enforce the supported club range without fabricating placeholder clubs.
  if (existingCount + toFetch.length > SUPPORTED_CLUB_RANGE.max) {
    for (const tag of toFetch) {
      rejected.push({
        tag,
        reason: `Registering would exceed the maximum of ${SUPPORTED_CLUB_RANGE.max} supported clubs (${existingCount} already registered)`,
      });
    }
    toFetch.length = 0;
  }

  // 4. Fetch the official profile and insert only complete data.
  const timeoutMs = readPositiveTimeout();
  let registered = 0;
  for (const tag of toFetch) {
    try {
      const rawClub = await withTimeout(
        client.getClub(tag),
        timeoutMs,
        `getClub(${tag})`,
      );
      const profile = profileFromApi(rawClub, tag);
      const insert = await db.from('clubs').insert({
        tag,
        name: profile.name,
        description: profile.description,
        badge_id: profile.badgeId,
        trophies: profile.trophies,
        required_trophies: profile.requiredTrophies,
        member_count: profile.memberCount,
      });
      if (insert.error !== null && insert.error !== undefined) {
        if (isUniqueViolation(insert.error)) {
          rejected.push({ tag, reason: 'Club is already registered' });
          continue;
        }
        throw new Error(sanitizeError(insert.error));
      }
      registered += 1;
    } catch (error) {
      // Never store partial or fabricated club data when the API fails.
      rejected.push({ tag, reason: sanitizeError(error) });
    }
  }

  return { registered, rejected };
}

/** Registers clubs supplied by their (optionally '#'-prefixed) tags. */
export async function registerClubs(tags: readonly string[]): Promise<RegistrationResult> {
  const db = createTrustedClient();
  const client = createBrawlStarsClient();
  return registerClubsWith(db, client, tags);
}
