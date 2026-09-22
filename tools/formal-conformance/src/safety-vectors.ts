/**
 * Write-safety vectors: the strict reader of `vectors/safety.json` (ADR 0045).
 *
 * Three families — `precheck` (SafetyManager.evaluate against the risk policy),
 * `flow` (the staged `WritePort.run` machine) and `stages`
 * (`DiagnosticTransaction` permit states) — and one rule shared with the ISO-TP
 * reader: every expectation is in the file, nothing in the parser's head
 * (`vector-schema.ts`). Pure: text in, data or errors out, no `node:`.
 */

import { SAFETY_STATES, type SafetyResult } from "./canonical.js";
import {
  array,
  bool,
  fail,
  integer,
  type Json,
  oneOf,
  type Report,
  record,
  rejectExtras,
  str,
} from "./vector-schema.js";

export type SafetyRisk = "low" | "medium" | "high";

export interface SafetyContextInput {
  risk: SafetyRisk;
  userConfirmed: boolean;
  backupAvailable: boolean;
  /**
   * Only precheck vectors carry the session here — a flow vector states the
   * session through `bindingSessionType`, and the port hands that to `describe`,
   * exactly like the production operations do. Two fields for one fact would be
   * two sources.
   */
  sessionType?: number;
  /** null means “no definition version was attached”. */
  definitionVersion: string | null;
  expectedEcuType: string | null;
  actualEcuType: string | null;
  expectedSoftwareVariant: string | null;
  actualSoftwareVariant: string | null;
  /** null means “the network question was not part of this write”. */
  networkTls: boolean | null;
  networkRouting: boolean | null;
  networkUnauthorized: boolean;
}

export interface SafetyVehicleInput {
  stationary: boolean;
  ignitionOn: boolean | null;
  batteryVoltage: number | null;
  parkingBrake: boolean | null;
}

export interface SafetyPrecheckVector {
  family: "precheck";
  name: string;
  minBatteryVoltage: number | null;
  context: SafetyContextInput;
  vehicle: SafetyVehicleInput;
  expect: { granted: boolean; failed: number; unproven: number };
}

export interface SafetyFlowVector {
  family: "flow";
  name: string;
  minBatteryVoltage: number | null;
  permitExpiry: "fresh" | "expired";
  bindingSessionType: number;
  context: SafetyContextInput;
  vehicle: SafetyVehicleInput;
  script: {
    prepareOk: boolean;
    executeOk: boolean;
    writeBeforeFail: boolean;
    verify: "match" | "mismatch" | "absent";
    rollback: "ok" | "fail" | "absent";
  };
  expect: {
    ok: boolean;
    state: (typeof SAFETY_STATES)[number];
    writeReached: boolean;
    verified: boolean;
    rolledBack: boolean;
    failed: number;
    unproven: number;
  };
}

export interface SafetyStageOp {
  op: "prepare" | "confirm" | "execute" | "verify" | "rollback";
  bodyOk: boolean;
  /** Attach a valid permit before this stage (the port does it after granting). */
  grant: boolean;
}

export interface SafetyStagesVector {
  family: "stages";
  name: string;
  ops: SafetyStageOp[];
  expect: { state: (typeof SAFETY_STATES)[number]; stageOk: boolean[] };
}

export type SafetyVector = SafetyPrecheckVector | SafetyFlowVector | SafetyStagesVector;

export interface ParsedSafetyVector {
  name: string;
  family: SafetyVector["family"];
  vector: SafetyVector;
  /** The raw comparable object of this vector (what both sides must reproduce). */
  expect: SafetyResult;
}

