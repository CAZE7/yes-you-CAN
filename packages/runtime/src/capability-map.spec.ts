import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { UDS_SERVICE_CAPABILITIES, capabilitiesFromServices } from './index.js';

describe('UDS service → capability bridge', () => {
  test('probed services become capabilities', () => {
    assert.deepEqual(capabilitiesFromServices([0x10, 0x19, 0x22, 0x3e]), ['read-did', 'read-dtc', 'session-control', 'tester-present']);
  });

  test('write services map to write capabilities', () => {
    const capabilities = capabilitiesFromServices([0x14, 0x2e, 0x31]);
    assert.ok(capabilities.includes('clear-dtc'));
    assert.ok(capabilities.includes('write-did'));
    assert.ok(capabilities.includes('routine-control'));
  });

  test('unknown service ids are ignored, duplicates collapse', () => {
    assert.deepEqual(capabilitiesFromServices([0x99, 0x22, 0x22]), ['read-did']);
    assert.deepEqual(capabilitiesFromServices([]), []);
  });

  test('output is sorted for stable UIs', () => {
    const capabilities = capabilitiesFromServices([0x3e, 0x10, 0x19]);
    assert.deepEqual(capabilities, [...capabilities].sort());
  });

  test('coding/adaptation/flash are not bound to a bare service id', () => {
    const granted = new Set(Object.values(UDS_SERVICE_CAPABILITIES));
    assert.equal(granted.has('coding'), false);
    assert.equal(granted.has('adaptation'), false);
    assert.equal(granted.has('flash'), false);
  });
});
