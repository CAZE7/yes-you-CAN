/**
 * TypedEmitter unit tests — co-located (testing standards).
 *
 * The emitter is the nervous system of the transport layer: subscription
 * lifecycle and mutation-during-emit semantics must be exact.
 */

import assert from 'node:assert/strict';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { TypedEmitter, type Disposable } from './events.js';

interface Events extends Record<string, unknown> {
  frame: number;
  error: Error;
}

describe('TypedEmitter', () => {
  test('delivers payloads to every subscriber', () => {
    const emitter = new TypedEmitter<Events>();
    const seen: number[] = [];
    emitter.on('frame', (n) => seen.push(n));
    emitter.on('frame', (n) => seen.push(n * 10));
    emitter.emit('frame', 3);
    assert.deepEqual(seen, [3, 30]);
  });

  test('off() and the Disposable from on() both unsubscribe', () => {
    const emitter = new TypedEmitter<Events>();
    const seen: number[] = [];
    const a = (n: number): void => void seen.push(n);
    const b = (n: number): void => void seen.push(n);
    const disposable = emitter.on('frame', a);
    emitter.on('frame', b);
    disposable.dispose();
    emitter.off('frame', b);
    emitter.emit('frame', 1);
    assert.deepEqual(seen, []);
    assert.equal(emitter.listenerCount('frame'), 0);
  });

  test('emit before any subscription is a no-op, not an error', () => {
    const emitter = new TypedEmitter<Events>();
    assert.equal(emitter.listenerCount('frame'), 0);
    assert.doesNotThrow(() => emitter.emit('frame', 1));
  });

  test('a listener that removes itself during emit does not break the loop', () => {
    const emitter = new TypedEmitter<Events>();
    const seen: string[] = [];
    const selfRemoving = (): void => {
      seen.push('a');
      disposable.dispose();
    };
    const disposable = emitter.on('frame', selfRemoving);
    emitter.on('frame', () => void seen.push('b'));
    emitter.emit('frame', 1);
    assert.deepEqual(seen, ['a', 'b']);
  });

  test('removeAllListeners clears every event', () => {
    const emitter = new TypedEmitter<Events>();
    emitter.on('frame', () => undefined);
    emitter.on('error', () => undefined);
    emitter.removeAllListeners();
    assert.equal(emitter.listenerCount('frame'), 0);
    assert.equal(emitter.listenerCount('error'), 0);
  });

  test('property: emit order matches subscription order for arbitrary listener counts', () => {
    fc.assert(
      fc.property(fc.nat({ max: 40 }), (count) => {
        const emitter = new TypedEmitter<Events>();
        const order: number[] = [];
        for (let i = 0; i < count; i++) {
          const expected = i;
          emitter.on('frame', () => order.push(expected));
        }
        emitter.emit('frame', 0);
        assert.deepEqual(order, Array.from({ length: count }, (_, i) => i));
        assert.equal(emitter.listenerCount('frame'), count);
      }),
    );
  });
});

