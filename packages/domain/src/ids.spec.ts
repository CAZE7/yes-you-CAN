import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { ID_PREFIXES, asId, asIdOfKind, hasIdPrefix, type EcuId, type SessionId } from './index.js';

describe('typed identifiers', () => {
  test('asId adopts a string as a branded id without changing it', () => {
    const id = asId<EcuId>('ecu_abc');
    assert.equal(id, 'ecu_abc');
  });

  test('hasIdPrefix checks the conventional prefix per kind', () => {
    assert.equal(hasIdPrefix('ecu_123', 'ecu'), true);
    assert.equal(hasIdPrefix('session_123', 'session'), true);
    assert.equal(hasIdPrefix('session_123', 'ecu'), false);
    assert.equal(hasIdPrefix('ecux', 'ecu'), false);
  });

  test('asIdOfKind accepts matching prefixes and rejects others', () => {
    const session = asIdOfKind<SessionId>('session', 'session_1');
    assert.equal(session, 'session_1');
    assert.throws(() => asIdOfKind<SessionId>('session', 'ecu_1'), /expected a session id/);
  });

  test('every id kind has a prefix', () => {
    const kinds = ['vehicle', 'session', 'ecu', 'trace', 'action', 'definition', 'measurement', 'event'] as const;
    for (const kind of kinds) {
      assert.ok(ID_PREFIXES[kind], `prefix missing for ${kind}`);
    }
  });
});
