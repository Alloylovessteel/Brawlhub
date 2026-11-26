import { createLogger } from '@brawlhub/logging';
import type { Client } from 'discord.js';
import { syncNicknameAfterVerification } from '../nickname-sync/service.js';
import { notifyVerificationCompleted } from '../operator-notifier.js';
import { reconcileGuildRolesForPlayer } from '../role-automation/index.js';
import {
  listVerificationChallenges,
  type VerificationChallengeRecord,
} from '../state/index.js';
import { checkVerification } from './service.js';
import type { CheckVerificationResult } from './types.js';

const logger = createLogger('bot/verification');
const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 15;
const MAX_INTERVAL_SECONDS = 3600;
const DEFAULT_BATCH_SIZE = 10;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 50;
const INITIAL_DELAY_MS = 5_000;

export interface VerificationAutoCheckSummary {
  readonly candidates: number;
  readonly checked: number;
  readonly verified: number;
  readonly pending: number;
  readonly skipped: number;
  readonly failed: number;
}

type MutableSummary = {
  -readonly [K in keyof VerificationAutoCheckSummary]: VerificationAutoCheckSummary[K];
};

const EMPTY_SUMMARY: VerificationAutoCheckSummary = {
  candidates: 0,
  checked: 0,
  verified: 0,
  pending: 0,
  skipped: 0,
  failed: 0,
};

interface DiscordUserView {
  readonly username: string;
  readonly globalName?: string | null;
  readonly send: (options: {
    readonly content: string;
    readonly allowedMentions: { readonly parse: readonly [] };
  }) => Promise<unknown>;
}

export interface VerificationAutoCheckDeps {
  readonly now?: () => number;
  readonly listChallenges?: () => Promise<VerificationChallengeRecord[]>;
  readonly check?: (input: {
    readonly discordUserId: string;
    readonly guildId: string | null;
  }) => Promise<CheckVerificationResult>;
  readonly notifyUser?: (input: {
    readonly discordUserId: string;
    readonly content: string;
  }) => Promise<void>;
  readonly loadUsername?: (discordUserId: string) => Promise<string | null>;
  readonly notifyOperator?: typeof notifyVerificationCompleted;
  readonly reconcileRoles?: typeof reconcileGuildRolesForPlayer;
  readonly syncNickname?: typeof syncNicknameAfterVerification;
  readonly batchSize?: number;
}

/** One poll at a time, and never two checks for the same challenge. */
let pollRunning = false;
const inFlightChallenges = new Set<string>();
/** Rotate the bounded batch so a pending challenge cannot starve later ones. */
let rotationOffset = 0;

/** Reset the in-memory rotation cursor (used by isolated tests). */
export function resetVerificationAutoCheckRotationForTests(): void {
  rotationOffset = 0;
}

function readBoundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/** Read the automatic verification poll cadence in seconds (15..3600, default 60). */
export function readAutoCheckIntervalSeconds(): number {
  return readBoundedInt(
    'VERIFICATION_AUTO_CHECK_INTERVAL_SECONDS',
    DEFAULT_INTERVAL_SECONDS,
    MIN_INTERVAL_SECONDS,
    MAX_INTERVAL_SECONDS,
  );
}

/** Read the maximum official-API checks per poll (1..50, default 10). */
export function readAutoCheckBatchSize(): number {
  return readBoundedInt(
    'VERIFICATION_AUTO_CHECK_BATCH_SIZE',
    DEFAULT_BATCH_SIZE,
    MIN_BATCH_SIZE,
    MAX_BATCH_SIZE,
  );
}

function challengeKey(record: VerificationChallengeRecord): string {
  return JSON.stringify([record.guildId, record.discordUserId, record.targetTag]);
}

