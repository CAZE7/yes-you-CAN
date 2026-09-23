/**
 * CAN database (DBC / OpenDBC) parser and converter to DefinitionPackage (ADR 0023/0024).
 *
 * Implements parsing of standard CAN DBC definitions:
 * - Messages (`BO_ <id> <name>: <dlc> <transmitter>`)
 * - Signals (`SG_ <name> : <start_bit>|<length>@<endianness><sign> (<factor>,<offset>) [<min>|<max>] "<unit>" <receivers>`)
 * - Comments (`CM_ SG_ <id> <name> "<comment>"`, `CM_ BO_ <id> "<comment>"`)
 *
 * Bridges the gap between open-source signal databases (e.g. commaai/opendbc) and
 * yes-you-CAN vehicle definition packages without manual TypeScript authoring.
 */

import type {
  DefinitionPackage,
  EcuDefinition,
  Endianness,
  Provenance,
  SignalDefinition,
  SignalEncoding,
} from "./schema.js";

export interface DbcSignal {
  name: string;
  startBit: number;
  bitLength: number;
  endianness: Endianness;
  signed: boolean;
  scale: number;
  offset: number;
  min?: number;
  max?: number;
  unit?: string;
  receivers: string[];
  description?: string;
}

export interface DbcMessage {
  id: number;
  extended: boolean;
  name: string;
  dlc: number;
  transmitter: string;
  signals: DbcSignal[];
  description?: string;
}

export interface DbcDatabase {
  messages: DbcMessage[];
  nodes: string[];
}

const MESSAGE_REGEX = /^BO_\s+(\d+)\s+([A-Za-z0-9_]+)\s*:\s*(\d+)\s+([A-Za-z0-9_]+)/;
const SIGNAL_REGEX =
  /^SG_\s+([A-Za-z0-9_]+)\s*(?:[mM\d]+)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(([^,]+),([^)]+)\)\s*\[([^|]+)\|([^\]]+)\]\s*"([^"]*)"\s*(.*)/;
const COMMENT_SIGNAL_REGEX = /^CM_\s+SG_\s+(\d+)\s+([A-Za-z0-9_]+)\s+"([^"]*)"/;
const COMMENT_MESSAGE_REGEX = /^CM_\s+BO_\s+(\d+)\s+"([^"]*)"/;

/** Parse a raw DBC file into messages, signals and metadata. */
export function parseDbc(dbcContent: string): DbcDatabase {
  const lines = dbcContent.split(/\r?\n/);
  const messages: DbcMessage[] = [];
  const nodesSet = new Set<string>();
  let currentMessage: DbcMessage | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    // Node definition: BU_: Node1 Node2 ...
    if (line.startsWith("BU_:")) {
      const parts = line.slice(4).trim().split(/\s+/);
      for (const p of parts) if (p) nodesSet.add(p);
      continue;
    }

    // Message definition: BO_
    const msgMatch = line.match(MESSAGE_REGEX);
    if (msgMatch) {
      const rawId = Number.parseInt(msgMatch[1] as string, 10);
      // In Vector DBC, extended CAN IDs have bit 31 set (0x80000000)
      const extended = (rawId & 0x80000000) !== 0 || rawId > 0x7ff;
      const canId = extended ? rawId & 0x1fffffff : rawId;
      const name = msgMatch[2] as string;
      const dlc = Number.parseInt(msgMatch[3] as string, 10);
      const transmitter = msgMatch[4] as string;
      if (transmitter) nodesSet.add(transmitter);

      currentMessage = {
        id: canId,
        extended,
        name,
        dlc,
        transmitter,
        signals: [],
      };
      messages.push(currentMessage);
      continue;
    }

    // Signal definition: SG_
    const sigMatch = line.match(SIGNAL_REGEX);
    if (sigMatch && currentMessage) {
      const name = sigMatch[1] as string;
      const startBit = Number.parseInt(sigMatch[2] as string, 10);
      const bitLength = Number.parseInt(sigMatch[3] as string, 10);
      const endianness: Endianness = sigMatch[4] === "1" ? "little" : "big";
      const signed = sigMatch[5] === "-";
      const scale = Number.parseFloat(sigMatch[6] as string);
      const offset = Number.parseFloat(sigMatch[7] as string);
      const minVal = Number.parseFloat(sigMatch[8] as string);
      const maxVal = Number.parseFloat(sigMatch[9] as string);
      const unit = sigMatch[10] as string;
      const receiversStr = (sigMatch[11] as string).trim();
      const receivers = receiversStr.length > 0 ? receiversStr.split(/\s*,\s*/) : [];

      currentMessage.signals.push({
        name,
        startBit,
        bitLength,
        endianness,
        signed,
        scale: Number.isFinite(scale) ? scale : 1,
        offset: Number.isFinite(offset) ? offset : 0,
        ...(Number.isFinite(minVal) ? { min: minVal } : {}),
        ...(Number.isFinite(maxVal) ? { max: maxVal } : {}),
        ...(unit.length > 0 ? { unit } : {}),
        receivers,
      });
      continue;
    }

    // Comments for signals: CM_ SG_
    const sigCommentMatch = line.match(COMMENT_SIGNAL_REGEX);
    if (sigCommentMatch) {
      const msgId = Number.parseInt(sigCommentMatch[1] as string, 10) & 0x1fffffff;
      const sigName = sigCommentMatch[2] as string;
      const comment = sigCommentMatch[3] as string;
      const msg = messages.find((m) => m.id === msgId);
      const sig = msg?.signals.find((s) => s.name === sigName);
      if (sig) sig.description = comment;
      continue;
    }

    // Comments for messages: CM_ BO_
    const msgCommentMatch = line.match(COMMENT_MESSAGE_REGEX);
    if (msgCommentMatch) {
      const msgId = Number.parseInt(msgCommentMatch[1] as string, 10) & 0x1fffffff;
      const comment = msgCommentMatch[2] as string;
      const msg = messages.find((m) => m.id === msgId);
      if (msg) msg.description = comment;
    }
  }

  return { messages, nodes: Array.from(nodesSet) };
}

