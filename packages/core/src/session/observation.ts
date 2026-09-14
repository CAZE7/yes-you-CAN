/**
 * Session observations: the stored session seen through the diagnostic IR
 * (master backlog P0 #6; AGENTS 10, 12, 17).
 *
 * `VehicleSessionData` is the record the storage layer keeps; the IR observation
 * is the same facts *with their evidence attached and their absences named*. Two
 * consumers need that and neither of them may rebuild it on their own:
 *
 * - a **report** has to say which ECU never answered and which code nobody
 *   documented — a gap is a finding, not an empty row (ADR 0033);
 * - a **replay or an AI** has to know which definition version, which adapter and
 *   which bus a statement was made on, or the answer is not reproducible (AGENTS 13).
 *
 * The projections below are total and pure: they read what is in the session and
 * write nothing. `session.data.ecus` stays the single source of truth — an
 * observation is derived on request, so a reloaded session produces the same
 * observation as the live one, byte for byte.
 */

import {
  type DtcObservation,
  type EcuObservation,
  type SessionObservation,
  ecuObservation,
  sessionObservation,
} from "@vdp/diagnostic-ir";
import { dtcObservationOf } from "../dtc/scanner.js";
import type { DtcSnapshot, EcuSession, VehicleSessionData } from "./session.js";

/**
 * Byte fields of a stored record, back as bytes.
 *
 * Exported because every projection that reads *stored* byte fields has the same
 * problem, and a second place that half-fixes it is worse than one that does not.
 *
 * `session.json` is `JSON.stringify` of the session (AGENTS 10), and JSON has no
 * byte array: a freeze frame written as `Uint8Array([0x0c, 0x30])` comes back as
 * `{"0":12,"1":48}` while the type of the record still says `Uint8Array`. The
 * projection is where that has to be repaired — a reader that calls `.length` or
 * `toHex` on the value would otherwise see an object (ADR 0004: a stored file is a
 * file another build wrote, AGENTS 34.14). A live session keeps its bytes and is
 * returned untouched.
 */
export function storedBytes(value: Uint8Array | undefined): Uint8Array | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Uint8Array) return value;
  const record = value as unknown as Record<string, unknown>;
  const keys = Object.keys(record);
  const bytes = new Uint8Array(keys.length);
  for (let index = 0; index < keys.length; index += 1) {
    const byte = record[String(index)];
    // Anything that is not an indexed byte list is not a byte list: the projection
    // refuses to guess, and the freeze frame stays absent instead of turning into
    // plausible garbage (AGENTS 24). An empty object stays an empty snapshot.
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      return undefined;
    }
    bytes[index] = byte;
  }
  return bytes;
}

/** One ECU of a session as an observation, with the reason it is unusable when it is. */
export function ecuObservationOf(ecu: EcuSession, at?: string): EcuObservation {
  return ecuObservation({
    ecuId: ecu.id,
    ...(ecu.definitionEcuId !== undefined ? { definitionEcuId: ecu.definitionEcuId } : {}),
    name: ecu.name,
    protocol: ecu.protocol,
    txId: ecu.txId,
    rxId: ecu.rxId,
    extended: ecu.extended,
    reachable: ecu.reachable,
    sessionType: ecu.sessionType,
    p2Ms: ecu.timing.p2Ms,
    p2StarMs: ecu.timing.p2StarMs,
    supportedServices: ecu.supportedServices,
    ...(ecu.lastError !== undefined ? { lastError: ecu.lastError } : {}),
    identification: ecu.identification.map((entry) => ({
      label: entry.label,
      value: entry.value,
      ...(entry.did !== undefined ? { did: entry.did } : {}),
    })),
    ...(at !== undefined ? { at } : {}),
  });
}

/**
 * The whole session as one observation.
 *
 * `at` of an ECU is the session's own time window — the moment the ECU list was
 * last true (`endedAt` while a session runs it is `startedAt`, which is the
 * honest fallback: nothing in the record says when the list changed, and an
 * invented timestamp would be a claim without evidence).
 */
