/**
 * Definitions as data (target architecture §4: "Definitions sind Daten, nicht
 * Code"; AGENTS 13).
 *
 * A definition package can arrive as JSON — from a file, an importer, a version
 * package or a cloud registry. `parseDefinitionPackage` turns the untrusted
 * input into a fully type-checked {@link DefinitionPackage} and then runs the
 * same semantic validation every built-in package passes. Loaders (file, DB,
 * HTTP) therefore stay trivial: read a string, call this, get a package.
 */

import { DefinitionError, messageOf } from "@vdp/shared";
import { upgradePackage } from "./migrate.js";
import type {
  DefinitionPackage,
  DtcKnowledgeDefinition,
  EcuDefinition,
  EngineDefinition,
  FailurePatternDefinition,
  GearboxDefinition,
  MeasurementCheckDefinition,
  Provenance,
  SignalDefinition,
  VehicleDefinition,
  VehicleEcuRef,
  VinMatcher,
} from "./schema.js";
import { assertValidPackage } from "./validate.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Collects structural problems while coercing a JSON value into a package. */
class StructuralCheck {
  readonly errors: string[] = [];

  fail(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }

  string(record: Record<string, unknown>, path: string, field: string): string | undefined {
    const value = record[field];
    if (!isString(value)) {
      this.fail(`${path}.${field}`, "must be a string");
      return undefined;
    }
    return value;
  }

  number(record: Record<string, unknown>, path: string, field: string): number | undefined {
    const value = record[field];
    if (!isNumber(value)) {
      this.fail(`${path}.${field}`, "must be a number");
      return undefined;
    }
    return value;
  }

  /** Optional string array: absent stays absent, anything else must be strings. */
  strings(record: Record<string, unknown>, path: string, field: string): string[] | undefined {
    const value = record[field];
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      this.fail(`${path}.${field}`, "must be an array of strings");
      return undefined;
    }
    const result: string[] = [];
    value.forEach((entry, index) => {
      if (!isString(entry)) this.fail(`${path}.${field}[${index}]`, "must be a string");
      else result.push(entry);
    });
    return result;
  }

  throwIfInvalid(name: string): void {
    if (this.errors.length > 0) {
      throw new DefinitionError(
        `definition source "${name}" is not a valid package:\n- ${this.errors.join("\n- ")}`,
        {
          package: name,
          errors: this.errors,
        },
      );
    }
  }
}

function coerceProvenance(value: unknown, check: StructuralCheck, path = "provenance"): Provenance {
  if (!isRecord(value)) {
    check.fail(path, "must be an object");
    return { sourceType: "own", source: "" };
  }
  const sourceType = value.sourceType;
  const validTypes = new Set([
    "own",
    "standard",
    "licensed",
    "community",
    "reverse-engineered",
    "example-placeholder",
  ]);
  if (!isString(sourceType) || !validTypes.has(sourceType)) {
    check.fail(
      `${path}.sourceType`,
      "must be one of own|standard|licensed|community|reverse-engineered|example-placeholder",
    );
  }
  if (!isString(value.source)) check.fail(`${path}.source`, "must be a string");
  const provenance: Provenance = {
    sourceType: (isString(sourceType) ? sourceType : "own") as Provenance["sourceType"],
    source: isString(value.source) ? value.source : "",
  };
  if (isString(value.license)) provenance.license = value.license;
  if (isString(value.version)) provenance.version = value.version;
  if (isString(value.retrievedAt)) provenance.retrievedAt = value.retrievedAt;
  return provenance;
}

const SEVERITIES = new Set(["info", "minor", "major", "critical"]);
const LIKELIHOODS = new Set(["common", "possible", "rare"]);
const FUELS = new Set(["petrol", "diesel", "electric", "hybrid", "plugin-hybrid", "cng", "lpg"]);
const GEARBOX_TYPES = new Set(["manual", "automatic", "dual-clutch", "cvt", "single-speed"]);

