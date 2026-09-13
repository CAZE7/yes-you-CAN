import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  type DefinitionPackage,
  DefinitionRegistry,
  type VehicleDefinition,
  ecusOfVehicle,
  genericPackage,
  indexPackage,
  indexVehicles,
  mercedesExamplePackage,
  vagExamplePackage,
  validateDefinitionPackage,
} from "./index.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("all built-in packages are valid", () => {
  for (const pkg of [genericPackage, vagExamplePackage, mercedesExamplePackage]) {
    const result = validateDefinitionPackage(pkg);
    assert.deepEqual(result.errors, [], `${pkg.name} must be valid: ${result.errors.join(", ")}`);
    assert.equal(result.valid, true);
  }
});

test("placeholder packages are flagged with a warning, not shipped silently (AGENTS 24)", () => {
  const result = validateDefinitionPackage(vagExamplePackage);
  assert.ok(
    result.warnings.some((w) => w.includes("placeholder")),
    "placeholder provenance must warn",
  );
  const generic = validateDefinitionPackage(genericPackage);
  assert.equal(
    generic.warnings.some((w) => w.includes("placeholder")),
    false,
  );
});

test("non-SemVer versions are rejected (AGENTS 13)", () => {
  const pkg = clone(genericPackage);
  pkg.version = "1.0";
  const result = validateDefinitionPackage(pkg);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("SemVer")));
});

test("missing provenance is rejected", () => {
  const pkg = clone(genericPackage);
  // @ts-expect-error deliberate invalid input
  delete pkg.provenance;
  assert.equal(validateDefinitionPackage(pkg).valid, false);
});

test("licensed data without a license declaration is rejected", () => {
  const pkg = clone(genericPackage);
  pkg.provenance = { sourceType: "licensed", source: "OEM documentation" };
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes("license")));
});

test("wrong schema version is rejected", () => {
  const pkg = clone(genericPackage);
  pkg.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
  assert.equal(validateDefinitionPackage(pkg).valid, false);
});

test("signals referencing unknown ECUs are rejected", () => {
  const pkg = clone(genericPackage);
  pkg.signals[0]!.ecu = "does-not-exist";
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes("unknown ECU")));
});

test("duplicate signal and ECU ids are rejected", () => {
  const pkg = clone(genericPackage);
  pkg.signals.push(clone(pkg.signals[0]!));
  pkg.ecus.push(clone(pkg.ecus[0]!));
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes("duplicate signal id")));
  assert.ok(result.errors.some((e) => e.includes("duplicate ECU id")));
});

test("encoding length mismatches are rejected", () => {
  const pkg = clone(genericPackage);
  const rpm = pkg.signals.find((s) => s.id === "engine.rpm")!;
  rpm.length = 3;
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes("engine.rpm") && e.includes("encoding")));
});

test("bitOffset and bitLength must be defined together", () => {
  const pkg = clone(genericPackage);
  pkg.signals[0]!.bitOffset = 2;
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes("bitOffset and bitLength together")));
});

test("identical tx and rx identifiers are rejected", () => {
  const pkg = clone(genericPackage);
  pkg.ecus[0]!.address.rxId = pkg.ecus[0]!.address.txId;
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes("must differ")));
});

test("11-bit identifiers out of range are rejected", () => {
  const pkg = clone(genericPackage);
  pkg.ecus[0]!.address.txId = 0x18daf100;
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes("out of range")));
});

test("malformed DTC codes are rejected", () => {
  const pkg = clone(genericPackage);
  pkg.ecus[0]!.dtcs!.push({ code: "X9999", description: "broken" });
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes("malformed DTC")));
});

test("indexPackage groups signals per ECU and DID", () => {
  const index = indexPackage(genericPackage);
  assert.equal(index.byId.get("engine.rpm")?.unit, "rpm");
  assert.ok((index.byEcu.get("engine")?.length ?? 0) > 5);
  const absWheelSpeeds = index.byDid.get("abs")?.get(0xf40d);
  assert.equal(absWheelSpeeds?.length, 2, "two wheel speeds share one DID with different offsets");
});

