import { beforeEach, describe, expect, it } from 'vitest';
import { ConfirmationError, ConfirmationStore } from './confirmations';

describe('ConfirmationStore', () => {
  let now: number;
  let store: ConfirmationStore<{ value: string }>;

  beforeEach(() => {
    now = 1_000_000;
    store = new ConfirmationStore<{ value: string }>(1000, () => now);
  });

  it('returns a payload for the bound actor and consumes it once', () => {
    const nonce = store.create('actor-1', { value: 'payload' });

    expect(store.take(nonce, 'actor-1')).toEqual({ value: 'payload' });
    expect(() => store.take(nonce, 'actor-1')).toThrowError(ConfirmationError);
  });

  it('rejects a different actor without consuming the confirmation', () => {
    const nonce = store.create('actor-1', { value: 'payload' });

    expect(() => store.take(nonce, 'actor-2')).toThrowError(/another user/);
    expect(store.take(nonce, 'actor-1')).toEqual({ value: 'payload' });
  });

  it('binds a confirmation to the guild supplied by the caller', () => {
    const nonce = store.create('actor-1', { value: 'payload' }, 'guild-1');

    expect(() => store.take(nonce, 'actor-1', 'guild-2')).toThrowError(/another user/);
    expect(store.take(nonce, 'actor-1', 'guild-1')).toEqual({ value: 'payload' });
  });

  it('rejects expired confirmations and removes them', () => {
    const nonce = store.create('actor-1', { value: 'payload' });
    now += 1001;

    expect(() => store.take(nonce, 'actor-1')).toThrowError(/expired/);
    expect(() => store.take(nonce, 'actor-1')).toThrowError(/no longer valid/);
  });

  it('rejects unknown nonces', () => {
    expect(() => store.take('missing', 'actor-1')).toThrowError(/no longer valid/);
  });

  it('clears all pending confirmations', () => {
    const nonce = store.create('actor-1', { value: 'payload' });
    store.clear();

    expect(() => store.take(nonce, 'actor-1')).toThrowError(/no longer valid/);
  });

  it('uses unique nonces', () => {
    const first = store.create('actor-1', { value: 'one' });
    const second = store.create('actor-1', { value: 'two' });

    expect(first).not.toBe(second);
  });
});
