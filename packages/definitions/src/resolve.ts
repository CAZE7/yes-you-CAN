/**
 * Vehicle resolution — the chain `VIN → vehicle → platform → engine/gearbox →
 * ECUs` turned into evidence (AGENTS 11, 13).
 *
 * The resolver never answers with a single hard fact. It ranks candidates and
 * states, per candidate, *what* spoke for it and *what* spoke against it, with
 * the weight each criterion carried. Two reasons, both load bearing for what
 * comes next:
 *
 *  1. A real bus does not deliver a clean VIN. F190 may be unanswered, answered
 *     late, answered by the wrong ECU, or the car may be a rebadged import whose
 *     WMI points elsewhere. A resolver that commits to one answer turns every
 *     such case into a confident lie.
 *  2. Guided diagnostics and the AI layer consume exactly this shape: evidence,
 *     ranked hypotheses, reasons. If vehicle resolution produces it here, the
 *     layers above do not have to invent their own notion of confidence.
 *
 * Weights, the tally and the ordering rule live in `evidence.ts`; this module
 * walks definitions and turns observations into those criteria. Everything is
 * deterministic — same input, same order, no randomness (AGENTS 31).
 */

import {
  type Rankable,
  type ResolutionEvidence,
  Tally,
  compareByEvidence,
  provenanceTrust,
  sameText,
  unique,
} from "./evidence.js";
import { lookupWmi, regionForVin } from "./reference/wmi.js";
import {
  type DefinitionPackage,
  type EcuDefinition,
  type Provenance,
  type VehicleDefinition,
  type VehicleEcuRef,
  indexEcus,
  keyOf,
} from "./schema.js";
import { type VinFacts, findToken, matchesPattern, vinPositions } from "./vehicles.js";

/** One identification value read from an ECU (UDS 0x22 on an identification DID). */
export interface IdentificationFact {
  /**
   * Manufacturer key of the package the ECU id came from, when the caller knows
   * it. Several packages may use the same ECU id ("engine" in a VW and in a
   * Mercedes package), so naming the package keeps identification evidence from
   * being credited to the wrong vehicle.
   */
  oem?: string;
  /** ECU id as the package names it, e.g. "engine". */
  ecu: string;
  /**
   * DID the value came from, e.g. 0xf187. Optional: matching works on the value
   * and the ECU, so a caller that knows only "this ECU said this" still produces
   * evidence — it just cannot name the DID in the reason.
   */
  did?: number;
  /** Value as the ECU reported it (may carry padding or extra text). */
  value: string;
}

/** One ECU that answered during discovery. */
export interface DiscoveredAddress {
  txId: number;
  rxId: number;
  extended?: boolean;
}

/** What the operator (or a previous session) already claims about the car. */
export interface DeclaredVehicle {
  oem?: string;
  brand?: string;
  model?: string;
  platform?: string;
  modelYear?: number;
}

export interface VehicleResolutionInput {
  /** VIN as read from the vehicle or typed in. */
  vin?: string;
  /**
   * VIN positions the caller already established. Wins over {@link vin} where
   * both are given, so `@vdp/core` can hand over its ISO 3779 analysis (and can
   * withhold `modelYearChar` for a European VIN, where position 10 is not a
   * model year).
   */
  vinFacts?: VinFacts;
  identifications?: IdentificationFact[];
  discoveredAddresses?: DiscoveredAddress[];
  declared?: DeclaredVehicle;
}

/** How much of the vehicle's expected ECU set was actually seen. */
export interface EcuCoverage {
  expected: number;
  matched: number;
  unexpected: number;
  /** ECU ids the definition expects that did not answer. */
  missing: string[];
}