function parseSafetyContext(
  json: unknown,
  path: string,
  report: Report,
  expectSession: boolean,
): SafetyContextInput | undefined {
  const ctx = record(json, path, report);
  if (!ctx) return undefined;
  rejectExtras(
    ctx,
    [
      "risk",
      "userConfirmed",
      "backupAvailable",
      "sessionType",
      "definitionVersion",
      "expectedEcuType",
      "actualEcuType",
      "expectedSoftwareVariant",
      "actualSoftwareVariant",
      "network",
    ],
    path,
    report,
  );
  const risk = oneOf(ctx.risk, `${path}.risk`, report, ["low", "medium", "high"] as const);
  const userConfirmed = bool(ctx.userConfirmed, `${path}.userConfirmed`, report);
  const backupAvailable = bool(ctx.backupAvailable, `${path}.backupAvailable`, report);
  if (ctx.sessionType !== undefined && !expectSession) {
    fail(
      report,
      `${path}.sessionType`,
      "a flow vector states the session as bindingSessionType, not in the context",
    );
    return undefined;
  }
  const sessionType = ctx.sessionType;
  if (expectSession && sessionType === undefined) {
    fail(report, `${path}.sessionType`, "a precheck vector must state the session explicitly");
    return undefined;
  }
  if (
    sessionType !== undefined &&
    (typeof sessionType !== "number" ||
      !Number.isInteger(sessionType) ||
      sessionType < 1 ||
      sessionType > 255)
  ) {
    fail(report, `${path}.sessionType`, "expected an integer 1..255");
    return undefined;
  }
  const definitionVersion =
    ctx.definitionVersion === null
      ? null
      : str(ctx.definitionVersion, `${path}.definitionVersion`, report);
  const nullableStr = (value: unknown, key: string): string | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return str(value, `${path}.${key}`, report);
  };
  const expectedEcuType = nullableStr(ctx.expectedEcuType, "expectedEcuType");
  const actualEcuType = nullableStr(ctx.actualEcuType, "actualEcuType");
  const expectedSoftwareVariant = nullableStr(
    ctx.expectedSoftwareVariant,
    "expectedSoftwareVariant",
  );
  const actualSoftwareVariant = nullableStr(ctx.actualSoftwareVariant, "actualSoftwareVariant");
  let networkTls: boolean | null = null;
  let networkRouting: boolean | null = null;
  let networkUnauthorized = false;
  if (ctx.network !== undefined) {
    const network = record(ctx.network, `${path}.network`, report);
    if (network) {
      rejectExtras(network, ["tls", "routing", "unauthorized"], `${path}.network`, report);
      const tls = network.tls === null ? null : bool(network.tls, `${path}.network.tls`, report);
      const routing =
        network.routing === null ? null : bool(network.routing, `${path}.network.routing`, report);
      const unauthorized = bool(
        network.unauthorized ?? false,
        `${path}.network.unauthorized`,
        report,
      );
      if (tls !== undefined) networkTls = tls;
      if (routing !== undefined) networkRouting = routing;
      if (unauthorized !== undefined) networkUnauthorized = unauthorized;
    }
  }
  if (
    risk === undefined ||
    userConfirmed === undefined ||
    backupAvailable === undefined ||
    definitionVersion === undefined ||
    (expectSession && sessionType === undefined)
  ) {
    return undefined;
  }
  return {
    risk,
    userConfirmed,
    backupAvailable,
    ...(sessionType !== undefined ? { sessionType } : {}),
    definitionVersion,
    expectedEcuType: expectedEcuType ?? null,
    actualEcuType: actualEcuType ?? null,
    expectedSoftwareVariant: expectedSoftwareVariant ?? null,
    actualSoftwareVariant: actualSoftwareVariant ?? null,
    networkTls,
    networkRouting,
    networkUnauthorized,
  };
}

/** A number with decimals, or null for “never measured”. Absent is an error. */
function numberOrNull(
  value: unknown,
  path: string,
  report: Report,
  max: number,
): number | null | undefined {
  if (value === undefined) {
    fail(report, path, "must be named (null for “never measured”)");
    return undefined;
  }
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    fail(report, path, `expected a number 0..${max}, or null`);
    return undefined;
  }
  return value;
}

/** A boolean, or null for “never reported”. Every field must be *named*. */
function boolOrNull(value: unknown, path: string, report: Report): boolean | null | undefined {
  if (value === undefined) {
    fail(report, path, "must be named (null for “never reported”)");
    return undefined;
  }
  if (value === null) return null;
  return bool(value, path, report);
}

function parseSafetyVehicle(
  json: unknown,
  path: string,
  report: Report,
): SafetyVehicleInput | undefined {
  const veh = record(json, path, report);
  if (!veh) return undefined;
  rejectExtras(veh, ["stationary", "ignitionOn", "batteryVoltage", "parkingBrake"], path, report);
  const stationary = bool(veh.stationary, `${path}.stationary`, report);
  if (veh.stationary === undefined) {
    fail(
      report,
      `${path}.stationary`,
      "must be named (it is required — the vehicle must at least say whether it stands)",
    );
  }
  const ignitionOn = boolOrNull(veh.ignitionOn, `${path}.ignitionOn`, report);
  const parkingBrake = boolOrNull(veh.parkingBrake, `${path}.parkingBrake`, report);
  const batteryVoltage = numberOrNull(veh.batteryVoltage, `${path}.batteryVoltage`, report, 60);
  if (
    stationary === undefined ||
    ignitionOn === undefined ||
    parkingBrake === undefined ||
    batteryVoltage === undefined
  ) {
    return undefined;
  }
  return { stationary, ignitionOn, parkingBrake, batteryVoltage };
}

