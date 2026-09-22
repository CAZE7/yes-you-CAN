/**
 * Definition package validation (AGENTS 13).
 *
 * A definition package is loaded from data files, so it is validated before use.
 * Errors are collected (not thrown on the first one) so an importer can report
 * everything that is wrong in one pass.
 */

import { DefinitionError } from "@vdp/shared";
import { isSupportedSchemaVersion } from "./migrate.js";
import {
  CURRENT_SCHEMA_VERSION,
  type DefinitionPackage,
  type EcuDefinition,
  type FailurePatternDefinition,
  type MeasurementCheckDefinition,
  type Provenance,
  type SignalDefinition,
  SUPPORTED_SCHEMA_VERSIONS,
  type VehicleDefinition,
} from "./schema.js";

/** Rendered once: every schema-version error quotes the same list. */
const SUPPORTED_TEXT = SUPPORTED_SCHEMA_VERSIONS.join(", ");

const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;
const DTC_CODE = /^[PCBU]\d[0-9A-Fa-f]{3}$/;
/** VIN characters never contain I, O or Q (ISO 3779); a WMI is three of them. */
const WMI = /^[A-HJ-NPR-Z0-9]{3}$/;
/** Vehicle Descriptor Section pattern: five positions, `.`/`?` are wildcards. */
const VDS_PATTERN = /^[A-HJ-NPR-Z0-9.?]{5}$/;
const VIN_CHAR = /^[A-HJ-NPR-Z0-9]$/;
/** Model years are plausible years, not accident digits from a shifted column. */
const PLAUSIBLE_MODEL_YEAR = { from: 1950, to: 2100 };
const VALID_SEVERITIES = new Set(["info", "minor", "major", "critical"]);
const VALID_LIKELIHOODS = new Set(["common", "possible", "rare"]);
const VALID_ENCODINGS = new Set([
  "uint8",
  "uint16",
  "uint24",
  "uint32",
  "int8",
  "int16",
  "int32",
  "float32",
  "ascii",
  "bool",
  "bitmask",
  "bcd",
]);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateDefinitionPackage(pkg: DefinitionPackage): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isSupportedSchemaVersion(pkg.schemaVersion)) {
    errors.push(
      `schemaVersion ${pkg.schemaVersion} is not supported (this build reads ${SUPPORTED_TEXT})`,
    );
  } else if (pkg.schemaVersion < CURRENT_SCHEMA_VERSION) {
    warnings.push(
      `schemaVersion ${pkg.schemaVersion} predates ${CURRENT_SCHEMA_VERSION}: ` +
        "vehicles arrive with version 2 and fault knowledge per variant with version 3, " +
        "so this package can carry neither (run upgradePackage)",
    );
  }
  if (!SEMVER.test(pkg.version))
    errors.push(
      `version "${pkg.version}" is not valid SemVer (AGENTS 13 requires semantic versioning)`,
    );
  if (!pkg.oem) errors.push("oem is required");
  if (!pkg.name) errors.push("name is required");

  // Provenance is mandatory (AGENTS 24).
  if (!pkg.provenance) errors.push("provenance is required (AGENTS 24)");
  else validateProvenance("provenance", pkg.provenance, errors, warnings);

  const ecuIds = new Set<string>();
  for (const ecu of pkg.ecus ?? []) {
    validateEcu(ecu, ecuIds, errors);
  }

  const signalIds = new Set<string>();
  for (const signal of pkg.signals ?? []) {
    validateSignal(signal, ecuIds, signalIds, errors, warnings);
  }

  const dtcCodes = new Set<string>();
  for (const ecu of pkg.ecus ?? []) {
    for (const dtc of ecu.dtcs ?? []) dtcCodes.add(dtc.code.trim().toUpperCase());
  }

  const vehicleIds = new Set<string>();
  for (const vehicle of pkg.vehicles ?? []) {
    validateVehicle(vehicle, ecuIds, vehicleIds, errors, warnings);
    validateDtcKnowledge(vehicle, ecuIds, signalIds, dtcCodes, errors, warnings);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * ISO-8601 date or timestamp (RFC 3339 profile).
 *
 * A retrieval date that cannot be parsed is worse than none: it looks documented
 * and cannot be compared with anything — neither with a license term nor with
 * the date a source was withdrawn (AGENTS 13, 24).
 */
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s?([Zz]|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Provenance is the part of a package that can be checked later (AGENTS 24).
 *
 * The rules differ by source type because the risk differs: licensed data has to
 * be traceable to a contract, a version and a date — otherwise a withdrawal or an
 * update cannot be noticed. A standard reference has to name its edition, because
 * "SAE J1979" without a year is not a citation. Community data carries unclear
 * rights and must not reach a customer uncleared.
 */
function validateProvenance(
  path: string,
  provenance: Provenance,
  errors: string[],
  warnings: string[],
): void {
  if (!provenance.sourceType) errors.push(`${path}.sourceType is required`);
  if (!provenance.source) errors.push(`${path}.source is required`);
  if (provenance.retrievedAt !== undefined && !ISO_8601.test(provenance.retrievedAt.trim())) {
    errors.push(
      `${path}.retrievedAt: "${provenance.retrievedAt}" is not an ISO-8601 date — a retrieval ` +
        "date nothing can parse cannot be compared with a license term or a withdrawal",
    );
  }
  if (provenance.sourceType === "licensed") {
    if (!provenance.license) errors.push(`${path}: licensed data must declare a license`);
    if (!provenance.version) {
      warnings.push(
        `${path}: licensed data without a version cannot be checked against an update or a ` +
          "withdrawal (AGENTS 13)",
      );
    }
    if (!provenance.retrievedAt) {
      warnings.push(
        `${path}: licensed data without a retrieval date cannot be dated — the rights situation ` +
          "may have changed since it was taken (AGENTS 24)",
      );
    }
  }
  if (provenance.sourceType === "standard" && !provenance.version && !provenance.notes) {
    warnings.push(
      `${path}: a standard reference should name its edition (year or revision) so the citation ` +
        "can be checked (AGENTS 24)",
    );
  }
  if (provenance.sourceType === "community") {
    warnings.push(
      `${path}: community data carries unclear rights — the license must be cleared before ` +
        "distribution (AGENTS 24)",
    );
  }
  if (provenance.sourceType === "reverse-engineered") {
    warnings.push(`${path}: reverse-engineered definitions must be reviewed before distribution`);
  }
  if (provenance.sourceType === "example-placeholder") {
    warnings.push(`${path}: placeholder data — not suitable for a real vehicle`);
  }
}

/**
 * One vehicle definition (AGENTS 11, 13).
 *
 * The rules here are the ones that make resolution trustworthy later: a VIN
 * criterion that is not a VIN shape, a model year range that cannot occur, or an
 * ECU reference into thin air would each turn into a confident wrong answer at
 * runtime — the validator is where they are cheap.
 */
function validateVehicle(
  vehicle: VehicleDefinition,
  ecuIds: Set<string>,
  vehicleIds: Set<string>,
  errors: string[],
  warnings: string[],
): void {
  const where = vehicle.id ? `vehicle "${vehicle.id}"` : "vehicle without id";
  if (!vehicle.id) errors.push("vehicle without id");
  if (vehicleIds.has(vehicle.id)) errors.push(`duplicate vehicle id "${vehicle.id}"`);
  vehicleIds.add(vehicle.id);
  if (!vehicle.brand) errors.push(`${where} has no brand`);
  if (!vehicle.model) errors.push(`${where} has no model`);

  if (vehicle.provenance) {
    validateProvenance(`${where}.provenance`, vehicle.provenance, errors, warnings);
  }

  const years = vehicle.modelYears;
  if (years) {
    if (!Number.isFinite(years.from) || years.from < PLAUSIBLE_MODEL_YEAR.from) {
      errors.push(`${where} declares an implausible model year start (${years.from})`);
    }
    if (years.to !== undefined && years.to < years.from) {
      errors.push(`${where} has modelYears.to < modelYears.from`);
    }
    if (years.to !== undefined && years.to > PLAUSIBLE_MODEL_YEAR.to) {
      errors.push(`${where} declares an implausible model year end (${years.to})`);
    }
  }

  validateVinMatcher(vehicle, errors);
  validatePowertrain(vehicle, where, errors);

  const engineIds = new Set((vehicle.engines ?? []).map((engine) => engine.id));
  const gearboxIds = new Set((vehicle.gearboxes ?? []).map((gearbox) => gearbox.id));
  for (const ref of vehicle.ecus ?? []) {
    if (!ecuIds.has(ref.ecu)) {
      errors.push(`${where} references unknown ECU "${ref.ecu}"`);
    }
    if (ref.engine !== undefined && !engineIds.has(ref.engine)) {
      errors.push(`${where}: ECU "${ref.ecu}" references unknown engine "${ref.engine}"`);
    }
    if (ref.gearbox !== undefined && !gearboxIds.has(ref.gearbox)) {
      errors.push(`${where}: ECU "${ref.ecu}" references unknown gearbox "${ref.gearbox}"`);
    }
  }

  const hasVinCriteria = Boolean(
    vehicle.vinMatch &&
      ((vehicle.vinMatch.wmi?.length ?? 0) > 0 ||
        vehicle.vinMatch.vdsPattern !== undefined ||
        (vehicle.vinMatch.modelYearChars?.length ?? 0) > 0 ||
        (vehicle.vinMatch.plantChars?.length ?? 0) > 0),
  );
  if (!hasVinCriteria && (vehicle.ecus?.length ?? 0) === 0) {
    warnings.push(
      `${where} declares neither VIN criteria nor ECUs — it can only ever match a user's own claim`,
    );
  }
}

function validateVinMatcher(vehicle: VehicleDefinition, errors: string[]): void {
  const matcher = vehicle.vinMatch;
  if (!matcher) return;
  const where = `vehicle "${vehicle.id}"`;

  for (const wmi of matcher.wmi ?? []) {
    if (!WMI.test(wmi)) {
      errors.push(`${where}: WMI "${wmi}" must be three VIN characters (no I, O or Q)`);
    }
  }
  if (matcher.vdsPattern !== undefined && !VDS_PATTERN.test(matcher.vdsPattern)) {
    errors.push(
      `${where}: vdsPattern "${matcher.vdsPattern}" must be five positions ` +
        "(letters, digits, `.` or `?`; no I, O or Q)",
    );
  }
  for (const char of matcher.modelYearChars ?? []) {
    if (!VIN_CHAR.test(char))
      errors.push(`${where}: model year character "${char}" is not a VIN character`);
  }
  for (const char of matcher.plantChars ?? []) {
    if (!VIN_CHAR.test(char))
      errors.push(`${where}: plant character "${char}" is not a VIN character`);
  }
}

function validatePowertrain(vehicle: VehicleDefinition, where: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const engine of vehicle.engines ?? []) {
    if (!engine.id) errors.push(`${where}: engine without id`);
    if (seen.has(`engine:${engine.id}`))
      errors.push(`${where}: duplicate engine id "${engine.id}"`);
    seen.add(`engine:${engine.id}`);
    if (!engine.name) errors.push(`${where}: engine "${engine.id}" has no name`);
    for (const code of engine.codes ?? []) {
      if (!code.trim()) errors.push(`${where}: engine "${engine.id}" declares an empty code`);
    }
    if (engine.displacementCc !== undefined && engine.displacementCc <= 0) {
      errors.push(`${where}: engine "${engine.id}" has a non-positive displacement`);
    }
  }
  for (const gearbox of vehicle.gearboxes ?? []) {
    if (!gearbox.id) errors.push(`${where}: gearbox without id`);
    if (seen.has(`gearbox:${gearbox.id}`)) {
      errors.push(`${where}: duplicate gearbox id "${gearbox.id}"`);
    }
    seen.add(`gearbox:${gearbox.id}`);
    if (!gearbox.name) errors.push(`${where}: gearbox "${gearbox.id}" has no name`);
    if (gearbox.gears !== undefined && gearbox.gears < 1) {
      errors.push(`${where}: gearbox "${gearbox.id}" declares fewer than one gear`);
    }
  }
}

/**
 * Fault knowledge of one vehicle variant (AGENTS 20, 23).
 *
 * Everything this data says is shown to a technician as a statement about *their*
 * car, so every reference it makes has to resolve: an entry pointing at an engine,
 * an ECU or a measuring signal the package does not declare would silently become
 * an unverifiable claim. What is missing is reported as a warning, never patched.
 */
function validateDtcKnowledge(
  vehicle: VehicleDefinition,
  ecuIds: Set<string>,
  signalIds: Set<string>,
  dtcCodes: Set<string>,
  errors: string[],
  warnings: string[],
): void {
  const knowledge = vehicle.dtcKnowledge ?? [];
  if (knowledge.length === 0) return;
  const where = vehicle.id ? `vehicle "${vehicle.id}"` : "vehicle without id";
  const engineIds = new Set((vehicle.engines ?? []).map((engine) => engine.id));
  const gearboxIds = new Set((vehicle.gearboxes ?? []).map((gearbox) => gearbox.id));
  const seenEntries = new Set<string>();
  const seenPatterns = new Set<string>();

  for (const entry of knowledge) {
    const code = typeof entry.code === "string" ? entry.code.trim().toUpperCase() : "";
    const label = `${where}: knowledge for ${code || "(no code)"}`;
    if (!DTC_CODE.test(entry.code ?? "")) {
      errors.push(`${where}: malformed DTC code "${entry.code}" in variant knowledge`);
    } else if (!dtcCodes.has(code)) {
      warnings.push(
        `${label} has no package-wide definition on any ECU — ` +
          "the code cannot be read from this package's ECU list",
      );
    }

    const scope = [code, entry.ecu ?? "", entry.engine ?? "", entry.gearbox ?? ""].join("|");
    if (seenEntries.has(scope)) {
      errors.push(`${label} is declared twice with the same ECU/engine/gearbox scope`);
    }
    seenEntries.add(scope);

    if (entry.ecu !== undefined && !ecuIds.has(entry.ecu)) {
      errors.push(`${label} references unknown ECU "${entry.ecu}"`);
    }
    if (entry.engine !== undefined && !engineIds.has(entry.engine)) {
      errors.push(`${label} references unknown engine "${entry.engine}"`);
    }
    if (entry.gearbox !== undefined && !gearboxIds.has(entry.gearbox)) {
      errors.push(`${label} references unknown gearbox "${entry.gearbox}"`);
    }
    if (entry.severity !== undefined && !VALID_SEVERITIES.has(entry.severity)) {
      errors.push(`${label} has unsupported severity "${entry.severity}"`);
    }
    for (const field of ["description", "hint", "conditions"] as const) {
      if (entry[field] !== undefined && !entry[field]?.trim()) {
        errors.push(`${label} declares an empty ${field}`);
      }
    }
    for (const signal of entry.relatedSignals ?? []) {
      if (!signalIds.has(signal)) {
        errors.push(`${label} references unknown signal "${signal}"`);
      }
    }
    if (entry.provenance) {
      validateProvenance(`${label}.provenance`, entry.provenance, errors, warnings);
    }

    const hasContent =
      Boolean(entry.description?.trim() || entry.hint?.trim() || entry.conditions?.trim()) ||
      entry.severity !== undefined ||
      (entry.patterns?.length ?? 0) > 0 ||
      (entry.relatedSignals?.length ?? 0) > 0;
    if (!hasContent) {
      warnings.push(`${label} declares nothing beyond its code — it changes no answer`);
    }

    const hasProvenance = entry.provenance !== undefined || vehicle.provenance !== undefined;
    for (const pattern of entry.patterns ?? []) {
      validateFailurePattern(
        pattern,
        label,
        signalIds,
        seenPatterns,
        hasProvenance,
        errors,
        warnings,
      );
    }
  }
}

function validateFailurePattern(
  pattern: FailurePatternDefinition,
  label: string,
  signalIds: Set<string>,
  seenPatterns: Set<string>,
  hasProvenance: boolean,
  errors: string[],
  warnings: string[],
): void {
  const where = `${label}, pattern "${pattern.id || "(no id)"}"`;
  if (!pattern.id) errors.push(`${label}: failure pattern without id`);
  if (seenPatterns.has(pattern.id)) {
    errors.push(`${label}: duplicate failure pattern id "${pattern.id}"`);
  }
  seenPatterns.add(pattern.id);
  if (!pattern.name) errors.push(`${where} has no name`);
  if (pattern.likelihood !== undefined && !VALID_LIKELIHOODS.has(pattern.likelihood)) {
    errors.push(`${where} has unsupported likelihood "${pattern.likelihood}"`);
  }
  // Repair advice is the one category §24 makes rights-sensitive: without a
  // source it cannot be checked, licensed or withdrawn.
  if (pattern.repair !== undefined && !pattern.repair.trim()) {
    errors.push(`${where} declares empty repair information`);
  } else if (pattern.repair !== undefined && !hasProvenance) {
    warnings.push(
      `${where} carries repair information without provenance — source and rights are undocumented (AGENTS 24)`,
    );
  }

  const checks = pattern.checks ?? [];
  if (checks.length === 0) {
    warnings.push(`${where} has no measurement check — it can be read, not verified`);
  }
  for (const check of checks) {
    validateMeasurementCheck(check, where, signalIds, errors, warnings);
  }
}

function validateMeasurementCheck(
  check: MeasurementCheckDefinition,
  where: string,
  signalIds: Set<string>,
  errors: string[],
  warnings: string[],
): void {
  const at = `${where}, check "${check.signal || "(no signal)"}"`;
  if (!check.signal) errors.push(`${where}: measurement check without signal`);
  else if (!signalIds.has(check.signal)) {
    errors.push(`${at} references unknown signal "${check.signal}"`);
  }
  if (!check.expect?.trim()) errors.push(`${at} says nothing about what to expect`);
  for (const bound of ["min", "max"] as const) {
    const value = check[bound];
    if (value !== undefined && !Number.isFinite(value)) {
      errors.push(`${at} has a non-finite ${bound}`);
    }
  }
  if (
    check.min !== undefined &&
    check.max !== undefined &&
    Number.isFinite(check.min) &&
    Number.isFinite(check.max) &&
    check.min > check.max
  ) {
    errors.push(`${at} has min ${check.min} > max ${check.max}`);
  }
  if (check.windowMs !== undefined && (!Number.isInteger(check.windowMs) || check.windowMs < 1)) {
    errors.push(`${at} declares a window of ${check.windowMs} ms — it must be a positive integer`);
  }
  if (check.min === undefined && check.max === undefined) {
    warnings.push(`${at} has no numeric window — a human has to judge it, the tool cannot`);
  }
}

function validateEcu(ecu: EcuDefinition, ecuIds: Set<string>, errors: string[]): void {
  if (!ecu.id) errors.push("ECU without id");
  if (ecuIds.has(ecu.id)) errors.push(`duplicate ECU id "${ecu.id}"`);
  ecuIds.add(ecu.id);
  if (!ecu.name) errors.push(`ECU "${ecu.id}" has no name`);
  if (ecu.protocol !== "uds" && ecu.protocol !== "kwp2000")
    errors.push(`ECU "${ecu.id}" has unsupported protocol "${ecu.protocol}"`);
  const { txId, rxId } = ecu.address ?? {};
  if (typeof txId !== "number" || typeof rxId !== "number") {
    errors.push(`ECU "${ecu.id}" needs numeric txId/rxId`);
    return;
  }
  const max = ecu.address.extended ? 0x1fffffff : 0x7ff;
  if (txId > max || rxId > max)
    errors.push(
      `ECU "${ecu.id}" identifier out of range for ${ecu.address.extended ? "29-bit" : "11-bit"} addressing`,
    );
  if (txId === rxId) errors.push(`ECU "${ecu.id}" txId and rxId must differ`);
  for (const dtc of ecu.dtcs ?? []) {
    if (!DTC_CODE.test(dtc.code))
      errors.push(`ECU "${ecu.id}" has malformed DTC code "${dtc.code}"`);
    if (!dtc.description) errors.push(`DTC ${dtc.code} has no description`);
  }
}

function validateSignal(
  signal: SignalDefinition,
  ecuIds: Set<string>,
  signalIds: Set<string>,
  errors: string[],
  warnings: string[],
): void {
  if (!signal.id) errors.push("signal without id");
  if (signalIds.has(signal.id)) errors.push(`duplicate signal id "${signal.id}"`);
  signalIds.add(signal.id);
  if (!ecuIds.has(signal.ecu))
    errors.push(`signal "${signal.id}" references unknown ECU "${signal.ecu}"`);
  if (!VALID_ENCODINGS.has(signal.encoding))
    errors.push(`signal "${signal.id}" has unknown encoding "${signal.encoding}"`);
  if (signal.byteOffset < 0) errors.push(`signal "${signal.id}" has a negative byteOffset`);
  if (signal.length < 1) errors.push(`signal "${signal.id}" has a length below 1`);

  const naturalLength = naturalLengthFor(signal.encoding);
  if (naturalLength !== null && signal.bitLength === undefined && signal.length !== naturalLength) {
    errors.push(
      `signal "${signal.id}" declares ${signal.length} bytes but encoding ${signal.encoding} needs ${naturalLength}`,
    );
  }
  if (signal.length > 1 && signal.endianness === undefined) {
    warnings.push(
      `signal "${signal.id}" spans ${signal.length} bytes without explicit endianness (defaulting to big endian)`,
    );
  }
  if ((signal.bitOffset !== undefined) !== (signal.bitLength !== undefined)) {
    errors.push(`signal "${signal.id}" must define bitOffset and bitLength together`);
  }
  if (signal.bitLength !== undefined && (signal.bitLength < 1 || signal.bitLength > 32)) {
    errors.push(`signal "${signal.id}" has an unsupported bitLength ${signal.bitLength}`);
  }
  if (signal.min !== undefined && signal.max !== undefined && signal.min > signal.max) {
    errors.push(`signal "${signal.id}" has min > max`);
  }
  if (signal.enumMapping && Object.keys(signal.enumMapping).length === 0) {
    warnings.push(`signal "${signal.id}" declares an empty enumMapping`);
  }
  if (
    !signal.unit &&
    signal.encoding !== "ascii" &&
    signal.encoding !== "bool" &&
    signal.encoding !== "bitmask"
  ) {
    warnings.push(`signal "${signal.id}" has no unit — reports will show raw values`);
  }
}

function naturalLengthFor(encoding: string): number | null {
  switch (encoding) {
    case "uint8":
    case "int8":
    case "bool":
      return 1;
    case "uint16":
    case "int16":
      return 2;
    case "uint24":
      return 3;
    case "uint32":
    case "int32":
    case "float32":
      return 4;
    default:
      return null;
  }
}

/** Throws a DefinitionError listing every problem — used by loaders. */
export function assertValidPackage(pkg: DefinitionPackage): DefinitionPackage {
  const result = validateDefinitionPackage(pkg);
  if (!result.valid) {
    throw new DefinitionError(
      `definition package "${pkg.name}" is invalid:\n- ${result.errors.join("\n- ")}`,
      {
        package: pkg.name,
        errors: result.errors,
      },
    );
  }
  return pkg;
}
