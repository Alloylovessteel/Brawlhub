import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireSingleInstanceLock,
  releaseSingleInstanceLock,
  SingleInstanceBusyError,
} from './single-instance';

let directory: string;
let lockPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'brawlhub-single-instance-'));
  lockPath = join(directory, 'bot.lock');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function writeLock(token: string, pid: number): Promise<void> {
  await writeFile(
    lockPath,
    `${JSON.stringify({ token, pid, startedAt: new Date().toISOString(), key: 'test' })}\n`,
  );
}

describe('single-instance lock', () => {
  it('acquires, releases and reacquires the lock', async () => {
    const first = await acquireSingleInstanceLock({ lockPath });
    expect(first.pid).toBe(process.pid);

    await first.release();
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const second = await acquireSingleInstanceLock({ lockPath });
    expect(second.token).not.toBe(first.token);
    await second.release();
  });

  it('refuses to start while a live local instance holds the lock', async () => {
    await writeLock('live-holder', process.pid);

    await expect(acquireSingleInstanceLock({ lockPath })).rejects.toMatchObject({
      name: 'SingleInstanceBusyError',
      lockPath,
      holderPid: process.pid,
    });
    await expect(writeLiveHolderStillPresent()).resolves.toContain('live-holder');
  });

  it('replaces a lock left by a dead process', async () => {
    await writeLock('stale-holder', 999_999_999);
    const isProcessAlive = vi.fn(() => false);

    const lock = await acquireSingleInstanceLock({ lockPath, isProcessAlive });

    expect(isProcessAlive).toHaveBeenCalledWith(999_999_999);
    expect(lock.pid).toBe(process.pid);
    await expect(readFile(lockPath, 'utf8')).resolves.not.toContain('stale-holder');
    await lock.release();
  });

  it('never removes a lock that was replaced after acquisition', async () => {
    const lock = await acquireSingleInstanceLock({ lockPath });
    await writeLock('new-owner', process.pid);

    await releaseSingleInstanceLock(lock);

    await expect(readFile(lockPath, 'utf8')).resolves.toContain('new-owner');
  });

  it('exposes a typed busy error', async () => {
    await writeLock('live-holder', process.pid);

    await expect(acquireSingleInstanceLock({ lockPath })).rejects.toBeInstanceOf(
      SingleInstanceBusyError,
    );
  });
});

async function writeLiveHolderStillPresent(): Promise<string> {
  return await readFile(lockPath, 'utf8');
}