function selectEncoding(bitLength: number, signed: boolean): SignalEncoding {
  if (bitLength <= 8) return signed ? "int8" : "uint8";
  if (bitLength <= 16) return signed ? "int16" : "uint16";
  if (bitLength <= 32) return signed ? "int32" : "uint32";
  return "uint32";
}

export interface DbcPackageOptions {
  oem: string;
  name: string;
  version?: string;
  provenanceSource?: string;
}

/**
 * Convert a DBC database into a valid yes-you-CAN `DefinitionPackage`.
 *
 * Each DBC transmitter node is mapped to an `EcuDefinition`. Signals are mapped to
 * `SignalDefinition` records indexed by ECU and message CAN ID.
 */
export function dbcToDefinitionPackage(
  dbcText: string,
  options: DbcPackageOptions,
): DefinitionPackage {
  const db = parseDbc(dbcText);
  const oem = options.oem.trim().toLowerCase();
  const version = options.version ?? "1.0.0";

  // Group messages by transmitter node
  const transmitterNodes = new Set<string>();
  for (const msg of db.messages) {
    transmitterNodes.add(msg.transmitter || "gateway");
  }
  if (transmitterNodes.size === 0) transmitterNodes.add("gateway");

  const ecus: EcuDefinition[] = [];
  const signals: SignalDefinition[] = [];

  for (const node of transmitterNodes) {
    const ecuId = node.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const nodeMessages = db.messages.filter((m) => (m.transmitter || "gateway") === node);
    const primaryMsg = nodeMessages[0];
    const txId = primaryMsg ? primaryMsg.id : 0x7e0;
    const rxId = primaryMsg ? (primaryMsg.id + 8) & 0x1fffffff : 0x7e8;

    ecus.push({
      id: ecuId,
      name: `${node} Control Unit`,
      protocol: "uds",
      address: {
        txId,
        rxId,
        extended: primaryMsg?.extended ?? false,
      },
      description: `Imported from DBC transmitter node ${node}`,
    });

    for (const msg of nodeMessages) {
      for (const sig of msg.signals) {
        const sigId = `${ecuId}.${sig.name.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
        const byteOffset = Math.floor(sig.startBit / 8);
        const bitOffset = sig.startBit % 8;
        const length = Math.max(1, Math.ceil(sig.bitLength / 8));

        signals.push({
          id: sigId,
          name: sig.name,
          ecu: ecuId,
          did: msg.id, // Maps CAN message ID as reading DID
          byteOffset,
          ...(bitOffset > 0 ? { bitOffset } : {}),
          ...(sig.bitLength < length * 8 ? { bitLength: sig.bitLength } : {}),
          length,
          encoding: selectEncoding(sig.bitLength, sig.signed),
          endianness: sig.endianness,
          ...(sig.scale !== 1 ? { scale: sig.scale } : {}),
          ...(sig.offset !== 0 ? { offsetValue: sig.offset } : {}),
          ...(sig.unit ? { unit: sig.unit } : {}),
          ...(sig.min !== undefined ? { min: sig.min } : {}),
          ...(sig.max !== undefined ? { max: sig.max } : {}),
          description: sig.description ?? `DBC Signal ${sig.name} from message ${msg.name}`,
        });
      }
    }
  }

  const provenance: Provenance = {
    sourceType: "community",
    source: options.provenanceSource ?? "DBC Database Import",
    version,
    retrievedAt: new Date().toISOString(),
  };

  return {
    schemaVersion: 3,
    oem,
    name: options.name,
    version,
    ecus,
    signals,
    vehicles: [],
    provenance,
  };
}
