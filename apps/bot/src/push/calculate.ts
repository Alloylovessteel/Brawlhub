/** Pure lifecycle and scoring helpers for push competitions. */

import type {
  PushCompetitionRecord,
  PushCompetitionStatus,
  PushLeaderboardRow,
  PushSubmission,
} from './types';

/** Derive display status from timestamps; never promote a competition early. */
export function competitionStatus(
  competition: PushCompetitionRecord,
  now: Date = new Date(),
): PushCompetitionStatus {
  if (
    competition.endedAt !== null ||
    competition.status === 'ended' ||
    competition.status === 'cancelled'
  ) {
    return 'completed';
  }

  const nowMs = now.getTime();
  const startsAt = Date.parse(competition.startsAt);
  const endsAt = Date.parse(competition.endsAt);
  if (!Number.isNaN(startsAt) && nowMs < startsAt) return 'upcoming';
  if (!Number.isNaN(endsAt) && nowMs > endsAt) return 'completed';
  return 'active';
}

/** A missing baseline never becomes zero and never produces a gain. */
export function calculateGain(latestTrophies: number, baselineTrophies: number | null): number | null {
  return baselineTrophies === null ? null : latestTrophies - baselineTrophies;
}

/** Latest accepted submission per entry, with deterministic time/id ordering. */
export function latestAcceptedSubmissions(
  submissions: readonly PushSubmission[],
): Map<string, PushSubmission> {
  const latest = new Map<string, PushSubmission>();
  for (const submission of submissions) {
    if (!submission.accepted) continue;
    const existing = latest.get(submission.entryId);
    if (existing === undefined || submissionComesAfter(submission, existing)) {
      latest.set(submission.entryId, submission);
    }
  }
  return latest;
}

function submissionComesAfter(candidate: PushSubmission, existing: PushSubmission): boolean {
  const candidateAt = Date.parse(candidate.submittedAt);
  const existingAt = Date.parse(existing.submittedAt);
  if (candidateAt !== existingAt) return candidateAt > existingAt;
  return candidate.id.localeCompare(existing.id) > 0;
}

type UnrankedRow = Omit<PushLeaderboardRow, 'rank'>;

function compareRows(a: UnrankedRow, b: UnrankedRow): number {
  const aRanked = a.gain !== null;
  const bRanked = b.gain !== null;
  if (aRanked !== bRanked) return aRanked ? -1 : 1;

  if (aRanked && bRanked && a.gain !== b.gain) return b.gain - a.gain;

  const aTrophies = a.trophies;
  const bTrophies = b.trophies;
  if (aTrophies !== bTrophies) {
    if (aTrophies === null) return 1;
    if (bTrophies === null) return -1;
    return bTrophies - aTrophies;
  }

  const nameOrder = a.entry.player.name.localeCompare(b.entry.player.name);
  if (nameOrder !== 0) return nameOrder;
  const tagOrder = a.entry.player.tag.localeCompare(b.entry.player.tag);
  if (tagOrder !== 0) return tagOrder;
  return a.entry.id.localeCompare(b.entry.id);
}

/**
 * Rank by trophy gain. Entries without a usable baseline or accepted submission
 * remain unranked and are listed after ranked entries by latest trophies.
 * Equal gains share a position (1, 1, 3).
 */
export function rankPushRows(rows: readonly UnrankedRow[]): PushLeaderboardRow[] {
  const sorted = [...rows].sort(compareRows);
  let currentRank = 0;
  let previousGain: number | null | undefined;

  return sorted.map((row, index) => {
    if (row.gain === null) {
      return { ...row, rank: null };
    }
    if (previousGain === undefined || previousGain !== row.gain) {
      currentRank = index + 1;
      previousGain = row.gain;
    }
    return { ...row, rank: currentRank };
  });
}
