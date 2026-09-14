/**
 * Stable ECU identity inside a golden session (master backlog P0 #10).
 *
 * `EcuSession.id` is generated per run (`ecu_…`), so it differs between the
 * recording and the replay. An expectation that stores it would fail on the second
 * run for a reason that has nothing to do with the vehicle — which is exactly the
 * kind of noise that makes a regression suite lose its authority (ADR 0036 §4).
 *
 * The stable identity is the definition ECU id (`engine`, `abs`) when the address
 * matched a definition, and the display name otherwise.
 */

export interface EcuIdentityLike {
  id: string;
  definitionEcuId?: string;
  name: string;
}

/** The identifier a golden expectation uses. */
export function stableEcuId(record: EcuIdentityLike): string {
  return record.definitionEcuId ?? record.name;
}

/** Resolve a per-run id (as it appears in scan results) to its stable identity. */
export function resolveStableEcuId(
  handles: readonly { session: { record: EcuIdentityLike } }[],
  generatedId: string,
): string {
  const handle = handles.find((entry) => entry.session.record.id === generatedId);
  return handle ? stableEcuId(handle.session.record) : generatedId;
}