/** One ranked hypothesis about which vehicle is connected. */
export interface VehicleCandidate {
  packageKey: string;
  oem: string;
  packageName: string;
  packageVersion: string;
  /** Provenance of the winning data — vehicle level when it refines the package. */
  provenance: Provenance;
  /** 0…1, from {@link provenanceTrust}. Placeholder data ranks below real data. */
  trust: number;
  vehicleId: string;
  brand: string;
  model: string;
  platform?: string;
  generation?: string;
  /** Powertrains the evidence narrowed down; empty means "not narrowed". */
  engineIds: string[];
  gearboxIds: string[];
  /** `(support − conflict) / evaluated`, clamped to 0…1. */
  score: number;
  weights: { support: number; conflict: number; evaluated: number };
  evidence: ResolutionEvidence[];
  conflicts: ResolutionEvidence[];
  coverage: EcuCoverage;
}

/** What the VIN says about the manufacturer, independent of any vehicle match. */
export interface VinLookup {
  wmi: string;
  manufacturer?: string;
  brand?: string;
  country?: string;
  region?: string;
  /** False when this build's reference table does not know the WMI. */
  known: boolean;
}

export interface VehicleResolution {
  /** Ranked best first; only candidates with positive evidence are listed. */
  candidates: VehicleCandidate[];
  /** First candidate, or `undefined` when nothing matched. */
  best?: VehicleCandidate;
  unresolved: boolean;
  vinLookup?: VinLookup;
  /** Context the caller should show next to the result (placeholder data, unknown WMI, …). */
  notes: string[];
  /** Observations no registered definition could explain. */
  unexplained: string[];
}

export interface VehicleResolverOptions {
  /** Upper bound for the candidate list; `0` or omitted means unlimited. */
  maxCandidates?: number;
}

export class VehicleResolver {
  constructor(
    private readonly packages: readonly DefinitionPackage[],
    private readonly options: VehicleResolverOptions = {},
  ) {}

  resolve(input: VehicleResolutionInput): VehicleResolution {
    const facts = factsOf(input);
    const candidates: VehicleCandidate[] = [];
    let packagesWithVehicles = 0;

    for (const pkg of this.packages) {
      const vehicles = pkg.vehicles ?? [];
      if (vehicles.length > 0) packagesWithVehicles += 1;
      const ecuIndex = indexEcus(pkg);
      for (const vehicle of vehicles) {
        candidates.push(evaluate(pkg, vehicle, ecuIndex, input, facts));
      }
    }

    const ranked = candidates
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => compareByEvidence(rankOf(a), rankOf(b)));
    const limit = this.options.maxCandidates ?? 0;
    const kept = limit > 0 ? ranked.slice(0, limit) : ranked;

    const resolution: VehicleResolution = {
      candidates: kept,
      unresolved: kept.length === 0,
      notes: [],
      unexplained: unexplainedOf(this.packages, input),
    };
    const best = kept[0];
    if (best) resolution.best = best;
    const lookup = lookupOf(facts);
    if (lookup) resolution.vinLookup = lookup;

    if (packagesWithVehicles === 0) {
      resolution.notes.push(
        `none of the ${this.packages.length} registered package(s) declares vehicle definitions — ` +
          "without them no package can narrow its ECUs to one car",
      );
    }
    if (lookup && !lookup.known) {
      resolution.notes.push(
        `WMI ${lookup.wmi} is not in the reference table (region ${lookup.region ?? "unknown"}) — ` +
          "the manufacturer could not be named from the VIN",
      );
    }
    if (best && best.provenance.sourceType === "example-placeholder") {
      resolution.notes.push(
        `the winning definition "${best.packageName}" is placeholder data, not vehicle truth (ADR 0003)`,
      );
    }
    return resolution;
  }
}

function rankOf(candidate: VehicleCandidate): Rankable {
  return {
    score: candidate.score,
    trust: candidate.trust,
    support: candidate.weights.support,
    matched: candidate.coverage.matched,
    conflicts: candidate.conflicts.length,
    packageKey: candidate.packageKey,
    vehicleId: candidate.vehicleId,
  };
}