test("registry resolves packages by OEM and ECU by address", () => {
  const registry = new DefinitionRegistry();
  assert.equal(registry.get("generic")?.version, "1.0.0");
  assert.equal(registry.get("vag")?.oem, "vag");
  const found = registry.findEcuByAddress(0x7e0);
  assert.equal(found?.ecuId, "engine");
  assert.equal(registry.findEcuByAddress(0x18daf107, true)?.ecuId, "sam_front");
  assert.equal(registry.list().length, 3);
});

test("registry accepts additional packages at runtime", () => {
  const registry = new DefinitionRegistry([]);
  const pkg: DefinitionPackage = {
    ...clone(genericPackage),
    oem: "custom",
    name: "Custom",
    version: "2.0.0",
  };
  registry.register(pkg);
  assert.equal(registry.get("custom")?.version, "2.0.0");
  assert.equal(registry.all().length, 1);
});

/** A minimal valid vehicle attached to the generic package's first ECU. */
function vehicleFixture(): VehicleDefinition {
  const ecu = genericPackage.ecus[0];
  assert.ok(ecu, "the fixture needs at least one ECU");
  return {
    id: "fixture-car",
    brand: "Fixture",
    model: "One",
    platform: "P",
    modelYears: { from: 2015, to: 2020 },
    vinMatch: { wmi: ["WVW"], vdsPattern: "ZZZ..", modelYearChars: ["F"], plantChars: ["W"] },
    engines: [{ id: "e1", name: "Engine one", codes: ["EX"] }],
    gearboxes: [{ id: "g1", name: "Gearbox one", gears: 6 }],
    ecus: [{ ecu: ecu.id, partNumbers: ["PN"], engine: "e1", gearbox: "g1" }],
  };
}

function withVehicle(vehicle: VehicleDefinition): DefinitionPackage {
  const pkg = clone(genericPackage);
  pkg.vehicles = [vehicle];
  return pkg;
}

test("a well-formed vehicle definition validates without complaint", () => {
  const result = validateDefinitionPackage(withVehicle(vehicleFixture()));
  assert.deepEqual(result.errors, [], result.errors.join(", "));
  assert.ok(!result.warnings.some((w) => w.includes("fixture-car")), result.warnings.join(", "));
});

test("vehicles need an id, a brand and a model", () => {
  const vehicle = vehicleFixture();
  vehicle.id = "";
  vehicle.brand = "";
  vehicle.model = "";
  const result = validateDefinitionPackage(withVehicle(vehicle));
  assert.ok(result.errors.some((e) => e.includes("vehicle without id")));
  assert.ok(result.errors.some((e) => e.includes("has no brand")));
  assert.ok(result.errors.some((e) => e.includes("has no model")));
});

test("duplicate vehicle ids are rejected", () => {
  const pkg = clone(genericPackage);
  pkg.vehicles = [vehicleFixture(), vehicleFixture()];
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes('duplicate vehicle id "fixture-car"')));
});

test("a vehicle may only reference ECUs, engines and gearboxes it can see", () => {
  const vehicle = vehicleFixture();
  vehicle.ecus = [
    { ecu: "no-such-ecu" },
    { ecu: genericPackage.ecus[0]!.id, engine: "no-such-engine", gearbox: "no-such-gearbox" },
  ];
  const result = validateDefinitionPackage(withVehicle(vehicle));
  assert.ok(result.errors.some((e) => e.includes('references unknown ECU "no-such-ecu"')));
  assert.ok(result.errors.some((e) => e.includes('references unknown engine "no-such-engine"')));
  assert.ok(result.errors.some((e) => e.includes('references unknown gearbox "no-such-gearbox"')));
});

test("VIN criteria must have VIN shapes (ISO 3779: no I, O or Q)", () => {
  const badWmi = vehicleFixture();
  badWmi.vinMatch = { wmi: ["WV", "IOQ"] };
  const wmiResult = validateDefinitionPackage(withVehicle(badWmi));
  assert.ok(wmiResult.errors.some((e) => e.includes('WMI "WV"')));
  assert.ok(wmiResult.errors.some((e) => e.includes('WMI "IOQ"')));

  const badVds = vehicleFixture();
  badVds.vinMatch = { vdsPattern: "ZZ.." };
  assert.ok(
    validateDefinitionPackage(withVehicle(badVds)).errors.some((e) =>
      e.includes('vdsPattern "ZZ.."'),
    ),
  );

  const badChars = vehicleFixture();
  badChars.vinMatch = { modelYearChars: ["II", "F"], plantChars: ["O"] };
  const charResult = validateDefinitionPackage(withVehicle(badChars));
  assert.ok(charResult.errors.some((e) => e.includes('model year character "II"')));
  assert.ok(charResult.errors.some((e) => e.includes('plant character "O"')));
});

