/**
 * Risk classification for write operations (target architecture §15:
 * "Safety muss eine eigene Domain sein").
 *
 * Every write operation kind carries a fixed policy: risk level, whether an
 * explicit confirmation is required, whether a backup must exist first and
 * whether the result must be verified by reading back. The safety chain in
 * the runtime enforces the policy; this module only *defines* it so callers
 * (UI pre-checks, audit, tests) can talk about risk without touching the
 * safety implementation.
 */

export type RiskLevel = 'low' | 'medium' | 'high';

export type WriteOperationKind =
  | 'clear-dtc'
  | 'write-did'
  | 'routine'
  | 'io-control'
  | 'security-access'
  | 'coding'
  | 'adaptation'
  | 'flash';

export interface WriteOperationPolicy {
  risk: RiskLevel;
  requiresConfirmation: boolean;
  requiresBackup: boolean;
  requiresVerification: boolean;
}

export const WRITE_OPERATION_KINDS: readonly WriteOperationKind[] = [
  'clear-dtc',
  'write-did',
  'routine',
  'io-control',
  'security-access',
  'coding',
  'adaptation',
  'flash',
];

export const WRITE_OPERATION_POLICIES: Readonly<Record<WriteOperationKind, WriteOperationPolicy>> = {
  // Clearing destroys diagnostic history; the before-snapshot is the backup.
  'clear-dtc': { risk: 'medium', requiresConfirmation: true, requiresBackup: false, requiresVerification: true },
  'write-did': { risk: 'medium', requiresConfirmation: true, requiresBackup: true, requiresVerification: true },
  routine: { risk: 'medium', requiresConfirmation: true, requiresBackup: false, requiresVerification: true },
  'io-control': { risk: 'medium', requiresConfirmation: true, requiresBackup: false, requiresVerification: false },
  'security-access': { risk: 'high', requiresConfirmation: true, requiresBackup: false, requiresVerification: false },
  coding: { risk: 'high', requiresConfirmation: true, requiresBackup: true, requiresVerification: true },
  adaptation: { risk: 'high', requiresConfirmation: true, requiresBackup: true, requiresVerification: true },
  flash: { risk: 'high', requiresConfirmation: true, requiresBackup: true, requiresVerification: true },
};

export function isWriteOperationKind(value: string): value is WriteOperationKind {
  return (WRITE_OPERATION_KINDS as readonly string[]).includes(value);
}

export function policyForWriteOperation(kind: WriteOperationKind): WriteOperationPolicy {
  return WRITE_OPERATION_POLICIES[kind];
}