/** VIN facts of the input: explicit facts win, the raw VIN fills the gaps. */
function factsOf(input: VehicleResolutionInput): VinFacts | undefined {
  const fromVin = input.vin ? vinPositions(input.vin) : undefined;
  const explicit = input.vinFacts;
  if (!explicit) return fromVin;
  if (!fromVin) return explicit;
  return {
    vin: explicit.vin || fromVin.vin,
    wmi: explicit.wmi ?? fromVin.wmi,
    vds: explicit.vds ?? fromVin.vds,
    // Position 10 is only evidence when the caller states it explicitly — an
    // absent `modelYearChar` in `vinFacts` means "do not treat it as a model year".
    modelYearChar: explicit.modelYearChar,
    plantChar: explicit.plantChar ?? fromVin.plantChar,
    serial: explicit.serial ?? fromVin.serial,
  };
}

function lookupOf(facts: VinFacts | undefined): VinLookup | undefined {
  if (!facts?.wmi) return undefined;
  const entry = lookupWmi(facts.wmi);
  const lookup: VinLookup = { wmi: facts.wmi, known: entry !== undefined };
  if (entry) {
    lookup.manufacturer = entry.manufacturer;
    if (entry.brand) lookup.brand = entry.brand;
    if (entry.country) lookup.country = entry.country;
  }
  const region = regionForVin(facts.vin);
  if (region) lookup.region = region;
  return lookup;
}

function evaluate(
  pkg: DefinitionPackage,
  vehicle: VehicleDefinition,
  ecuIndex: Map<string, EcuDefinition>,
  input: VehicleResolutionInput,
  facts: VinFacts | undefined,
): VehicleCandidate {
  const tally = new Tally();
  const refs = vehicle.ecus ?? [];
  const refByEcu = new Map<string, VehicleEcuRef>(refs.map((ref) => [ref.ecu, ref]));
  const engineIds: string[] = [];
  const gearboxIds: string[] = [];

  weighVin(vehicle, facts, tally);
  weighDeclared(pkg, vehicle, input.declared, tally);
  for (const fact of input.identifications ?? []) {
    // An identification read through another manufacturer's package says nothing
    // about this one — ECU ids are only unique inside a package.
    if (fact.oem !== undefined && fact.oem !== pkg.oem) continue;
    weighIdentification(fact, vehicle, refByEcu.get(fact.ecu), ecuIndex.get(fact.ecu), tally);
    collectPowertrain(vehicle, fact.value, engineIds, gearboxIds, tally);
  }
  const coverage = weighCoverage(pkg, refs, ecuIndex, input.discoveredAddresses ?? [], tally);

  const provenance = vehicle.provenance ?? pkg.provenance;
  const candidate: VehicleCandidate = {
    packageKey: keyOf(pkg),
    oem: pkg.oem,
    packageName: pkg.name,
    packageVersion: pkg.version,
    provenance,
    trust: provenanceTrust(provenance),
    vehicleId: vehicle.id,
    brand: vehicle.brand,
    model: vehicle.model,
    engineIds: unique(engineIds),
    gearboxIds: unique(gearboxIds),
    score: tally.score(),
    weights: tally.weights(),
    evidence: tally.evidence,
    conflicts: tally.conflicts,
    coverage,
  };
  if (vehicle.platform) candidate.platform = vehicle.platform;
  if (vehicle.generation) candidate.generation = vehicle.generation;
  return candidate;
}

