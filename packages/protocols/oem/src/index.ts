/**
 * OEM protocol extension points (AGENTS 3, 13, 34.6).
 *
 * Manufacturer specifics must not leak into UI or diagnostic code. Instead an
 * OEM module registers hooks here and the engine consults them. Three hooks are
 * defined because those are the places where OEM knowledge actually changes
 * behaviour:
 *   - address → role mapping (discovery),
 *   - identification DIDs (ECU Explorer),
 *   - DTC interpretation (DTC system).
 *
 * A hook is optional in every case: without one, the generic path is used.
 */

export interface OemIdentificationHint {
  label: string;
  did: number;
  /** 'ascii' for printable identifiers, 'hex' otherwise. */
  encoding?: "ascii" | "hex";
}

export interface OemDtcInterpretation {
  code: string;
  description?: string;
  hint?: string;
  severity?: "info" | "minor" | "major" | "critical";
}

export interface OemProtocol {
  /** Manufacturer key, must match DefinitionPackage.oem. */
  readonly oem: string;
  /** Human readable name for logs and the UI. */
  readonly displayName: string;
  /** Provenance of the OEM knowledge (AGENTS 24). */
  readonly provenance: { sourceType: string; source: string };
  /** Map a discovered response identifier to a role, e.g. "engine". */
  identifyEcu?(rxId: number, extended: boolean): string | undefined;
  /** Additional identification DIDs for this manufacturer. */
  identificationDids?(ecuRole: string): OemIdentificationHint[];
  /** Interpret a DTC code this manufacturer uses. */
  interpretDtc?(code: string): OemDtcInterpretation | undefined;
}

export class OemProtocolRegistry {
  private readonly protocols = new Map<string, OemProtocol>();

  constructor(protocols: readonly OemProtocol[] = []) {
    for (const protocol of protocols) this.register(protocol);
  }

  register(protocol: OemProtocol): void {
    this.protocols.set(protocol.oem, protocol);
  }

  get(oem: string): OemProtocol | undefined {
    return this.protocols.get(oem);
  }

  list(): Array<{ oem: string; displayName: string; provenance: string }> {
    return Array.from(this.protocols.values()).map((protocol) => ({
      oem: protocol.oem,
      displayName: protocol.displayName,
      provenance: `${protocol.provenance.sourceType}: ${protocol.provenance.source}`,
    }));
  }

  /** First role any registered OEM protocol reports for this identifier. */
  identifyEcu(rxId: number, extended: boolean): { oem: string; role: string } | undefined {
    for (const protocol of this.protocols.values()) {
      const role = protocol.identifyEcu?.(rxId, extended);
      if (role) return { oem: protocol.oem, role };
    }
    return undefined;
  }

  /** Merge identification hints from every OEM protocol that claims the role. */
  identificationDids(oem: string | undefined, ecuRole: string): OemIdentificationHint[] {
    if (!oem) return [];
    return this.protocols.get(oem)?.identificationDids?.(ecuRole) ?? [];
  }

  interpretDtc(oem: string | undefined, code: string): OemDtcInterpretation | undefined {
    if (!oem) return undefined;
    return this.protocols.get(oem)?.interpretDtc?.(code);
  }
}

/**
 * Example OEM module.
 *
 * The knowledge below is invented placeholder data (provenance says so) and only
 * demonstrates the hook shape — never ship placeholder data as OEM truth
 * (AGENTS 24).
 */
export const vagExampleProtocol: OemProtocol = {
  oem: "vag",
  displayName: "VAG example (placeholder)",
  provenance: {
    sourceType: "example-placeholder",
    source: "invented example values, no OEM documentation used",
  },
  identifyEcu(rxId) {
    if (rxId === 0x7e8) return "engine";
    if (rxId === 0x7e9) return "transmission";
    return undefined;
  },
  identificationDids: (role) =>
    role === "engine"
      ? [
          { label: "Part number", did: 0xf187, encoding: "ascii" },
          { label: "Coding", did: 0x2002, encoding: "hex" },
        ]
      : [],
  interpretDtc: (code) =>
    code === "P1234"
      ? { code, description: "Example: boost pressure control deviation", severity: "minor" }
      : undefined,
};