function coerceEngine(value: unknown, path: string, check: StructuralCheck): EngineDefinition {
  if (!isRecord(value)) {
    check.fail(path, "must be an object");
    return { id: "", name: "" };
  }
  const id = check.string(value, path, "id");
  const name = check.string(value, path, "name");
  const engine: EngineDefinition = { id: id ?? "", name: name ?? "" };
  const fuel = value.fuel;
  if (fuel !== undefined) {
    if (!isString(fuel) || !FUELS.has(fuel)) {
      check.fail(
        `${path}.fuel`,
        "must be one of petrol|diesel|electric|hybrid|plugin-hybrid|cng|lpg",
      );
    } else {
      engine.fuel = fuel as EngineDefinition["fuel"];
    }
  }
  if (isNumber(value.displacementCc)) engine.displacementCc = value.displacementCc;
  if (isNumber(value.powerKw)) engine.powerKw = value.powerKw;
  if (isNumber(value.torqueNm)) engine.torqueNm = value.torqueNm;
  if (isString(value.emissionStandard)) engine.emissionStandard = value.emissionStandard;
  if (isString(value.description)) engine.description = value.description;
  const codes = check.strings(value, path, "codes");
  if (codes) engine.codes = codes;
  return engine;
}

function coerceGearbox(value: unknown, path: string, check: StructuralCheck): GearboxDefinition {
  if (!isRecord(value)) {
    check.fail(path, "must be an object");
    return { id: "", name: "" };
  }
  const id = check.string(value, path, "id");
  const name = check.string(value, path, "name");
  const gearbox: GearboxDefinition = { id: id ?? "", name: name ?? "" };
  const type = value.type;
  if (type !== undefined) {
    if (!isString(type) || !GEARBOX_TYPES.has(type)) {
      check.fail(`${path}.type`, "must be one of manual|automatic|dual-clutch|cvt|single-speed");
    } else {
      gearbox.type = type as GearboxDefinition["type"];
    }
  }
  if (isNumber(value.gears)) gearbox.gears = value.gears;
  if (isString(value.description)) gearbox.description = value.description;
  const codes = check.strings(value, path, "codes");
  if (codes) gearbox.codes = codes;
  return gearbox;
}

function coerceVinMatcher(value: unknown, path: string, check: StructuralCheck): VinMatcher {
  const matcher: VinMatcher = {};
  if (!isRecord(value)) {
    check.fail(path, "must be an object");
    return matcher;
  }
  const wmi = check.strings(value, path, "wmi");
  if (wmi) matcher.wmi = wmi;
  if (isString(value.vdsPattern)) matcher.vdsPattern = value.vdsPattern;
  else if (value.vdsPattern !== undefined) check.fail(`${path}.vdsPattern`, "must be a string");
  const modelYearChars = check.strings(value, path, "modelYearChars");
  if (modelYearChars) matcher.modelYearChars = modelYearChars;
  const plantChars = check.strings(value, path, "plantChars");
  if (plantChars) matcher.plantChars = plantChars;
  return matcher;
}

function coerceVehicleEcuRef(value: unknown, path: string, check: StructuralCheck): VehicleEcuRef {
  if (!isRecord(value)) {
    check.fail(path, "must be an object");
    return { ecu: "" };
  }
  const ecu = check.string(value, path, "ecu");
  const ref: VehicleEcuRef = { ecu: ecu ?? "" };
  const partNumbers = check.strings(value, path, "partNumbers");
  if (partNumbers) ref.partNumbers = partNumbers;
  const softwareVersions = check.strings(value, path, "softwareVersions");
  if (softwareVersions) ref.softwareVersions = softwareVersions;
  const hardwareVersions = check.strings(value, path, "hardwareVersions");
  if (hardwareVersions) ref.hardwareVersions = hardwareVersions;
  if (isString(value.engine)) ref.engine = value.engine;
  if (isString(value.gearbox)) ref.gearbox = value.gearbox;
  if (typeof value.optional === "boolean") ref.optional = value.optional;
  return ref;
}