test("model year ranges must be plausible and ordered", () => {
  const tooEarly = vehicleFixture();
  tooEarly.modelYears = { from: 1900 };
  assert.ok(
    validateDefinitionPackage(withVehicle(tooEarly)).errors.some((e) =>
      e.includes("implausible model year start"),
    ),
  );

  const reversed = vehicleFixture();
  reversed.modelYears = { from: 2020, to: 2015 };
  assert.ok(
    validateDefinitionPackage(withVehicle(reversed)).errors.some((e) =>
      e.includes("modelYears.to < modelYears.from"),
    ),
  );

  const tooLate = vehicleFixture();
  tooLate.modelYears = { from: 2015, to: 3000 };
  assert.ok(
    validateDefinitionPackage(withVehicle(tooLate)).errors.some((e) =>
      e.includes("implausible model year end"),
    ),
  );
});

test("powertrain entries need names and non-degenerate values", () => {
  const vehicle = vehicleFixture();
  vehicle.engines = [
    { id: "e1", name: "" },
    { id: "e1", name: "Duplicate", codes: ["  "], displacementCc: 0 },
  ];
  vehicle.gearboxes = [
    { id: "g1", name: "" },
    { id: "g1", name: "Duplicate", gears: 0 },
  ];
  const result = validateDefinitionPackage(withVehicle(vehicle));
  assert.ok(result.errors.some((e) => e.includes('engine "e1" has no name')));
  assert.ok(result.errors.some((e) => e.includes('duplicate engine id "e1"')));
  assert.ok(result.errors.some((e) => e.includes("declares an empty code")));
  assert.ok(result.errors.some((e) => e.includes("non-positive displacement")));
  assert.ok(result.errors.some((e) => e.includes('gearbox "g1" has no name')));
  assert.ok(result.errors.some((e) => e.includes('duplicate gearbox id "g1"')));
  assert.ok(result.errors.some((e) => e.includes("fewer than one gear")));
});

test("a vehicle-level provenance is validated like the package one (AGENTS 24)", () => {
  const licensed = vehicleFixture();
  licensed.provenance = { sourceType: "licensed", source: "OEM documentation" };
  assert.ok(
    validateDefinitionPackage(withVehicle(licensed)).errors.some((e) =>
      e.includes("licensed data must declare a license"),
    ),
  );

  const placeholder = vehicleFixture();
  placeholder.provenance = { sourceType: "example-placeholder", source: "invented" };
  assert.ok(
    validateDefinitionPackage(withVehicle(placeholder)).warnings.some((w) =>
      w.includes("placeholder data"),
    ),
  );
});

test("a vehicle that can only match a user's own claim is flagged", () => {
  const vehicle = vehicleFixture();
  vehicle.vinMatch = undefined;
  vehicle.ecus = [];
  const result = validateDefinitionPackage(withVehicle(vehicle));
  assert.deepEqual(result.errors, []);
  assert.ok(
    result.warnings.some((w) => w.includes("neither VIN criteria nor ECUs")),
    result.warnings.join(", "),
  );
});

test("a version 1 package stays readable but says what it cannot do", () => {
  const legacy = clone(genericPackage);
  legacy.schemaVersion = 1;
  const result = validateDefinitionPackage(legacy);
  assert.equal(result.valid, true, "reading an older package is not an error");
  assert.ok(
    result.warnings.some((w) => w.includes("predates 2")),
    result.warnings.join(", "),
  );
  assert.ok(result.warnings.some((w) => w.includes("upgradePackage")));
});

test("the VAG example package demonstrates the vehicle axis and stays flagged", () => {
  const result = validateDefinitionPackage(vagExamplePackage);
  assert.deepEqual(result.errors, [], result.errors.join(", "));
  const vehicle = vagExamplePackage.vehicles?.[0];
  assert.equal(vehicle?.id, "vag-example-variant");
  assert.equal(vehicle?.ecus?.[0]?.ecu, "engine");
  assert.equal(vehicle?.engines?.[0]?.id, "example-1-4-tsi");
  assert.ok(
    result.warnings.some((w) => w.includes("placeholder")),
    "it is invented data",
  );
});

