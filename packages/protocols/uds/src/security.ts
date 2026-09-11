/**
 * Security Access (service 0x27) abstraction.
 *
 * AGENTS 9: "0x27 Security Access (zunächst nur abstrahieren)".
 * AGENTS 34 rules 12 + 25: we do NOT ship any algorithm that defeats a
 * manufacturer's protection (SFD/SFD2, seed&key). The default implementation
 * therefore refuses; a workshop may plug in an algorithm they are entitled to
 * use, and every attempt is written to the audit log.
 */

export interface SeedKeyContext {
  securityLevel: number;
  seed: Uint8Array;
  /** Optional security access data record (e.g. certificate id). */
  record?: Uint8Array;
  /** ECU label for logging. */
  ecu?: string;
}

export interface SeedKeyAlgorithm {
  readonly id: string;
  /** Human readable provenance — required for the audit trail. */
  readonly provenance: string;
  computeKey(context: SeedKeyContext): Promise<Uint8Array>;
}

export class SecurityAccessRefusedError extends Error {
  constructor(
    readonly securityLevel: number,
    readonly reason: string,
  ) {
    super(`Security access level ${securityLevel} refused: ${reason}`);
    this.name = "SecurityAccessRefusedError";
  }
}

/** Default policy: no key generation at all. */
export const refuseAllSecurityAccess: SeedKeyAlgorithm = {
  id: "refuse-all",
  provenance: "built-in safety default — no seed&key computation (AGENTS 34.12)",
  computeKey: async (context) => {
    throw new SecurityAccessRefusedError(
      context.securityLevel,
      "no seed&key algorithm is registered. Registering one requires explicit authorization for this ECU/manufacturer.",
    );
  },
};

/**
 * Test-only algorithm: key = seed XOR pattern. Clearly labelled so it can never
 * be mistaken for a real manufacturer algorithm, and only useful against the
 * bundled simulator.
 */
export function xorSeedKeyAlgorithm(pattern: number, id = "xor-test"): SeedKeyAlgorithm {
  return {
    id,
    provenance: "test/simulator only — XOR pattern, not a real manufacturer algorithm",
    computeKey: async ({ seed }) => seed.map((byte) => byte ^ pattern),
  };
}