export function parseSafetyVectorFile(
  text: string,
): { ok: true; vectors: ParsedSafetyVector[] } | { ok: false; errors: string[] } {
  const report: Report = { errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`invalid JSON: ${error instanceof Error ? error.message : "?"}`] };
  }
  const file = record(parsed, "file", report);
  if (!file) return { ok: false, errors: report.errors };
  rejectExtras(file, ["vectorSet", "modelDomain", "config", "vectors"], "file", report);
  str(file.vectorSet, "file.vectorSet", report);
  str(file.modelDomain, "file.modelDomain", report);
  const globalConfig = record(file.config ?? {}, "file.config", report) ?? {};
  rejectExtras(globalConfig, ["minBatteryVoltage"], "file.config", report);
  const defaultMinVoltage = integer(
    globalConfig.minBatteryVoltage ?? 12,
    "file.config.minBatteryVoltage",
    report,
    0,
    60,
  );
  const list = array(file.vectors, "file.vectors", report) ?? [];
  if (list.length === 0)
    fail(report, "file.vectors", "a vector set must carry at least one vector");
  const out: ParsedSafetyVector[] = [];
  const names = new Map<string, number>();
  list.forEach((entry, i) => {
    const path = `vectors[${i}]`;
    const json = record(entry, path, report);
    if (!json) return;
    const family = oneOf(json.family, `${path}.family`, report, [
      "precheck",
      "flow",
      "stages",
    ] as const);
    const name = str(json.name, `${path}.name`, report);
    if (family === undefined || name === undefined) return;
    const duplicate = names.get(name);
    if (duplicate !== undefined) {
      fail(report, path, `duplicate vector name "${name}" (first seen at vectors[${duplicate}])`);
      return;
    }
    names.set(name, i);
    if (family === "stages") {
      parseStagesVector(json, path, name, report, out);
      return;
    }
    rejectExtras(
      json,
      family === "precheck"
        ? ["family", "name", "minBatteryVoltage", "context", "vehicle", "expect"]
        : [
            "family",
            "name",
            "minBatteryVoltage",
            "permitExpiry",
            "bindingSessionType",
            "context",
            "vehicle",
            "script",
            "expect",
          ],
      path,
      report,
    );
    const context = parseSafetyContext(
      json.context,
      `${path}.context`,
      report,
      family === "precheck",
    );
    const vehicle = parseSafetyVehicle(json.vehicle, `${path}.vehicle`, report);
    const minBatteryVoltage =
      json.minBatteryVoltage === null
        ? (defaultMinVoltage ?? null)
        : json.minBatteryVoltage === undefined
          ? (defaultMinVoltage ?? null)
          : integer(json.minBatteryVoltage, `${path}.minBatteryVoltage`, report, 0, 60);
    if (!context || vehicle === undefined || minBatteryVoltage === undefined) return;
    const expectJson = record(json.expect, `${path}.expect`, report);
    if (!expectJson) return;
    if (family === "precheck") {
      rejectExtras(expectJson, ["granted", "failed", "unproven"], `${path}.expect`, report);
      const granted = bool(expectJson.granted, `${path}.expect.granted`, report);
      const failed = integer(expectJson.failed ?? 0, `${path}.expect.failed`, report, 0, 64);
      const unproven = integer(expectJson.unproven ?? 0, `${path}.expect.unproven`, report, 0, 64);
      if (granted === undefined || failed === undefined || unproven === undefined) return;
      if (unproven > failed) {
        fail(
          report,
          `${path}.expect`,
          "unproven is a subset of failed — unproven must not exceed failed",
        );
        return;
      }
      out.push({
        name,
        family: "precheck",
        expect: { kind: "precheck", granted, failed, unproven },
        vector: {
          family: "precheck",
          name,
          minBatteryVoltage,
          context,
          vehicle,
          expect: { granted, failed, unproven },
        },
      });
      return;
    }
    const permitExpiry = oneOf(json.permitExpiry, `${path}.permitExpiry`, report, [
      "fresh",
      "expired",
    ] as const);
    const bindingSessionType = integer(
      json.bindingSessionType,
      `${path}.bindingSessionType`,
      report,
      1,
      255,
    );
    const scriptJson = record(json.script, `${path}.script`, report);
    if (!scriptJson || permitExpiry === undefined || bindingSessionType === undefined) return;
    rejectExtras(
      scriptJson,
      ["prepareOk", "executeOk", "writeBeforeFail", "verify", "rollback"],
      `${path}.script`,
      report,
    );
    const prepareOk = bool(scriptJson.prepareOk, `${path}.script.prepareOk`, report);
    const executeOk = bool(scriptJson.executeOk, `${path}.script.executeOk`, report);
    const writeBeforeFail = bool(
      scriptJson.writeBeforeFail ?? false,
      `${path}.script.writeBeforeFail`,
      report,
    );
    const verify = oneOf(scriptJson.verify, `${path}.script.verify`, report, [
      "match",
      "mismatch",
      "absent",
    ] as const);
    const rollback = oneOf(scriptJson.rollback, `${path}.script.rollback`, report, [
      "ok",
      "fail",
      "absent",
    ] as const);
    const ok = bool(expectJson.ok, `${path}.expect.ok`, report);
    const state = oneOf(expectJson.state, `${path}.expect.state`, report, SAFETY_STATES);
    const writeReached = bool(expectJson.writeReached, `${path}.expect.writeReached`, report);
    const verified = bool(expectJson.verified, `${path}.expect.verified`, report);
    const rolledBack = bool(expectJson.rolledBack, `${path}.expect.rolledBack`, report);
    const failed = integer(expectJson.failed ?? 0, `${path}.expect.failed`, report, 0, 64);
    const unproven = integer(expectJson.unproven ?? 0, `${path}.expect.unproven`, report, 0, 64);
    rejectExtras(
      expectJson,
      ["ok", "state", "writeReached", "verified", "rolledBack", "failed", "unproven"],
      `${path}.expect`,
      report,
    );
    if (
      prepareOk === undefined ||
      executeOk === undefined ||
      writeBeforeFail === undefined ||
      verify === undefined ||
      rollback === undefined ||
      ok === undefined ||
      state === undefined ||
      writeReached === undefined ||
      verified === undefined ||
      rolledBack === undefined ||
      failed === undefined ||
      unproven === undefined
    ) {
      return;
    }
    if (unproven > failed) {
      fail(
        report,
        `${path}.expect`,
        "unproven is a subset of failed — unproven must not exceed failed",
      );
      return;
    }
    if (minBatteryVoltage === undefined) return;
    out.push({
      name,
      family: "flow",
      expect: { kind: "flow", ok, state, writeReached, verified, rolledBack, failed, unproven },
      vector: {
        family: "flow",
        name,
        minBatteryVoltage,
        permitExpiry,
        bindingSessionType,
        context,
        vehicle,
        script: { prepareOk, executeOk, writeBeforeFail, verify, rollback },
        expect: { ok, state, writeReached, verified, rolledBack, failed, unproven },
      },
    });
  });
  if (report.errors.length === 0 && out.length !== list.length) {
    fail(
      report,
      "file.vectors",
      "some vectors were dropped without a parse error — the parser is wrong, not the file",
    );
  }
  if (report.errors.length > 0) return { ok: false, errors: report.errors };
  return { ok: true, vectors: out };
}

