/**
 * The fault-memory sweep of a harvest (ADR 0058, ISO 14229-1 §11.3.4).
 *
 * Four questions, in the order that makes each later one cheaper:
 *
 * 1. `0x19 0x01` — how many codes are there, and which status bits does this ECU
 *    implement (the availability mask)?
 * 2. `0x19 0x03` — which codes have freeze frames, and how many records each?
 *    Without this, reading "every freeze frame" means guessing record numbers.
 * 3. `0x19 0x02` — the codes with their status bytes.
 * 4. `0x19 0x04` / `0x19 0x06` — the snapshot and extended records behind them,
 *    raw, because their layout is manufacturer knowledge this tool does not have.
 *
 * Every stage catches its own failure and reports it as a gap: an ECU that does not
 * implement `0x19 0x03` still has a readable fault memory, and one dead stage must
 * not hide the other three (the same argument ADR 0049 makes for a scan).
 */

import type { DtcRecord, UdsClient } from "@vdp/protocols-uds";
import { NRC } from "@vdp/protocols-uds";
import { toHex } from "@vdp/shared";
import { nrcOf } from "./nrc.js";
import type { HarvestedDtc, HarvestedEcu } from "./observation.js";
import type { ResolvedHarvestPlan } from "./plan.js";

/** One raw record read from a fault memory. */
export interface HarvestedRecord {
  recordNumber: number;
  /** The bytes the ECU sent, as uppercase hex — no interpretation. */
  rawHex: string;
}

/** What the sweep needs from its caller: the plan, the clock and the two counters. */
export interface FaultMemoryHooks {
  plan: ResolvedHarvestPlan;
  /** Count one request, so the record can say how many were sent. */
  count: () => void;
  /** Pause between two requests, so a real bus is not flooded. */
  sleep: (ms: number) => Promise<void>;
  /** Report a stage that failed, with the reason the bus gave. */
  gap: (stage: string, error: unknown) => void;
}

/**
 * Read the fault memory of one ECU into `ecu`.
 *
 * The result lands on the ECU record instead of being returned, because the sweep
 * fills three of its fields (`dtcs`, `dtcAvailabilityMask`, `dtcCount`) and a
 * fourth shape to carry them would be a second place to keep them in sync.
 */
export async function readFaultMemory(
  client: UdsClient,
  ecu: HarvestedEcu,
  hooks: FaultMemoryHooks,
): Promise<void> {
  const { plan, count, sleep, gap } = hooks;

  try {
    count();
    const counted = await client.readDtcCountByStatusMask(0xff);
    ecu.dtcAvailabilityMask = counted.availabilityMask;
    ecu.dtcCount = counted.count;
  } catch (error) {
    gap("dtc-count", error);
  }
  await sleep(plan.requestGapMs);

  const identified = new Map<string, number>();
  try {
    count();
    const identification = await client.readDtcSnapshotIdentification();
    ecu.dtcAvailabilityMask = identification.availabilityMask;
    for (const entry of identification.identifications) {
      identified.set(entry.code.toUpperCase(), entry.snapshotRecordCount);
    }
  } catch (error) {
    // Not every ECU implements 0x19 0x03; the gap is the answer, and the list
    // below still yields the codes.
    gap("dtc-snapshot-identification", error);
  }
  await sleep(plan.requestGapMs);

  let records: DtcRecord[] = [];
  try {
    count();
    const report = await client.readDtcReportByStatusMask(0xff);
    ecu.dtcAvailabilityMask = report.availabilityMask;
    records = report.records;
  } catch (error) {
    gap("dtc-list", error);
  }

  for (const record of records) {
    const snapshotRecordCount = identified.get(record.code.toUpperCase());
    const harvested: HarvestedDtc = {
      code: record.code,
      raw: record.raw,
      failureType: record.failureType,
      status: record.status,
      statusBits: record.statusBits,
      severity: record.severity,
      ...(record.availabilityMask !== undefined
        ? { availabilityMask: record.availabilityMask }
        : {}),
      ...(snapshotRecordCount !== undefined ? { snapshotRecordCount } : {}),
    };
    if (plan.readDtcRecords) {
      await sleep(plan.requestGapMs);
      const snapshots = await readSnapshotRecords(client, record.code, hooks);
      if (snapshots !== undefined) harvested.snapshots = snapshots;
      const extended = await readExtendedRecords(client, record.code, hooks);
      if (extended !== undefined) harvested.extendedRecords = extended;
    }
    ecu.dtcs.push(harvested);
  }
}

/**
 * Read the snapshot records of one code.
 *
 * Two record numbers can address the same bytes — `0xff` means "all records of this
 * code" (ISO 14229-1 §11.3.4.5) and many ECUs answer it with record 0x01 — so a
 * duplicate payload is dropped instead of being stored twice. What stays is the
 * record number the ECU echoed, not the one that was asked for.
 */
export async function readSnapshotRecords(
  client: UdsClient,
  code: string,
  hooks: FaultMemoryHooks,
): Promise<HarvestedRecord[] | undefined> {
  const read: HarvestedRecord[] = [];
  for (const recordNumber of hooks.plan.dtcRecordNumbers) {
    hooks.count();
    try {
      const snapshot = await client.readDtcSnapshotRecord(code, recordNumber);
      if (snapshot && snapshot.data.length > 0) {
        const rawHex = toHex(snapshot.data, "");
        if (!read.some((entry) => entry.rawHex === rawHex)) {
          read.push({ recordNumber: snapshot.recordNumber, rawHex });
        }
      }
    } catch (error) {
      // "No such record" is an answer about the vehicle; anything else is a gap.
      if (nrcOf(error) === NRC.REQUEST_OUT_OF_RANGE) continue;
      hooks.gap(`dtc-snapshot-${code}-0x${recordNumber.toString(16)}`, error);
    }
  }
  return read.length > 0 ? read : undefined;
}

/** Read the extended data records of one code (ISO 14229-1 §11.3.4.7). */
export async function readExtendedRecords(
  client: UdsClient,
  code: string,
  hooks: FaultMemoryHooks,
): Promise<HarvestedRecord[] | undefined> {
  const read: HarvestedRecord[] = [];
  for (const recordNumber of hooks.plan.extendedRecordNumbers) {
    hooks.count();
    try {
      const record = await client.readDtcExtendedDataRecord(code, recordNumber);
      if (record && record.data.length > 0) {
        const rawHex = toHex(record.data, "");
        if (!read.some((entry) => entry.rawHex === rawHex)) {
          read.push({ recordNumber: record.recordNumber, rawHex });
        }
      }
    } catch (error) {
      if (nrcOf(error) === NRC.REQUEST_OUT_OF_RANGE) continue;
      hooks.gap(`dtc-extended-${code}-0x${recordNumber.toString(16)}`, error);
    }
  }
  return read.length > 0 ? read : undefined;
}
