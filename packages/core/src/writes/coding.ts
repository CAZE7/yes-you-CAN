/**
 * ECU Coding operation (AGENTS 25, 26; master backlog P2 #31).
 *
 * Coding changes configuration bits/bytes in an ECU's non-volatile memory
 * (e.g. enabling daytime running lights on Byte 0 Bit 3, equipment options,
 * country-specific variants).
 *
 * Because coding changes the operational behaviour of the vehicle, it is classified
 * as HIGH risk and enforces the full transactional safety chain:
 *
 * 1. Prepare: Read and capture byte-accurate backup of the current coding data.
 * 2. Preview: Diff calculation showing exact byte/bit changes.
 * 3. Precheck: Verify vehicle safety preconditions (engine stopped, ignition on,
 *    voltage adequate, stationary).
 * 4. Permit: Formal permit request issued via SafetyManager.
 * 5. Confirm: Operator confirmation required.
 * 6. Write: Write new coding payload to ECU (e.g. UDS 0x2E WriteDataByIdentifier).
 * 7. Readback: Read back configuration from ECU.
 * 8. Verify: Assert readback matches the requested state byte-for-byte.
 * 9. Rollback: If verification fails, restore previous configuration from backup.
 * 10. Audit: Record permit, before/after hex, diff summary, and verification status.
 */

import { type Logger, createLogger, messageOf, toHex } from "@vdp/shared";
import type { RiskLevel, WritePermit, WriteRequestContext } from "../safety/safety-manager.js";
import type { WriteBinding, WriteOperation, WriteOperationResult, WritePort } from "./port.js";

/** An ECU that supports coding operations. */
export interface CodingTargetEcu {
  id: string;
  name: string;
  sessionType?: number;
  readCoding(did?: number): Promise<Uint8Array>;
  writeCoding(data: Uint8Array, did?: number): Promise<void>;
  prepareWrite?(sessionType?: number): Promise<{ sessionType: number; switched: boolean }>;
}

/** One specific bit or byte modification. */
export interface CodingChange {
  byteIndex: number;
  /** When defined (0..7), modifies only this bit; otherwise modifies the full byte. */
  bitIndex?: number;
  /** New value: 0 or 1 for bit modifications; 0..255 for full byte modifications. */
  value: number;
  description?: string;
}

export interface CodingInput {
  target: CodingTargetEcu;
  /** The Data Identifier for the coding block; default 0x0200. */
  did?: number;
  /** Changes to apply to the current coding. */
  changes: readonly CodingChange[];
  userConfirmed: boolean;
  notes?: string;
  recordAction?: (action: { kind: string; payload: unknown }) => void;
}

export interface CodingPrepared {
  target: CodingTargetEcu;
  did: number;
  originalBytes: Uint8Array;
  newBytes: Uint8Array;
  diffSummary: readonly string[];
  sessionType: number;
}

export interface CodingResult {
  did: number;
  before: Uint8Array;
  after: Uint8Array;
  diffSummary: readonly string[];
  verified: boolean;
  permit: WritePermit;
}

const DEFAULT_CODING_DID = 0x0200;

export function applyCodingChanges(
  original: Uint8Array,
  changes: readonly CodingChange[],
): { modified: Uint8Array; diffSummary: string[] } {
  const modified = new Uint8Array(original);
  const diffSummary: string[] = [];

  for (const change of changes) {
    if (change.byteIndex < 0 || change.byteIndex >= modified.length) {
      throw new Error(
        `byteIndex ${change.byteIndex} is outside coding payload length (${modified.length} bytes)`,
      );
    }
    const currentByte = modified[change.byteIndex] ?? 0;
    if (change.bitIndex !== undefined) {
      if (change.bitIndex < 0 || change.bitIndex > 7) {
        throw new Error(`bitIndex ${change.bitIndex} must be 0..7`);
      }
      if (change.value !== 0 && change.value !== 1) {
        throw new Error(`bit value ${change.value} must be 0 or 1`);
      }
      const mask = 1 << change.bitIndex;
      const oldBit = (currentByte & mask) !== 0 ? 1 : 0;
      const newByte = change.value === 1 ? currentByte | mask : currentByte & ~mask;
      modified[change.byteIndex] = newByte;
      const desc = change.description !== undefined ? ` (${change.description})` : "";
      diffSummary.push(
        `Byte ${change.byteIndex} Bit ${change.bitIndex}: ${oldBit} -> ${change.value}${desc}`,
      );
    } else {
      if (change.value < 0 || change.value > 255) {
        throw new Error(`byte value ${change.value} must be 0..255`);
      }
      modified[change.byteIndex] = change.value;
      const desc = change.description !== undefined ? ` (${change.description})` : "";
      diffSummary.push(
        `Byte ${change.byteIndex}: 0x${toHex(new Uint8Array([currentByte]))} -> 0x${toHex(new Uint8Array([change.value]))}${desc}`,
      );
    }
  }

  return { modified, diffSummary };
}