function weighVin(vehicle: VehicleDefinition, facts: VinFacts | undefined, tally: Tally): void {
  const matcher = vehicle.vinMatch;
  if (!matcher || !facts) return;

  if (matcher.wmi && matcher.wmi.length > 0 && facts.wmi) {
    const ok = matcher.wmi.some((wmi) => sameText(wmi, facts.wmi ?? ""));
    tally.weigh(
      "vin-wmi",
      facts.wmi,
      matcher.wmi.join(" / "),
      ok
        ? `WMI ${facts.wmi} is one this ${vehicle.brand} definition claims`
        : `WMI ${facts.wmi} is not among the ${matcher.wmi.length} this definition claims`,
      ok,
    );
  }
  if (matcher.vdsPattern && facts.vds) {
    const ok = matchesPattern(facts.vds, matcher.vdsPattern);
    tally.weigh(
      "vin-vds",
      facts.vds,
      matcher.vdsPattern,
      ok
        ? `vehicle descriptor ${facts.vds} matches the pattern ${matcher.vdsPattern}`
        : `vehicle descriptor ${facts.vds} does not match ${matcher.vdsPattern}`,
      ok,
    );
  }
  if (matcher.modelYearChars && matcher.modelYearChars.length > 0 && facts.modelYearChar) {
    const ok = matcher.modelYearChars.some((char) => sameText(char, facts.modelYearChar ?? ""));
    tally.weigh(
      "vin-model-year",
      facts.modelYearChar,
      matcher.modelYearChars.join(""),
      ok
        ? `model year character ${facts.modelYearChar} is covered`
        : `model year character ${facts.modelYearChar} is not covered`,
      ok,
    );
  }
  if (matcher.plantChars && matcher.plantChars.length > 0 && facts.plantChar) {
    const ok = matcher.plantChars.some((char) => sameText(char, facts.plantChar ?? ""));
    tally.weigh(
      "vin-plant",
      facts.plantChar,
      matcher.plantChars.join(""),
      ok
        ? `assembly plant ${facts.plantChar} is covered`
        : `assembly plant ${facts.plantChar} is not covered`,
      ok,
    );
  }
}

/**
 * How a model year range is written into evidence.
 *
 * An open range says where it starts, a single year is written as that year —
 * "2003–2003" reads like a bug in the data rather than like a fact about the car.
 */
function modelYearRange(from: number, to: number | undefined): string {
  if (to === undefined) return `from ${from}`;
  return to === from ? `${from}` : `${from}–${to}`;
}

function weighDeclared(
  pkg: DefinitionPackage,
  vehicle: VehicleDefinition,
  declared: DeclaredVehicle | undefined,
  tally: Tally,
): void {
  if (!declared) return;
  if (declared.oem) {
    const ok = sameText(declared.oem, pkg.oem);
    tally.weigh("declared-oem", declared.oem, pkg.oem, `declared OEM ${declared.oem}`, ok);
  }
  if (declared.brand) {
    const ok = sameText(declared.brand, vehicle.brand);
    tally.weigh("declared-brand", declared.brand, vehicle.brand, `declared brand`, ok);
  }
  if (declared.model) {
    const ok = sameText(declared.model, vehicle.model);
    tally.weigh("declared-model", declared.model, vehicle.model, `declared model`, ok);
  }
  if (declared.platform && vehicle.platform) {
    const ok = sameText(declared.platform, vehicle.platform);
    tally.weigh(
      "declared-platform",
      declared.platform,
      vehicle.platform,
      `declared platform ${declared.platform}`,
      ok,
    );
  }
  if (declared.modelYear !== undefined && vehicle.modelYears) {
    const { from, to } = vehicle.modelYears;
    const ok = declared.modelYear >= from && (to === undefined || declared.modelYear <= to);
    tally.weigh(
      "declared-model-year",
      String(declared.modelYear),
      modelYearRange(from, to),
      `declared model year ${declared.modelYear}`,
      ok,
    );
  }
}

/**
 * Identification kinds with the label words that identify them.
 *
 * A contradiction needs attribution: only when the DID a value came from is
 * documented as *the* part number (or software, or hardware version) can a
 * mismatch contradict the definition. An ECU that answers a DID nobody documented
 * — a serial number, a spare part, a calibration id — produces no evidence at all,
 * and treating it as counter-evidence would reject the right car.
 */
const IDENTIFICATION_KINDS: ReadonlyArray<{
  kind: "part-number" | "software-version" | "hardware-version";
  tokens: (ref: VehicleEcuRef) => string[] | undefined;
  label: string;
  /** Label words in the ECU definition's identification entry that name this kind. */
  labels: RegExp;
}> = [
  {
    kind: "part-number",
    tokens: (ref) => ref.partNumbers,
    label: "part number",
    labels: /part|spare/i,
  },
  {
    kind: "software-version",
    tokens: (ref) => ref.softwareVersions,
    label: "software version",
    labels: /software|application|\bsw\b/i,
  },
  {
    kind: "hardware-version",
    tokens: (ref) => ref.hardwareVersions,
    label: "hardware version",
    labels: /hardware|\bhw\b/i,
  },
];