function coerceVehicle(value: unknown, index: number, check: StructuralCheck): VehicleDefinition {
  const path = `vehicles[${index}]`;
  if (!isRecord(value)) {
    check.fail(path, "must be an object");
    return { id: "", brand: "", model: "" };
  }
  const id = check.string(value, path, "id");
  const brand = check.string(value, path, "brand");
  const model = check.string(value, path, "model");
  const vehicle: VehicleDefinition = { id: id ?? "", brand: brand ?? "", model: model ?? "" };

  if (isString(value.platform)) vehicle.platform = value.platform;
  if (isString(value.generation)) vehicle.generation = value.generation;
  if (isString(value.description)) vehicle.description = value.description;
  const bodyStyles = check.strings(value, path, "bodyStyles");
  if (bodyStyles) vehicle.bodyStyles = bodyStyles;

  if (value.modelYears !== undefined) {
    if (!isRecord(value.modelYears)) {
      check.fail(`${path}.modelYears`, "must be an object with a numeric `from`");
    } else {
      const from = check.number(value.modelYears, `${path}.modelYears`, "from");
      const years: VehicleDefinition["modelYears"] = { from: from ?? 0 };
      if (isNumber(value.modelYears.to)) years.to = value.modelYears.to;
      vehicle.modelYears = years;
    }
  }
  if (value.vinMatch !== undefined)
    vehicle.vinMatch = coerceVinMatcher(value.vinMatch, `${path}.vinMatch`, check);
  if (value.provenance !== undefined) {
    vehicle.provenance = coerceProvenance(value.provenance, check, `${path}.provenance`);
  }

  if (value.engines !== undefined) {
    if (!Array.isArray(value.engines)) check.fail(`${path}.engines`, "must be an array");
    else
      vehicle.engines = value.engines.map((engine, i) =>
        coerceEngine(engine, `${path}.engines[${i}]`, check),
      );
  }
  if (value.gearboxes !== undefined) {
    if (!Array.isArray(value.gearboxes)) check.fail(`${path}.gearboxes`, "must be an array");
    else
      vehicle.gearboxes = value.gearboxes.map((gearbox, i) =>
        coerceGearbox(gearbox, `${path}.gearboxes[${i}]`, check),
      );
  }
  if (value.ecus !== undefined) {
    if (!Array.isArray(value.ecus)) check.fail(`${path}.ecus`, "must be an array");
    else
      vehicle.ecus = value.ecus.map((ref, i) =>
        coerceVehicleEcuRef(ref, `${path}.ecus[${i}]`, check),
      );
  }
  if (value.dtcKnowledge !== undefined) {
    if (!Array.isArray(value.dtcKnowledge)) check.fail(`${path}.dtcKnowledge`, "must be an array");
    else
      vehicle.dtcKnowledge = value.dtcKnowledge.map((entry, i) =>
        coerceDtcKnowledgeEntry(entry, `${path}.dtcKnowledge[${i}]`, check),
      );
  }
  return vehicle;
}

function coerceMeasurementCheck(
  value: unknown,
  path: string,
  check: StructuralCheck,
): MeasurementCheckDefinition {
  if (!isRecord(value)) {
    check.fail(path, "must be an object with a `signal` and an `expect` statement");
    return { signal: "", expect: "" };
  }
  const signal = check.string(value, path, "signal");
  const expect = check.string(value, path, "expect");
  const result: MeasurementCheckDefinition = { signal: signal ?? "", expect: expect ?? "" };
  if (value.min !== undefined) {
    const min = check.number(value, path, "min");
    if (min !== undefined) result.min = min;
  }
  if (value.max !== undefined) {
    const max = check.number(value, path, "max");
    if (max !== undefined) result.max = max;
  }
  if (value.windowMs !== undefined) {
    const windowMs = check.number(value, path, "windowMs");
    if (windowMs !== undefined) result.windowMs = windowMs;
  }
  return result;
}

function coerceFailurePattern(
  value: unknown,
  path: string,
  check: StructuralCheck,
): FailurePatternDefinition {
  if (!isRecord(value)) {
    check.fail(path, "must be an object with an `id` and a `name`");
    return { id: "", name: "" };
  }
  const id = check.string(value, path, "id");
  const name = check.string(value, path, "name");
  const pattern: FailurePatternDefinition = { id: id ?? "", name: name ?? "" };
  if (isString(value.explanation)) pattern.explanation = value.explanation;
  if (isString(value.repair)) pattern.repair = value.repair;
  const likelihood = value.likelihood;
  if (likelihood !== undefined) {
    if (!isString(likelihood) || !LIKELIHOODS.has(likelihood)) {
      check.fail(`${path}.likelihood`, 'must be "common", "possible" or "rare"');
    } else {
      pattern.likelihood = likelihood as FailurePatternDefinition["likelihood"];
    }
  }
  if (value.checks !== undefined) {
    if (!Array.isArray(value.checks)) check.fail(`${path}.checks`, "must be an array");
    else
      pattern.checks = value.checks.map((entry, index) =>
        coerceMeasurementCheck(entry, `${path}.checks[${index}]`, check),
      );
  }
  return pattern;
}

