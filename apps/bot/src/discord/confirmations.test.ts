import { beforeEach, describe, expect, it } from 'vitest';
import { clearStateCachesForTests } from '../state/index.js';
import { ConfirmationError, ConfirmationStore } from './confirmations';

function storeFor(command: string, now: () => number): ConfirmationStore<{ value: string }> {
  return new ConfirmationStore<{ value: string }>(1000, now, command);
}

describe('ConfirmationStore', () => {
  let now: number;
  let store: ConfirmationStore<{ value: string }>;

  beforeEach(() => {
    clearStateCachesForTests();
    now = Date.now();
    store = storeFor(`confirmation-test-${Math.random()}`, () => now);
  });

  it('returns a payload for the bound actor and consumes it once', async () => {
    const nonce = store.create('actor-1', { value: 'payload' });

    await expect(store.take(nonce, 'actor-1')).resolves.toEqual({ value: 'payload' });
    await expect(store.take(nonce, 'actor-1')).rejects.toThrowError(ConfirmationError);
  });

  it('rejects a different actor without consuming the confirmation', async () => {
    const nonce = store.create('actor-1', { value: 'payload' });

    await expect(store.take(nonce, 'actor-2')).rejects.toThrowError(/another user/);
    await expect(store.take(nonce, 'actor-1')).resolves.toEqual({ value: 'payload' });
  });

  it('binds a confirmation to the guild supplied by the caller', async () => {
    const nonce = store.create('actor-1', { value: 'payload' }, 'guild-1');

    await expect(store.take(nonce, 'actor-1', 'guild-2')).rejects.toThrowError(/another user/);
    await expect(store.take(nonce, 'actor-1', 'guild-1')).resolves.toEqual({ value: 'payload' });
  });

  it('rejects expired confirmations and removes them', async () => {
    const nonce = store.create('actor-1', { value: 'payload' });
    now += 1001;

    await expect(store.take(nonce, 'actor-1')).rejects.toThrowError(/expired/);
    await expect(store.take(nonce, 'actor-1')).rejects.toThrowError(/no longer valid/);
  });

  it('rejects unknown nonces', async () => {
    await expect(store.take('missing', 'actor-1')).rejects.toThrowError(/no longer valid/);
  });

  it('clears all pending confirmations', async () => {
    const nonce = store.create('actor-1', { value: 'payload' });
    store.clear();

    await expect(store.take(nonce, 'actor-1')).rejects.toThrowError(/no longer valid/);
  });

  it('uses unique nonces', () => {
    const first = store.create('actor-1', { value: 'one' });
    const second = store.create('actor-1', { value: 'two' });

    expect(first).not.toBe(second);
  });

  it('consumes a restored confirmation on the first click after restart', async () => {
    const command = 'confirmation-restore-test';
    const creator = storeFor(command, () => now);
    const nonce = creator.create('actor-1', { value: 'payload' }, 'guild-1');
    const restored = storeFor(command, () => now);

    await expect(restored.take(nonce, 'actor-1', 'guild-1')).resolves.toEqual({ value: 'payload' });
  });

  it('does not return a payload when another mirror already consumed the nonce', async () => {
    const command = 'confirmation-race-test';
    const creator = storeFor(command, () => now);
    const mirror = storeFor(command, () => now);
    const nonce = creator.create('actor-1', { value: 'payload' }, 'guild-1');

    await expect(mirror.take(nonce, 'other-actor', 'guild-1')).rejects.toThrowError(/another user/);
    await expect(creator.take(nonce, 'actor-1', 'guild-1')).resolves.toEqual({ value: 'payload' });
    await expect(mirror.take(nonce, 'actor-1', 'guild-1')).rejects.toThrowError(/no longer valid/);
  });
});
