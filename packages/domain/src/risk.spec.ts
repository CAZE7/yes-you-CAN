import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { WRITE_OPERATION_KINDS, WRITE_OPERATION_POLICIES, isWriteOperationKind, policyForWriteOperation } from './index.js';

describe('write operation risk policy', () => {
  test('every write operation kind has a policy', () => {
    for (const kind of WRITE_OPERATION_KINDS) {
      const policy = policyForWriteOperation(kind);
      assert.ok(policy, `policy missing for ${kind}`);
      assert.ok(['low', 'medium', 'high'].includes(policy.risk));
    }
  });

  test('every write operation requires explicit confirmation', () => {
    for (const kind of WRITE_OPERATION_KINDS) {
      assert.equal(WRITE_OPERATION_POLICIES[kind].requiresConfirmation, true, `${kind} must require confirmation`);
    }
  });

  test('long coding, adaptation and flash are high risk and need backup + verification', () => {
    for (const kind of ['coding', 'adaptation', 'flash'] as const) {
      const policy = policyForWriteOperation(kind);
      assert.equal(policy.risk, 'high');
      assert.equal(policy.requiresBackup, true);
      assert.equal(policy.requiresVerification, true);
    }
  });

  test('clearing fault memory is verified by re-reading', () => {
    const policy = policyForWriteOperation('clear-dtc');
    assert.equal(policy.requiresVerification, true);
    assert.equal(policy.risk, 'medium');
  });

  test('the type guard only accepts known kinds', () => {
    assert.equal(isWriteOperationKind('coding'), true);
    assert.equal(isWriteOperationKind('read-dtc'), false);
  });
});
