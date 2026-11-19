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

/** validated official-API data shown to an administrator before registration. */
export interface ClubRegistrationPreview {
  readonly tag: string;
  readonly name: string;
  readonly description: string | null;
  readonly trophies: number;
  readonly memberCount: number | null;
  readonly guildId: string;
}

export interface RegistrationPreviewOptions {
  readonly client?: BrawlStarsClient;
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

function normalizeGuildId(guildId: string): string {
  const value = guildId.trim();
  if (value.length === 0) {
    throw new Error('A Discord guild id is required to register clubs');
  }
  return value;
}

async function loadExistingClub(
  db: SupabaseClient,
  guildId: string,
  tag: string,
): Promise<ClubRow | null> {
  const { data, error } = await db
    .from('clubs')
    .select('id, tag, name')
    .eq('guild_id', guildId)
    .eq('tag', tag)
    .maybeSingle();

  if (error !== null) {
    throw new Error(sanitizeError(error));
  }

  return (data ?? null) as ClubRow | null;
}

/**
 * Validate a club tag against the official Brawl Stars API without writing.
 * The result is safe to show to an administrator during the confirmation step.
 */
export async function previewClubRegistration(
  input: string,
  guildId: string,
  options: RegistrationPreviewOptions = {},
): Promise<ClubRegistrationPreview> {
  const parsed = brawlTagSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('Invalid club tag');
  }
  const tag = parsed.data;
  const normalizedGuildId = normalizeGuildId(guildId);

  const db = createTrustedClient();
  const existing = await loadExistingClub(db, normalizedGuildId, tag);
  if (existing !== null) {
    throw new Error(`Club ${tag} is already registered for this server`);
  }

  const client = options.client ?? createBrawlStarsClient();
  const timeoutMs = readPositiveTimeout();

  let club: Club;
  try {
    club = await withTimeout(client.getClub(tag), timeoutMs, 'Brawl Stars club lookup');
  } catch (error) {
    throw new Error(sanitizeError(error));
  }

  const validated = clubSchema.safeParse(club);
  if (!validated.success) {
    throw new Error('Official club response could not be validated');
  }

  const returnedTag = brawlTagSchema.safeParse(validated.data.tag);
  if (!returnedTag.success || returnedTag.data !== tag) {
    throw new Error('Official club response returned a mismatched club tag');
  }

  const rawRecord = club as unknown as Record<string, unknown>;
  const apiMemberCount =
    typeof rawRecord['memberCount'] === 'number' && Number.isFinite(rawRecord['memberCount'])
      ? rawRecord['memberCount']
      : Array.isArray((validated.data as unknown as Record<string, unknown>)['members'])
        ? ((validated.data as unknown as Record<string, unknown>)['members'] as unknown[]).length
        : null;

  return {
    tag,
    name: validated.data.name,
    description: validated.data.description ?? null,
    trophies: validated.data.trophies,
    memberCount: apiMemberCount,
    guildId: normalizedGuildId,
  };
}

/**
 * Register a club that has already been validated against the official API.
 * This is a trusted, write-once operation used after explicit confirmation.
 */
export async function registerClubFromPreview(
  preview: ClubRegistrationPreview,
): Promise<RegistrationResult> {
  const db = createTrustedClient();
  const guildId = normalizeGuildId(preview.guildId);

  const { error } = await db.from('clubs').insert({
    guild_id: guildId,
    tag: preview.tag,
    name: preview.name,
    description: preview.description,
    trophies: preview.trophies,
    member_count: preview.memberCount,
  });

  if (error !== null) {
    if (isUniqueViolation(error)) {
      return {
        registered: 0,
        rejected: [{ tag: preview.tag, reason: 'already registered for this server' }],
      };
    }
    return { registered: 0, rejected: [{ tag: preview.tag, reason: sanitizeError(error) }] };
  }

  return { registered: 1, rejected: [] };
}

/**
 * Register one or more club tags by validating each against the official API.
 * The number of distinct tags per registration is bounded by the supported range.
 */
export async function registerClubs(
  inputs: readonly string[],
  guildId: string,
): Promise<RegistrationResult> {
  if (inputs.length === 0) {
    return { registered: 0, rejected: [{ tag: '', reason: 'no club tags provided' }] };
  }

  let normalizedGuildId: string;
  try {
    normalizedGuildId = normalizeGuildId(guildId);
  } catch (error) {
    return { registered: 0, rejected: [{ tag: '', reason: sanitizeError(error) }] };
  }

  const normalized: string[] = [];
  const rejected: Array<{ tag: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const raw of inputs) {
    const parsed = brawlTagSchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ tag: raw, reason: 'invalid club tag' });
      continue;
    }
    if (seen.has(parsed.data)) {
      rejected.push({ tag: parsed.data, reason: 'duplicate tag in input' });
      continue;
    }
    seen.add(parsed.data);
    normalized.push(parsed.data);
  }

  if (normalized.length < SUPPORTED_CLUB_RANGE.min) {
    rejected.push({
      tag: '',
      reason: `at least ${SUPPORTED_CLUB_RANGE.min} valid club tag is required`,
    });
    return { registered: 0, rejected };
  }
  if (normalized.length > SUPPORTED_CLUB_RANGE.max) {
    rejected.push({
      tag: '',
      reason: `no more than ${SUPPORTED_CLUB_RANGE.max} clubs can be registered at once`,
    });
    return { registered: 0, rejected };
  }

  let registered = 0;
  for (const tag of normalized) {
    try {
      const preview = await previewClubRegistration(tag, normalizedGuildId);
      const result = await registerClubFromPreview(preview);
      registered += result.registered;
      rejected.push(...result.rejected);
    } catch (error) {
      rejected.push({ tag, reason: sanitizeError(error) });
    }
  }

  return { registered, rejected };
}
