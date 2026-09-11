/**
 * TypedEmitter unit tests — co-located (testing standards).
 *
 * The emitter is the nervous system of the transport layer: subscription
 * lifecycle and mutation-during-emit semantics must be exact.
 */

import assert from 'node:assert/strict';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { TypedEmitter } from './events.js';

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