function safeText(value: string | null | undefined, maximum: number, fallback = 'unknown'): string {
  const sanitized = (value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/<[@#&][^>]*>/gi, '')
    .replace(/[<@>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (sanitized === '') return fallback;
  const characters = Array.from(sanitized);
  return characters.length <= maximum ? sanitized : `${characters.slice(0, maximum - 1).join('')}…`;
}

async function fetchDiscordUser(
  client: Client,
  discordUserId: string,
): Promise<DiscordUserView | null> {
  try {
    const user = await client.users.fetch(discordUserId);
    return user as unknown as DiscordUserView;
  } catch {
    return null;
  }
}

async function defaultNotifyUser(
  client: Client,
  input: { readonly discordUserId: string; readonly content: string },
): Promise<void> {
  const user = await fetchDiscordUser(client, input.discordUserId);
  if (user === null) return;
  await user.send({
    content: input.content,
    allowedMentions: { parse: [] },
  });
}

async function defaultLoadUsername(client: Client, discordUserId: string): Promise<string | null> {
  const user = await fetchDiscordUser(client, discordUserId);
  if (user === null) return null;
  return user.globalName ?? user.username ?? null;
}

function verifiedMessage(
  result: Extract<CheckVerificationResult, { readonly status: 'verified' }>,
): string {
  return [
    `✅ Verification complete for ${safeText(result.playerName, 60)} (#${safeText(result.playerTag, 20)}).`,
    `Required icon ${safeText(result.targetIconName, 60)} (ID ${result.targetIconId}) was confirmed via the official Brawl Stars API and linked to your BrawlHub account.`,
  ].join('\n');
}

async function handleVerified(
  client: Client,
  record: VerificationChallengeRecord,
  result: Extract<CheckVerificationResult, { readonly status: 'verified' }>,
  deps: VerificationAutoCheckDeps,
): Promise<void> {
  const notifyUser =
    deps.notifyUser ?? ((input) => defaultNotifyUser(client, input));
  const loadUsername =
    deps.loadUsername ?? ((discordUserId) => defaultLoadUsername(client, discordUserId));

  try {
    await notifyUser({
      discordUserId: record.discordUserId,
      content: verifiedMessage(result),
    });
  } catch (error) {
    logger.warn('Automatic verification could not DM the member', {
      guildId: record.guildId,
      discordUserId: record.discordUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let discordUsername: string | null = null;
  try {
    discordUsername = await loadUsername(record.discordUserId);
  } catch (error) {
    logger.warn('Automatic verification could not resolve a Discord username', {
      guildId: record.guildId,
      discordUserId: record.discordUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await (deps.notifyOperator ?? notifyVerificationCompleted)({
      guildId: record.guildId,
      playerName: result.playerName,
      playerTag: result.playerTag,
      discordUserId: record.discordUserId,
      discordUsername,
      method: 'icon-verified',
    });
  } catch (error) {
    logger.warn('Automatic verification operator notice failed', {
      guildId: record.guildId,
      discordUserId: record.discordUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // DM-only challenges have no guild roles to reconcile.
  if (record.guildId === 'dm') return;

  try {
    const roleResult = await (deps.reconcileRoles ?? reconcileGuildRolesForPlayer)(
      record.guildId,
      record.discordUserId,
      { client },
    );
    if (roleResult.kind === 'ok' && (roleResult.rolesAdded > 0 || roleResult.rolesRemoved > 0)) {
      logger.info('Automatic verification auto roles reconciled', {
        guildId: record.guildId,
        discordUserId: record.discordUserId,
        rolesAdded: roleResult.rolesAdded,
        rolesRemoved: roleResult.rolesRemoved,
      });
    }
  } catch (error) {
    logger.warn('Automatic verification auto role reconciliation failed', {
      guildId: record.guildId,
      discordUserId: record.discordUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const nickname = await (deps.syncNickname ?? syncNicknameAfterVerification)(
      client,
      record.guildId,
      record.discordUserId,
      { playerName: result.playerName, playerTag: result.playerTag },
    );
    if (nickname.kind === 'ok') {
      logger.info('Automatic verification nickname synced', {
        guildId: record.guildId,
        discordUserId: record.discordUserId,
      });
    } else if (nickname.kind !== 'unchanged') {
      logger.warn('Automatic verification nickname sync was not applied', {
        guildId: record.guildId,
        discordUserId: record.discordUserId,
        kind: nickname.kind,
      });
    }
  } catch (error) {
    logger.warn('Automatic verification nickname sync failed', {
      guildId: record.guildId,
      discordUserId: record.discordUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Poll active icon challenges with the official API and complete any whose
 * required icon is already visible. Pending mismatches stay active until the
 * normal 30-minute expiry; `/verify check` remains an immediate manual fallback.
 */
export async function runVerificationAutoCheck(
  client: Client,
  deps: VerificationAutoCheckDeps = {},
): Promise<VerificationAutoCheckSummary> {
  if (pollRunning) return EMPTY_SUMMARY;
  pollRunning = true;

  try {
    const now = (deps.now ?? Date.now)();
    const records = await (deps.listChallenges ?? listVerificationChallenges)();
    const batchSize = deps.batchSize ?? readAutoCheckBatchSize();
    const active = records
      .filter((record) => record.status === 'active' && record.expiresAt > now)
      .sort((a, b) => a.expiresAt - b.expiresAt || challengeKey(a).localeCompare(challengeKey(b)));
    const offset = active.length === 0 ? 0 : rotationOffset % active.length;
    const candidates = [...active.slice(offset), ...active.slice(0, offset)].slice(0, batchSize);
    rotationOffset = active.length === 0 ? 0 : (rotationOffset + candidates.length) % active.length;
    const summary: MutableSummary = { ...EMPTY_SUMMARY, candidates: active.length };

    for (const record of candidates) {
      const key = challengeKey(record);
      if (inFlightChallenges.has(key)) {
        summary.skipped += 1;
        continue;
      }
      inFlightChallenges.add(key);
      try {
        const result = await (deps.check ?? checkVerification)({
          discordUserId: record.discordUserId,
          guildId: record.guildId,
        });
        summary.checked += 1;

        if (!result.ok) {
          if (result.code === 'no-challenge' || result.code === 'expired') {
            summary.skipped += 1;
          } else {
            summary.failed += 1;
            logger.warn('Automatic verification check failed', {
              guildId: record.guildId,
              discordUserId: record.discordUserId,
              code: result.code,
            });
          }
          continue;
        }

        if (result.status === 'pending') {
          summary.pending += 1;
          continue;
        }

        await handleVerified(client, record, result, deps);
        summary.verified += 1;
      } catch (error) {
        summary.failed += 1;
        logger.warn('Automatic verification check threw', {
          guildId: record.guildId,
          discordUserId: record.discordUserId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        inFlightChallenges.delete(key);
      }
    }

    if (summary.verified > 0 || summary.failed > 0) {
      logger.info('Automatic verification poll finished', { ...summary });
    }
    return summary;
  } catch (error) {
    logger.error('Automatic verification poll failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return EMPTY_SUMMARY;
  } finally {
    pollRunning = false;
  }
}

/** Start the in-process auto-check schedule; returns a stop function for shutdown. */
export function startVerificationAutoCheckSchedule(client: Client): () => void {
  const intervalSeconds = readAutoCheckIntervalSeconds();
  const initialTimer = setTimeout(() => {
    void runVerificationAutoCheck(client);
  }, INITIAL_DELAY_MS);
  const timer = setInterval(() => {
    void runVerificationAutoCheck(client);
  }, intervalSeconds * 1000);

  logger.info('Automatic verification enabled', {
    intervalSeconds,
    batchSize: readAutoCheckBatchSize(),
    initialDelayMs: INITIAL_DELAY_MS,
  });

  return () => {
    clearTimeout(initialTimer);
    clearInterval(timer);
  };
}