export function createCodingOperation(
  options: { logger?: Logger } = {},
): WriteOperation<CodingInput, CodingPrepared, CodingResult> {
  const log = options.logger ?? createLogger("writes", { level: "INFO" });

  return {
    kind: "coding",
    title: "ECU Coding (Configuration Write)",
    risk: "high" as RiskLevel,

    async prepare(_transaction, input) {
      const { target } = input;
      const did = input.did ?? DEFAULT_CODING_DID;

      let sessionType = target.sessionType ?? 0x01;
      if (target.prepareWrite) {
        try {
          // Coding typically requires extended diagnostic session (0x03)
          const switched = await target.prepareWrite(0x03);
          sessionType = switched.sessionType;
        } catch (error) {
          return {
            ok: false,
            reasons: [`ECU session switch for coding failed: ${messageOf(error)}`],
          };
        }
      }

      let originalBytes: Uint8Array;
      try {
        originalBytes = await target.readCoding(did);
      } catch (error) {
        return {
          ok: false,
          reasons: [
            `failed to read initial coding backup from DID 0x${did.toString(16)}: ${messageOf(error)}`,
          ],
        };
      }

      let modified: Uint8Array;
      let diffSummary: string[];
      try {
        const result = applyCodingChanges(originalBytes, input.changes);
        modified = result.modified;
        diffSummary = result.diffSummary;
      } catch (error) {
        return {
          ok: false,
          reasons: [`invalid coding modification: ${messageOf(error)}`],
        };
      }

      if (diffSummary.length === 0) {
        return {
          ok: false,
          reasons: ["no coding changes specified"],
        };
      }

      log.info("coding backup captured", {
        ecu: target.id,
        did: `0x${did.toString(16)}`,
        bytes: originalBytes.length,
        diffCount: diffSummary.length,
      });

      return {
        ok: true,
        value: {
          target,
          did,
          originalBytes,
          newBytes: modified,
          diffSummary,
          sessionType,
        },
      };
    },

    describe(transaction, input, prepared, sessionType) {
      const definitionVersion = transaction.snapshot.binding.definitionVersion;
      const context: WriteRequestContext = {
        ecuId: input.target.id,
        ecuName: input.target.name,
        newValue: prepared !== undefined ? toHex(prepared.newBytes) : "coding-change",
        risk: "high",
        userConfirmed: input.userConfirmed,
        backupAvailable: prepared !== undefined,
        activeSessionType: sessionType,
        ...(definitionVersion !== undefined ? { definitionVersion } : {}),
      };
      const warnings: string[] = [];
      if (sessionType === 0x01) {
        warnings.push("coding write attempted in default diagnostic session");
      }
      return { context, warnings };
    },

    async execute(_transaction, input, prepared, permit) {
      const { target, did, newBytes } = prepared;
      input.recordAction?.({
        kind: "coding-write",
        payload: {
          did,
          newBytes: toHex(newBytes),
          permitId: permit.id,
        },
      });

      try {
        await target.writeCoding(newBytes, did);
      } catch (error) {
        return {
          ok: false,
          reasons: [`failed to write coding data to ECU: ${messageOf(error)}`],
        };
      }

      return {
        ok: true,
        value: {
          did,
          before: prepared.originalBytes,
          after: newBytes,
          diffSummary: prepared.diffSummary,
          verified: false,
          permit,
        },
      };
    },

    async verify(_transaction, _input, prepared, executed) {
      const { target, did } = prepared;
      let readBack: Uint8Array;
      try {
        readBack = await target.readCoding(did);
      } catch (error) {
        return {
          ok: false,
          reasons: [`verification readback failed: ${messageOf(error)}`],
        };
      }

      const match =
        readBack.length === executed.after.length &&
        readBack.every((byte, idx) => byte === executed.after[idx]);

      if (!match) {
        return {
          ok: false,
          reasons: [
            `read-back coding (0x${toHex(readBack)}) does not match written configuration (0x${toHex(executed.after)})`,
          ],
        };
      }

      return {
        ok: true,
        value: {
          ...executed,
          after: readBack,
          verified: true,
        },
      };
    },

    async rollback(transaction, _input, reason) {
      const prepared = transaction.value<CodingPrepared>("prepare");
      if (!prepared) {
        return {
          ok: false,
          reasons: ["cannot roll back coding: no backup was captured in prepare"],
        };
      }
      try {
        log.warn("rolling back coding to previous backup", { reason });
        await prepared.target.writeCoding(prepared.originalBytes, prepared.did);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reasons: [`failed to roll back coding: ${messageOf(error)}`],
        };
      }
    },

    outcomeOf(value) {
      return value.verified;
    },

    onAbort(_transaction, input, reason) {
      input.recordAction?.({
        kind: "coding-aborted",
        payload: { ecuId: input.target.id, reason },
      });
    },
  };
}

export function runCoding(
  port: WritePort,
  input: CodingInput,
  binding: WriteBinding,
): Promise<WriteOperationResult<CodingResult>> {
  return port.run<CodingInput, CodingPrepared, CodingResult>("coding", input, binding);
}