function parseStagesVector(
  json: Json,
  path: string,
  name: string,
  report: Report,
  out: ParsedSafetyVector[],
): void {
  rejectExtras(json, ["family", "name", "ops", "expect"], path, report);
  const opsList = array(json.ops, `${path}.ops`, report);
  const expectJson = record(json.expect, `${path}.expect`, report);
  if (!opsList || !expectJson) return;
  rejectExtras(expectJson, ["state", "stageOk"], `${path}.expect`, report);
  const state = oneOf(expectJson.state, `${path}.expect.state`, report, SAFETY_STATES);
  const stageOkList = array(expectJson.stageOk, `${path}.expect.stageOk`, report);
  if (state === undefined || !stageOkList) return;
  const stageOk: boolean[] = [];
  stageOkList.forEach((entry, j) => {
    const value = bool(entry, `${path}.expect.stageOk[${j}]`, report);
    if (value !== undefined) stageOk.push(value);
  });
  const ops: SafetyStageOp[] = [];
  opsList.forEach((entry, j) => {
    const opath = `${path}.ops[${j}]`;
    const opJson = record(entry, opath, report);
    if (!opJson) return;
    rejectExtras(opJson, ["op", "bodyOk", "grant"], opath, report);
    const op = oneOf(opJson.op, `${opath}.op`, report, [
      "prepare",
      "confirm",
      "execute",
      "verify",
      "rollback",
    ] as const);
    const bodyOk = bool(opJson.bodyOk ?? true, `${opath}.bodyOk`, report);
    const grant = bool(opJson.grant ?? false, `${opath}.grant`, report);
    if (op === undefined || bodyOk === undefined || grant === undefined) return;
    ops.push({ op, bodyOk, grant });
  });
  if (ops.length !== stageOk.length) {
    fail(
      report,
      `${path}.expect.stageOk`,
      `one boolean per op expected (${ops.length}), got ${stageOk.length}`,
    );
    return;
  }
  out.push({
    name,
    family: "stages",
    expect: { kind: "stages", state, stageOk },
    vector: { family: "stages", name, ops, expect: { state, stageOk } },
  });
}