/**
 * Variant fault knowledge from an imported file (AGENTS 20, 23).
 *
 * Every field is checked structurally here so a broken import says *which* entry
 * is broken; whether it also makes sense (does the engine exist, can the signal
 * be measured) is the semantic validator's job.
 */
function coerceDtcKnowledgeEntry(
  value: unknown,
  path: string,
  check: StructuralCheck,
): DtcKnowledgeDefinition {
  if (!isRecord(value)) {
    check.fail(path, "must be an object with a `code`");
    return { code: "" };
  }
  const code = check.string(value, path, "code");
  const entry: DtcKnowledgeDefinition = { code: code ?? "" };
  if (isString(value.ecu)) entry.ecu = value.ecu;
  if (isString(value.engine)) entry.engine = value.engine;
  if (isString(value.gearbox)) entry.gearbox = value.gearbox;
  if (isString(value.description)) entry.description = value.description;
  if (isString(value.hint)) entry.hint = value.hint;
  if (isString(value.conditions)) entry.conditions = value.conditions;
  const severity = value.severity;
  if (severity !== undefined) {
    if (!isString(severity) || !SEVERITIES.has(severity)) {
      check.fail(`${path}.severity`, 'must be "info", "minor", "major" or "critical"');
    } else {
      entry.severity = severity as DtcKnowledgeDefinition["severity"];
    }
  }
  const relatedSignals = check.strings(value, path, "relatedSignals");
  if (relatedSignals) entry.relatedSignals = relatedSignals;
  if (value.provenance !== undefined) {
    entry.provenance = coerceProvenance(value.provenance, check, `${path}.provenance`);
  }
  if (value.patterns !== undefined) {
    if (!Array.isArray(value.patterns)) check.fail(`${path}.patterns`, "must be an array");
    else
      entry.patterns = value.patterns.map((pattern, index) =>
        coerceFailurePattern(pattern, `${path}.patterns[${index}]`, check),
      );
  }
  return entry;
}

function coerceSignal(value: unknown, index: number, check: StructuralCheck): SignalDefinition {
  const path = `signals[${index}]`;
  if (!isRecord(value)) {
    check.fail(path, "must be an object");
    return { id: "", name: "", ecu: "", did: 0, byteOffset: 0, length: 0, encoding: "uint8" };
  }
  const id = check.string(value, path, "id");
  const name = check.string(value, path, "name");
  const ecu = check.string(value, path, "ecu");
  const did = check.number(value, path, "did");
  const byteOffset = check.number(value, path, "byteOffset");
  const length = check.number(value, path, "length");
  const encoding = value.encoding;
  if (!isString(encoding)) check.fail(`${path}.encoding`, "must be a string");
  const signal: SignalDefinition = {
    id: id ?? "",
    name: name ?? "",
    ecu: ecu ?? "",
    did: did ?? 0,
    byteOffset: byteOffset ?? 0,
    length: length ?? 0,
    encoding: (isString(encoding) ? encoding : "uint8") as SignalDefinition["encoding"],
  };
  if (isNumber(value.service)) signal.service = value.service;
  if (isNumber(value.bitOffset)) signal.bitOffset = value.bitOffset;
  if (isNumber(value.bitLength)) signal.bitLength = value.bitLength;
  if (value.endianness === "big" || value.endianness === "little")
    signal.endianness = value.endianness;
  if (isNumber(value.scale)) signal.scale = value.scale;
  if (isNumber(value.offsetValue)) signal.offsetValue = value.offsetValue;
  if (isString(value.unit)) signal.unit = value.unit;
  if (isNumber(value.min)) signal.min = value.min;
  if (isNumber(value.max)) signal.max = value.max;
  if (isRecord(value.enumMapping)) signal.enumMapping = value.enumMapping as Record<number, string>;
  if (isString(value.description)) signal.description = value.description;
  if (typeof value.critical === "boolean") signal.critical = value.critical;
  return signal;
}

