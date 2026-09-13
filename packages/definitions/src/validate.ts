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
  type Provenance,
  SUPPORTED_SCHEMA_VERSIONS,
  type SignalDefinition,
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
      `schemaVersion ${pkg.schemaVersion} predates ${CURRENT_SCHEMA_VERSION}: no vehicle definitions, ` +
        "so the package cannot narrow its ECUs to one car (run upgradePackage)",
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

  const vehicleIds = new Set<string>();
  for (const vehicle of pkg.vehicles ?? []) {
    validateVehicle(vehicle, ecuIds, vehicleIds, errors, warnings);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateProvenance(
  path: string,
  provenance: Provenance,
  errors: string[],
  warnings: string[],
): void {
  if (!provenance.sourceType) errors.push(`${path}.sourceType is required`);
  if (!provenance.source) errors.push(`${path}.source is required`);
  if (provenance.sourceType === "licensed" && !provenance.license) {
    errors.push(`${path}: licensed data must declare a license`);
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
