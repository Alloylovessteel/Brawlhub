import { describe, expect, it } from 'vitest';
import { waitForInFlightWork } from './shutdown';

describe('waitForInFlightWork', () => {
  it('resolves immediately when there is no in-flight work', async () => {
    await expect(waitForInFlightWork(undefined, 10)).resolves.toBe(true);
  });

  it('waits for work that finishes before the timeout', async () => {
    let release: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = waitForInFlightWork(work, 100);
    release?.();
    await expect(result).resolves.toBe(true);
  });

  it('returns false when work exceeds the timeout', async () => {
    const work = new Promise<void>(() => {
      // Intentionally never resolves.
    });
    await expect(waitForInFlightWork(work, 10)).resolves.toBe(false);
  });

  it('treats a rejected promise as settled', async () => {
    const work = Promise.reject(new Error('boom'));
    await expect(waitForInFlightWork(work, 100)).resolves.toBe(true);
  });
});