describe('TypedEmitter — lifecycle edge cases', () => {
  test('the same listener function is registered once, not twice', () => {
    const emitter = new TypedEmitter<Events>();
    const seen: number[] = [];
    const shared = (n: number): void => void seen.push(n);
    emitter.on('frame', shared);
    emitter.on('frame', shared);
    assert.equal(emitter.listenerCount('frame'), 1, 'a Set stores an identical function once — no accidental double handling');
    emitter.emit('frame', 7);
    assert.deepEqual(seen, [7]);
  });

  test('off() on an unknown listener or unknown event is a no-op', () => {
    const emitter = new TypedEmitter<Events>();
    const keep = (n: number): void => void n;
    emitter.on('frame', keep);
    assert.doesNotThrow(() => emitter.off('frame', () => undefined));
    // A listener of the right shape for the other event, never registered there.
    assert.doesNotThrow(() => emitter.off('error', (error: Error): void => void error));
    assert.equal(emitter.listenerCount('frame'), 1, 'the registered listener survives');
    assert.equal(emitter.listenerCount('error'), 0);
  });

  test('disposable handles stay valid: an empty event reports zero, never throws', () => {
    const emitter = new TypedEmitter<Events>();
    const disposable = emitter.on('frame', () => undefined);
    disposable.dispose();
    disposable.dispose();
    assert.equal(emitter.listenerCount('frame'), 0);
    assert.doesNotThrow(() => emitter.emit('frame', 1));
  });

  test('events are independent of each other', () => {
    const emitter = new TypedEmitter<Events>();
    const frames: number[] = [];
    const errors: string[] = [];
    emitter.on('frame', (n) => frames.push(n));
    emitter.on('error', (error) => errors.push(error.message));
    emitter.emit('error', new Error('boom'));
    assert.deepEqual(frames, [], 'a frame listener never sees an error payload');
    assert.deepEqual(errors, ['boom']);
    assert.equal(emitter.listenerCount('frame'), 1);
    assert.equal(emitter.listenerCount('error'), 1);
  });

  test('the payload is delivered by reference, untouched', () => {
    const emitter = new TypedEmitter<{ event: { frames: number[] } } & Record<string, unknown>>();
    let received: { frames: number[] } | undefined;
    emitter.on('event', (payload) => {
      received = payload;
    });
    const payload = { frames: [1, 2, 3] };
    emitter.emit('event', payload);
    assert.equal(received, payload, 'no copying, no serialisation — the emitter is transparent');
  });

  test('a listener subscribed during an emit joins the next one, not the running one', () => {
    const emitter = new TypedEmitter<Events>();
    const seen: string[] = [];
    emitter.on('frame', () => {
      seen.push('first');
      emitter.on('frame', () => void seen.push('late'));
    });
    emitter.emit('frame', 1);
    assert.deepEqual(seen, ['first'], 'emit runs over the snapshot it took on entry');
    emitter.emit('frame', 2);
    assert.deepEqual(seen, ['first', 'first', 'late'], 'the new listener is live for the next emit');
  });

  test('a listener removed during an emit still runs in that emit', () => {
    const emitter = new TypedEmitter<Events>();
    const seen: string[] = [];
    let secondDisposable!: Disposable;
    emitter.on('frame', () => {
      seen.push('remover');
      secondDisposable.dispose();
    });
    secondDisposable = emitter.on('frame', () => void seen.push('removed'));
    emitter.emit('frame', 1);
    // Deliberate: iterating the live Set would let one listener change the set
    // being iterated and skip a handler — with a snapshot every notification
    // that was in flight when the emit started is delivered exactly once.
    assert.deepEqual(seen, ['remover', 'removed']);
    emitter.emit('frame', 2);
    assert.deepEqual(seen, ['remover', 'removed', 'remover'], 'and it is gone from the next emit on');
  });

  test('removeAllListeners mid-emit drains the emitter but not the running snapshot', () => {
    const emitter = new TypedEmitter<Events>();
    const seen: number[] = [];
    emitter.on('frame', () => {
      seen.push(1);
      emitter.removeAllListeners();
    });
    emitter.on('frame', () => void seen.push(2));
    emitter.emit('frame', 0);
    assert.deepEqual(seen, [1, 2]);
    assert.equal(emitter.listenerCount('frame'), 0);
    emitter.emit('frame', 0);
    assert.deepEqual(seen, [1, 2], 'nothing else is delivered afterwards');
  });

  test('subscribing again after removeAllListeners works', () => {
    const emitter = new TypedEmitter<Events>();
    const first = (): void => undefined;
    emitter.on('frame', first);
    emitter.removeAllListeners();
    const seen: number[] = [];
    emitter.on('frame', (n) => seen.push(n));
    emitter.on('frame', first);
    emitter.emit('frame', 3);
    assert.deepEqual(seen, [3]);
    assert.equal(emitter.listenerCount('frame'), 2);
  });

  test('a throwing listener aborts the emit and is not swallowed', () => {
    const emitter = new TypedEmitter<Events>();
    const seen: string[] = [];
    emitter.on('frame', () => {
      throw new Error('listener blew up');
    });
    emitter.on('frame', () => void seen.push('never'));
    assert.throws(() => emitter.emit('frame', 1), /listener blew up/);
    assert.deepEqual(seen, [], 'the emitter does not decide for its owner which errors to hide');
    // Registration survives: the failure is the listener's, not the emitter's.
    assert.equal(emitter.listenerCount('frame'), 2);
  });

  test('property: arbitrary on/off/dispose sequences keep the count exact', () => {
    type Op = { id: number; action: 'on' | 'off' | 'dispose' };
    fc.assert(
      fc.property(fc.array(fc.record({ id: fc.nat({ max: 12 }), action: fc.constantFrom('on' as const, 'off' as const, 'dispose' as const) }), { maxLength: 80 }), (ops: Op[]) => {
        const emitter = new TypedEmitter<Events>();
        const listeners = new Map<number, (n: number) => void>();
        const disposables = new Map<number, Disposable>();
        const live = new Set<number>();
        const delivered: number[] = [];

        for (const op of ops) {
          if (op.action === 'on') {
            if (live.has(op.id)) continue;
            const listener = (n: number): void => void delivered.push(n);
            listeners.set(op.id, listener);
            disposables.set(op.id, emitter.on('frame', listener));
            live.add(op.id);
          } else if (op.action === 'off') {
            const listener = listeners.get(op.id);
            if (!listener || !live.delete(op.id)) continue;
            emitter.off('frame', listener);
          } else {
            const disposable = disposables.get(op.id);
            if (!disposable || !live.delete(op.id)) continue;
            disposable.dispose();
          }
        }

        assert.equal(emitter.listenerCount('frame'), live.size, 'the count tracks the live listeners');
        emitter.emit('frame', 5);
        assert.equal(delivered.length, live.size, 'every live listener is called exactly once');
        assert.deepEqual(delivered, Array.from({ length: live.size }, () => 5));
      }),
      { numRuns: 300 },
    );
  });
});