/**
 * Which identification kind a DID label stands for.
 *
 * Exported because the rule is a contract between a definition package and
 * whoever writes one: a label that names no kind (a serial number, a calibration
 * id) can never contradict a vehicle, and a package author has to be able to
 * check that without reading the resolver.
 */
export function identificationKindForLabel(
  label: string,
): "part-number" | "software-version" | "hardware-version" | undefined {
  return IDENTIFICATION_KINDS.find((kind) => kind.labels.test(label))?.kind;
}

/**
 * Which kind a DID stands for, according to the ECU definition's identification
 * entries (ISO 14229-1 0x22 on F18x). `undefined` means "not documented".
 */
function kindForDid(
  ecu: EcuDefinition | undefined,
  did: number | undefined,
): (typeof IDENTIFICATION_KINDS)[number] | undefined {
  if (!ecu || did === undefined) return undefined;
  const entry = ecu.identification?.find((candidate) => candidate.did === did);
  if (!entry) return undefined;
  return IDENTIFICATION_KINDS.find((kind) => kind.labels.test(entry.label));
}

function weighIdentification(
  fact: IdentificationFact,
  vehicle: VehicleDefinition,
  ref: VehicleEcuRef | undefined,
  ecu: EcuDefinition | undefined,
  tally: Tally,
): void {
  if (!ref) {
    // Only a vehicle that declares its ECU set can contradict an answering ECU;
    // an OEM-wide definition says nothing about which ECUs a car has.
    if (vehicle.ecus && vehicle.ecus.length > 0) {
      const source = fact.did === undefined ? "" : ` DID 0x${fact.did.toString(16)}`;
      tally.weigh(
        "ecu-not-in-vehicle",
        `${fact.ecu} reported${source} "${fact.value.trim()}"`,
        "no ECU entry for it on this vehicle",
        `ECU "${fact.ecu}" answered but this vehicle definition does not list it`,
        false,
      );
    }
    return;
  }

  const declared = IDENTIFICATION_KINDS.filter((entry) => (entry.tokens(ref) ?? []).length > 0);
  if (declared.length === 0) return; // nothing documented to compare against

  const attributed = kindForDid(ecu, fact.did);
  const source = fact.did === undefined ? fact.ecu : `${fact.ecu} (DID 0x${fact.did.toString(16)})`;

  if (attributed) {
    const tokens = attributed.tokens(ref);
    if (!tokens || tokens.length === 0) return; // this DID is not documented for this vehicle
    const token = findToken(fact.value, tokens);
    const expected = tokens.join(" / ");
    tally.weigh(
      attributed.kind,
      fact.value.trim(),
      expected,
      token
        ? `${source} reported ${attributed.label} "${token}", which this vehicle definition expects`
        : `${source} reported "${fact.value.trim()}" but this vehicle expects ${attributed.label} ${expected}`,
      token !== undefined,
    );
    return;
  }

  // Unattributed value: a match is evidence, a mismatch proves nothing.
  for (const entry of declared) {
    const token = findToken(fact.value, entry.tokens(ref));
    if (token) {
      tally.weigh(
        entry.kind,
        fact.value.trim(),
        token,
        `${source} reported ${entry.label} "${token}", which this vehicle definition expects`,
        true,
      );
      return;
    }
  }
}