export function sessionObservationOf(data: VehicleSessionData): SessionObservation {
  const at = data.endedAt ?? data.startedAt;
  const { adapter, transport } = data;
  return sessionObservation({
    sessionId: data.id,
    adapter: {
      kind: adapter.kind,
      id: adapter.id,
      name: adapter.name,
      ...(adapter.firmware !== undefined ? { firmware: adapter.firmware } : {}),
      ...(adapter.serial !== undefined ? { serial: adapter.serial } : {}),
      channels: [...adapter.channels],
    },
    transport: {
      kind: transport.kind,
      channel: transport.channel,
      mtu: transport.mtu,
      ...(transport.txId !== undefined ? { txId: transport.txId } : {}),
      ...(transport.rxId !== undefined ? { rxId: transport.rxId } : {}),
      ...(transport.extended !== undefined ? { extended: transport.extended } : {}),
    },
    startedAt: data.startedAt,
    ...(data.endedAt !== undefined ? { endedAt: data.endedAt } : {}),
    ecus: data.ecus.map((ecu) => ecuObservationOf(ecu, at)),
  });
}

/**
 * Fault-memory records as IR observations.
 *
 * Without an argument the last stored snapshot is used — the same one reports
 * read. Pass a snapshot to project an earlier scan, e.g. the "before a clear"
 * backup that `dtc-clear` stores next to the live state.
 */
export function dtcObservationsOf(
  data: VehicleSessionData,
  snapshot?: DtcSnapshot,
): DtcObservation[] {
  const source = snapshot ?? data.dtcSnapshots.at(-1);
  if (source === undefined) return [];
  return source.records.map((record) => {
    const freezeFrame = storedBytes(record.snapshot);
    const extendedData = storedBytes(record.extendedData);
    // The stored fields are taken out by destructuring, not overwritten: whatever
    // the file held for them must not survive the check that refused it.
    const { snapshot: _storedFrame, extendedData: _storedExtra, ...rest } = record;
    return dtcObservationOf(
      {
        ...rest,
        ...(freezeFrame !== undefined ? { snapshot: freezeFrame } : {}),
        ...(extendedData !== undefined ? { extendedData } : {}),
      },
      source.takenAt,
    );
  });
}

/**
 * What a session observation could *not* establish, as one line each.
 *
 * This is the list a report and the workbench show as "open questions": ECUs that
 * were discovered but never answered, codes that no definition documents, and the
 * scan count that says whether "new" is a first scan or a real second opinion.
 * Every entry is a fact the session already holds — the point of putting them here
 * is that nobody has to re-derive them (and cannot derive them differently).
 *
 * Not to be confused with the IR's `SignalGap`: that one is *one value* that could
 * not be read, this one is *a question the session as a whole leaves open*.
 */
export interface SessionGap {
  /** Stable machine key, so a UI can style it without matching on prose. */
  kind: "ecu-unreachable" | "dtc-undocumented" | "no-scan-history" | "no-measurements";
  subject: string;
  detail: string;
}

export function sessionGapsOf(data: VehicleSessionData): SessionGap[] {
  const gaps: SessionGap[] = [];
  for (const ecu of data.ecus) {
    if (!ecu.reachable) {
      gaps.push({
        kind: "ecu-unreachable",
        subject: ecu.name,
        detail: ecu.lastError ?? "the ECU answered discovery but no session could be opened",
      });
    }
  }
  const records = data.dtcSnapshots.at(-1)?.records ?? [];
  for (const record of records) {
    if (record.description !== undefined) continue;
    gaps.push({
      kind: "dtc-undocumented",
      subject: record.code,
      // The IR sentence the scan stored, when it stored one: a report must not
      // restate in its own words what the observation already says (AGENTS 24).
      detail:
        record.evidence ??
        `no description is documented for this code (${record.ecuName ?? "unknown ECU"})`,
    });
  }
  if (data.dtcSnapshots.length < 2 && records.length > 0) {
    gaps.push({
      kind: "no-scan-history",
      subject: "fault memory",
      detail: `${data.dtcSnapshots.length} scan(s) stored — "new" cannot be decided against a previous scan`,
    });
  }
  if (data.measurements.length === 0) {
    gaps.push({
      kind: "no-measurements",
      subject: "signals",
      detail: "no signal was recorded — a diagnosis rests on the fault memory alone",
    });
  }
  return gaps;
}
