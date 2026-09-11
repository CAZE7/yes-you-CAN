import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { DIAGNOSTIC_EVENT_NAMES, type DiagnosticEventMap, type DiagnosticEventName } from './index.js';

describe('domain event catalogue', () => {
  test('the catalogue is closed and stable', () => {
    // A change here means an event was added/renamed — that is a deliberate
    // API decision (consumers subscribe by name), so the test forces a review.
    assert.deepEqual(
      [...DIAGNOSTIC_EVENT_NAMES].sort(),
      [
        'action-executed',
        'diagnostic-error',
        'did-read',
        'dtcs-cleared',
        'dtcs-read',
        'ecu-capabilities-updated',
        'ecu-discovered',
        'measurements-recorded',
        'safety-approval-denied',
        'safety-approval-granted',
        'safety-approval-requested',
        'vehicle-connected',
        'vehicle-disconnected',
      ],
    );
  });

  test('every catalogue name is a key of the payload map', () => {
    const names = DIAGNOSTIC_EVENT_NAMES as readonly DiagnosticEventName[];
    const check: Record<keyof DiagnosticEventMap, true> = Object.fromEntries(
      names.map((name) => [name, true]),
    ) as Record<keyof DiagnosticEventMap, true>;
    assert.equal(Object.keys(check).length, names.length);
  });
});
