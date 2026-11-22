import { createHash, randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LOCK_PREFIX = 'brawlhub-bot-';
const ACQUIRE_ATTEMPTS = 4;

interface LockFileData {
  readonly token: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly key: string;
}

export interface SingleInstanceLock {
  readonly path: string;
  readonly token: string;
  readonly pid: number;
  readonly key: string;
  release(): Promise<void>;
}

export interface AcquireSingleInstanceLockOptions {
  /** Override the lock path, primarily for tests. */
  readonly lockPath?: string;
  /** Override the live-process check, primarily for tests. */
  readonly isProcessAlive?: (pid: number) => boolean;
}

export class SingleInstanceBusyError extends Error {
  readonly lockPath: string;
  readonly holderPid: number | null;

  constructor(message: string, lockPath: string, holderPid: number | null) {
    super(message);
    this.name = 'SingleInstanceBusyError';
    this.lockPath = lockPath;
    this.holderPid = holderPid;
  }
}

/** A stable lock path per checkout, kept outside the OneDrive-synced workspace. */
export function defaultSingleInstanceLockPath(): string {
  const key = createHash('sha256').update(resolve(PROJECT_ROOT)).digest('hex').slice(0, 16);
  return resolve(tmpdir(), `${LOCK_PREFIX}${key}.lock`);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

/** Treat EPERM as alive: the PID exists but is owned by another user. */
export function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoCode(error, 'EPERM');
  }
}

async function readLockFile(lockPath: string): Promise<LockFileData | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Partial<LockFileData>;
    if (
      typeof candidate.token !== 'string' ||
      candidate.token === '' ||
      typeof candidate.pid !== 'number' ||
      !Number.isInteger(candidate.pid) ||
      candidate.pid <= 0
    ) {
      return null;
    }
    return {
      token: candidate.token,
      pid: candidate.pid,
      startedAt: typeof candidate.startedAt === 'string' ? candidate.startedAt : '',
      key: typeof candidate.key === 'string' ? candidate.key : '',
    };
  } catch {
    return null;
  }
}

async function unlock(lockPath: string, token: string): Promise<void> {
  const current = await readLockFile(lockPath);
  if (current?.token !== token) return;
  try {
    await unlink(lockPath);
  } catch (error) {
    if (!isErrnoCode(error, 'ENOENT')) throw error;
  }
}

/** Release a lock only when this process still owns it. Safe to call twice. */
export async function releaseSingleInstanceLock(
  lock: SingleInstanceLock | undefined,
): Promise<void> {
  if (lock === undefined) return;
  await unlock(lock.path, lock.token);
}

/**
 * Acquire a local lock before connecting to Discord. A live holder makes the
 * second process fail fast; locks left by dead processes are cleaned up.
 */
export async function acquireSingleInstanceLock(
  options: AcquireSingleInstanceLockOptions = {},
): Promise<SingleInstanceLock> {
  const lockPath = options.lockPath ?? defaultSingleInstanceLockPath();
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const key = createHash('sha256').update(resolve(PROJECT_ROOT)).digest('hex').slice(0, 16);

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    const token = randomUUID();
    const payload: LockFileData = {
      token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      key,
    };

    try {
      await writeFile(lockPath, `${JSON.stringify(payload)}\n`, { flag: 'wx', encoding: 'utf8' });
      const lock: SingleInstanceLock = {
        path: lockPath,
        token,
        pid: payload.pid,
        key,
        release: () => unlock(lockPath, token),
      };
      return lock;
    } catch (error) {
      if (!isErrnoCode(error, 'EEXIST')) throw error;
    }

    const holder = await readLockFile(lockPath);
    if (holder !== null && isProcessAlive(holder.pid)) {
      throw new SingleInstanceBusyError(
        `Another BrawlHub bot instance is already running (pid ${holder.pid}). Refusing to start a second local process.`,
        lockPath,
        holder.pid,
      );
    }

    // Only remove the stale lock if it has not been replaced since we read it.
    const current = await readLockFile(lockPath);
    if (current?.token === holder?.token) {
      try {
        await unlink(lockPath);
      } catch (error) {
        if (!isErrnoCode(error, 'ENOENT')) throw error;
      }
    }
  }

  throw new Error(`Could not acquire the BrawlHub bot lock at ${lockPath} after repeated attempts`);
}