test("vehicles are indexed by id and narrowed to their ECU set", () => {
  assert.equal(indexVehicles(vagExamplePackage).get("vag-example-variant")?.brand, "Example brand");
  assert.equal(indexVehicles(genericPackage).size, 0, "an OEM-wide package has no vehicle axis");

  const vehicle = vehicleFixture();
  const pkg = withVehicle(vehicle);
  const ecus = ecusOfVehicle(pkg, vehicle);
  assert.deepEqual(
    ecus.map((ecu) => ecu.id),
    [genericPackage.ecus[0]!.id],
  );

  const oemWide = vehicleFixture();
  oemWide.ecus = undefined;
  assert.equal(
    ecusOfVehicle(pkg, oemWide).length,
    pkg.ecus.length,
    "no ECU list means the whole package, never an invented exclusion",
  );

  const dangling = vehicleFixture();
  dangling.ecus = [{ ecu: "no-such-ecu" }];
  assert.deepEqual(ecusOfVehicle(pkg, dangling), [], "an unknown reference yields nothing");
});

test("indexing a package twice reuses the cached index", () => {
  const first = indexVehicles(vagExamplePackage);
  assert.equal(indexVehicles(vagExamplePackage), first);
});

test("the natural byte length of an encoding is enforced", () => {
  const pkg = clone(genericPackage);
  pkg.signals.push(
    {
      id: "engine.count24",
      name: "24-bit counter",
      ecu: "engine",
      did: 0x2100,
      byteOffset: 0,
      length: 2,
      encoding: "uint24",
      endianness: "big",
    },
    {
      id: "engine.delta16",
      name: "Signed delta",
      ecu: "engine",
      did: 0x2101,
      byteOffset: 0,
      length: 2,
      encoding: "int16",
      endianness: "big",
    },
    {
      id: "engine.counter32",
      name: "32-bit counter",
      ecu: "engine",
      did: 0x2102,
      byteOffset: 0,
      length: 4,
      encoding: "uint32",
      endianness: "little",
    },
    {
      id: "engine.signed32",
      name: "Signed 32-bit",
      ecu: "engine",
      did: 0x2103,
      byteOffset: 0,
      length: 4,
      encoding: "int32",
      endianness: "little",
    },
    {
      id: "engine.ratio",
      name: "Float ratio",
      ecu: "engine",
      did: 0x2104,
      byteOffset: 0,
      length: 4,
      encoding: "float32",
      endianness: "big",
    },
    {
      id: "engine.code",
      name: "ASCII code",
      ecu: "engine",
      did: 0x2105,
      byteOffset: 0,
      length: 5,
      encoding: "ascii",
    },
  );
  const result = validateDefinitionPackage(pkg);
  assert.ok(
    result.errors.some((error) => error.includes("uint24") && error.includes("needs 3")),
    `a 24-bit value in two bytes must be rejected: ${result.errors.join("; ")}`,
  );
  assert.equal(
    result.errors.some((error) => /int16|uint32|int32|float32|ascii/.test(error)),
    false,
    `correctly sized signals must pass: ${result.errors.join("; ")}`,
  );
});

test("an empty enum mapping and a unitless measurement are warnings, not errors", () => {
  const pkg = clone(genericPackage);
  pkg.signals.push(
    {
      id: "engine.mode",
      name: "Mode",
      ecu: "engine",
      did: 0x2110,
      byteOffset: 0,
      length: 1,
      encoding: "bitmask",
      enumMapping: {},
    },
    {
      id: "engine.raw",
      name: "Raw value",
      ecu: "engine",
      did: 0x2111,
      byteOffset: 0,
      length: 2,
      encoding: "uint16",
      endianness: "big",
    },
  );
  const result = validateDefinitionPackage(pkg);
  assert.equal(result.valid, true, result.errors.join("; "));
  assert.ok(
    result.warnings.some((warning) => warning.includes("empty enumMapping")),
    `an empty mapping says nothing: ${result.warnings.join("; ")}`,
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes("no unit")),
    `a unitless measurement is a report problem, not a package error: ${result.warnings.join("; ")}`,
  );
});