function collectPowertrain(
  vehicle: VehicleDefinition,
  value: string,
  engineIds: string[],
  gearboxIds: string[],
  tally: Tally,
): void {
  for (const engine of vehicle.engines ?? []) {
    const token = findToken(value, engine.codes);
    if (!token || engineIds.includes(engine.id)) continue;
    engineIds.push(engine.id);
    tally.credit(
      "powertrain-code",
      value.trim(),
      engine.name,
      `identification value contains engine code ${token} → ${engine.name}`,
    );
  }
  for (const gearbox of vehicle.gearboxes ?? []) {
    const token = findToken(value, gearbox.codes);
    if (!token || gearboxIds.includes(gearbox.id)) continue;
    gearboxIds.push(gearbox.id);
    tally.credit(
      "powertrain-code",
      value.trim(),
      gearbox.name,
      `identification value contains gearbox code ${token} → ${gearbox.name}`,
    );
  }
}

function weighCoverage(
  pkg: DefinitionPackage,
  refs: VehicleEcuRef[],
  ecuIndex: Map<string, EcuDefinition>,
  discovered: DiscoveredAddress[],
  tally: Tally,
): EcuCoverage {
  const optionalIds = new Set(refs.filter((ref) => ref.optional).map((ref) => ref.ecu));
  const expectedEcus: EcuDefinition[] =
    refs.length > 0
      ? refs.flatMap((ref) => (ref.optional ? [] : listOf(ecuIndex.get(ref.ecu))))
      : pkg.ecus;

  const missing: string[] = [];
  let matched = 0;
  for (const ecu of expectedEcus) {
    if (discovered.some((address) => addressMatches(ecu, address))) matched += 1;
    else missing.push(ecu.id);
  }
  if (expectedEcus.length > 0) {
    tally.creditFraction(
      "ecu-coverage",
      matched / expectedEcus.length,
      `${matched} of ${expectedEcus.length} expected ECU(s) answered`,
      "every non-optional ECU of this vehicle answers",
      matched === expectedEcus.length
        ? `all ${expectedEcus.length} ECU(s) this vehicle expects were discovered`
        : `${missing.length} expected ECU(s) did not answer: ${missing.join(", ")}`,
    );
  }

  let unexpected = 0;
  if (refs.length > 0) {
    const ownIds = new Set(refs.map((ref) => ref.ecu));
    for (const address of discovered) {
      const owner = pkg.ecus.find((ecu) => addressMatches(ecu, address));
      if (owner && !ownIds.has(owner.id) && !optionalIds.has(owner.id)) unexpected += 1;
    }
    if (unexpected > 0) {
      tally.penalise(
        "unexpected-ecu",
        `${unexpected} ECU(s) answered`,
        "only this vehicle's ECU set answers",
        `${unexpected} discovered ECU(s) belong to the package but not to this vehicle`,
      );
    }
  }
  return { expected: expectedEcus.length, matched, unexpected, missing };
}

/** Observations no registered package can explain — reported, never dropped. */
function unexplainedOf(
  packages: readonly DefinitionPackage[],
  input: VehicleResolutionInput,
): string[] {
  const result: string[] = [];
  const knownEcuIds = new Set<string>();
  const allEcus: EcuDefinition[] = [];
  for (const pkg of packages) {
    allEcus.push(...pkg.ecus);
    for (const ecu of pkg.ecus) knownEcuIds.add(ecu.id);
  }

  for (const fact of input.identifications ?? []) {
    if (!knownEcuIds.has(fact.ecu)) {
      result.push(`identification from ECU "${fact.ecu}" — no registered package defines that ECU`);
    }
  }
  for (const address of input.discoveredAddresses ?? []) {
    if (!allEcus.some((ecu) => addressMatches(ecu, address))) {
      result.push(
        `ECU at 0x${address.txId.toString(16)}/0x${address.rxId.toString(16)}` +
          `${address.extended ? " (29-bit)" : " (11-bit)"} answered — no definition describes it`,
      );
    }
  }
  return unique(result);
}

/** A discovered address matches an ECU definition when either direction agrees. */
function addressMatches(ecu: EcuDefinition, address: DiscoveredAddress): boolean {
  if ((ecu.address.extended ?? false) !== (address.extended ?? false)) return false;
  return ecu.address.txId === address.txId || ecu.address.rxId === address.rxId;
}

function listOf(value: EcuDefinition | undefined): EcuDefinition[] {
  return value ? [value] : [];
}