function coerceEcu(value: unknown, index: number, check: StructuralCheck): EcuDefinition {
  const path = `ecus[${index}]`;
  if (!isRecord(value)) {
    check.fail(path, "must be an object");
    return { id: "", name: "", address: { txId: 0, rxId: 0 }, protocol: "uds" };
  }
  const id = check.string(value, path, "id");
  const name = check.string(value, path, "name");
  const protocol = value.protocol;
  if (protocol !== "uds" && protocol !== "kwp2000")
    check.fail(`${path}.protocol`, 'must be "uds" or "kwp2000"');

  const address = value.address;
  let ecuAddress: EcuDefinition["address"] = { txId: 0, rxId: 0 };
  if (!isRecord(address)) {
    check.fail(`${path}.address`, "must be an object with txId/rxId");
  } else {
    const txId = check.number(address, `${path}.address`, "txId");
    const rxId = check.number(address, `${path}.address`, "rxId");
    ecuAddress = { txId: txId ?? 0, rxId: rxId ?? 0 };
    if (typeof address.extended === "boolean") ecuAddress.extended = address.extended;
    if (address.addressing === "normal" || address.addressing === "extended")
      ecuAddress.addressing = address.addressing;
    if (isNumber(address.functionalId)) ecuAddress.functionalId = address.functionalId;
  }

  const ecu: EcuDefinition = {
    id: id ?? "",
    name: name ?? "",
    address: ecuAddress,
    protocol: protocol === "kwp2000" ? "kwp2000" : "uds",
  };
  if (Array.isArray(value.identification))
    ecu.identification = value.identification as EcuDefinition["identification"];
  if (Array.isArray(value.services)) ecu.services = value.services as number[];
  if (Array.isArray(value.dtcs)) ecu.dtcs = value.dtcs as EcuDefinition["dtcs"];
  if (isString(value.description)) ecu.description = value.description;
  if (isRecord(value.timing)) ecu.timing = value.timing as EcuDefinition["timing"];
  return ecu;
}

/**
 * Coerce an untrusted value (parsed JSON) into a {@link DefinitionPackage},
 * throwing a {@link DefinitionError} that lists every structural problem. The
 * result also passes the semantic validation built-in packages use, and it is
 * always at the current schema version: a version 1 source is validated as
 * version 1 (so its age is visible in the warnings) and then upgraded, which
 * keeps every reader of a loaded package on one single model.
 */
export function parseDefinitionPackage(source: unknown): DefinitionPackage {
  const check = new StructuralCheck();
  const name = isRecord(source) ? (isString(source.name) ? source.name : "<unknown>") : "<unknown>";

  if (!isRecord(source)) {
    throw new DefinitionError("definition source must be a JSON object", { package: name });
  }

  const schemaVersion = source.schemaVersion;
  if (!isNumber(schemaVersion)) check.fail("schemaVersion", "must be a number");
  const oem = check.string(source, "$", "oem");
  const pkgName = check.string(source, "$", "name");
  const version = check.string(source, "$", "version");
  const provenance = coerceProvenance(source.provenance, check);

  if (!Array.isArray(source.ecus)) check.fail("ecus", "must be an array");
  if (!Array.isArray(source.signals)) check.fail("signals", "must be an array");
  if (source.vehicles !== undefined && !Array.isArray(source.vehicles)) {
    check.fail("vehicles", "must be an array");
  }

  const ecus = Array.isArray(source.ecus)
    ? source.ecus.map((ecu, i) => coerceEcu(ecu, i, check))
    : [];
  const signals = Array.isArray(source.signals)
    ? source.signals.map((signal, i) => coerceSignal(signal, i, check))
    : [];
  const vehicles = Array.isArray(source.vehicles)
    ? source.vehicles.map((vehicle, i) => coerceVehicle(vehicle, i, check))
    : [];

  check.throwIfInvalid(name);

  const pkg: DefinitionPackage = {
    schemaVersion: schemaVersion as number,
    oem: oem as string,
    name: pkgName as string,
    version: version as string,
    provenance,
    ecus,
    signals,
    ...(vehicles.length > 0 ? { vehicles } : {}),
  };

  // Semantically validated exactly like the built-in packages (AGENTS 13).
  return upgradePackage(assertValidPackage(pkg));
}

/** Parse a JSON string into a definition package. */
export function parseDefinitionPackageJson(json: string): DefinitionPackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new DefinitionError(`definition JSON is not parseable: ${messageOf(error)}`, {});
  }
  return parseDefinitionPackage(parsed);
}
