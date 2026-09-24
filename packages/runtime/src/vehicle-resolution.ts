/**
 * Vehicle resolution input (AGENTS 11).
 *
 * Turns what a live session knows into the query the definitions layer resolves
 * against. Kept out of the services so the mapping rules are testable on their
 * own and so `services.ts` stays inside its size budget (AGENTS 0.E → docs/architecture/backlog.md E15):
 *
 *  - the VIN comes from the vehicle identity unless the caller overrides it,
 *  - identification values are attributed to the package that produced them,
 *    because the engine names a matched ECU "<oem>:<id>" and the same ECU id can
 *    exist in two packages,
 *  - only ECUs that actually answered count as discovered,
 *  - what the session believes about the car is *declared* evidence, which the
 *    resolver weighs below anything read from the bus.
 */

import type { ResolveVehicleHints } from "@vdp/application";
import type {
  DtcVehicleContext,
  VehicleDetermination,
  VehicleDeterminationEvidence,
} from "@vdp/core";
import type {
  EcuSummary,
  IdentificationFactRef,
  ResolveVehicleQuery,
  VehicleCandidateRef,
  VehicleEvidenceRef,
  VehicleResolutionRef,
  VehicleSummary,
} from "@vdp/domain";

export interface VehicleFactInput {
  identity?: VehicleSummary;
  ecus: readonly EcuSummary[];
  hints?: ResolveVehicleHints;
}

/** Split the engine's namespaced ECU reference ("<oem>:<id>") into its parts. */
export function splitDefinitionEcuId(
  value: string | undefined,
): { oem?: string; ecu: string } | undefined {
  if (!value) return undefined;
  const separator = value.indexOf(":");
  if (separator < 0) return { ecu: value };
  return { oem: value.slice(0, separator), ecu: value.slice(separator + 1) };
}

/**
 * The declared side of a resolution: what the session believes it knows about the
 * car, overridden by whatever the caller claims.
 */
export function declaredOf(
  identity: VehicleSummary | undefined,
  hints: ResolveVehicleHints | undefined,
): NonNullable<ResolveVehicleQuery["declared"]> {
  const declared: NonNullable<ResolveVehicleQuery["declared"]> = {};
  if (identity?.manufacturer) declared.brand = identity.manufacturer;
  if (identity?.brand) declared.brand = identity.brand;
  if (identity?.model) declared.model = identity.model;
  if (identity?.platform) declared.platform = identity.platform;
  if (identity?.modelYear !== undefined) declared.modelYear = identity.modelYear;
  const hint = hints?.declared;
  if (hint) {
    if (hint.oem) declared.oem = hint.oem;
    if (hint.brand) declared.brand = hint.brand;
    if (hint.model) declared.model = hint.model;
    if (hint.platform) declared.platform = hint.platform;
    if (hint.modelYear !== undefined) declared.modelYear = hint.modelYear;
  }
  return declared;
}

/** DID carrying the vehicle identification number (ISO 14229-1 F190). */
const VEHICLE_IDENTIFIER_DID = 0xf190;

/**
 * Is this identification entry the VIN?
 *
 * Checked by DID first — labels come from definition packages and from the
 * fallback the reader uses for an unknown ECU, so they cannot be trusted to say
 * "VIN" in one spelling.
 */
function isVinEntry(entry: { label: string; did?: number }): boolean {
  if (entry.did === VEHICLE_IDENTIFIER_DID) return true;
  const label = entry.label.trim().toUpperCase();
  return label === "VIN" || label === "VEHICLE IDENTIFICATION NUMBER";
}

/** Build the resolution query from the session's facts. */
export function resolveVehicleQuery(input: VehicleFactInput): ResolveVehicleQuery {
  const vin = input.hints?.vin ?? input.identity?.vin;

  const identifications: IdentificationFactRef[] = [];
  for (const ecu of input.ecus) {
    const definition = splitDefinitionEcuId(ecu.definitionEcuId);
    if (!definition) continue;
    for (const entry of ecu.identification) {
      // The VIN arrives separately (see below); feeding it in as an
      // identification value would only add noise — and a spurious token match
      // if a definition ever declared the VIN as a part number.
      if (isVinEntry(entry)) continue;
      identifications.push({
        ...(definition.oem !== undefined ? { oem: definition.oem } : {}),
        ecu: definition.ecu,
        ...(entry.did !== undefined ? { did: entry.did } : {}),
        value: entry.value,
      });
    }
  }

  return {
    ...(vin !== undefined ? { vin } : {}),
    identifications,
    discoveredAddresses: input.ecus
      .filter((ecu) => ecu.reachable)
      .map((ecu) => ({ txId: ecu.txId, rxId: ecu.rxId, extended: ecu.extended })),
    declared: declaredOf(input.identity, input.hints),
  };
}

/**
 * What the DTC system needs from a resolution (AGENTS 11 → AGENTS 20).
 *
 * Only the narrowing the evidence produced is passed on: engines the resolver did
 * not identify stay unknown, so knowledge written for one engine cannot be
 * attributed to another. `undefined` for an unresolved car — the fault list then
 * keeps showing the manufacturer-wide wording and says that it does.
 */
export function dtcVehicleContextOf(
  candidate: VehicleCandidateRef | undefined,
): DtcVehicleContext | undefined {
  if (candidate === undefined) return undefined;
  const context: DtcVehicleContext = {
    oem: candidate.oem,
    vehicleId: candidate.vehicleId,
  };
  if (candidate.engineIds.length > 0) context.engineIds = [...candidate.engineIds];
  if (candidate.gearboxIds.length > 0) context.gearboxIds = [...candidate.gearboxIds];
  return context;
}

/** Copy one evidence entry into the shape a session stores (§11.1 rule 2). */
function evidenceOf(entries: readonly VehicleEvidenceRef[]): VehicleDeterminationEvidence[] {
  return entries.map((entry) => ({
    kind: entry.kind,
    observed: entry.observed,
    expected: entry.expected,
    weight: entry.weight,
    reason: entry.reason,
  }));
}

/**
 * The resolution as a session record (ADR 0026).
 *
 * Only what the resolver actually produced is carried over: the winner with its
 * evidence, the runner-ups reduced to id and score, the provider's own notes, and
 * — for an unresolved car — the reason the provider gave. Nothing is invented here,
 * because a session that claims a car it could not determine is exactly the failure
 * mode §11.1 rule 3 exists to prevent. `resolvedAt` is added by the session, which
 * owns the timestamp of the record.
 */
export function vehicleDeterminationOf(
  resolution: VehicleResolutionRef,
): Omit<VehicleDetermination, "resolvedAt"> {
  const best = resolution.best;
  const reason = best === undefined ? resolution.notes[0] : undefined;
  return {
    ...(best === undefined
      ? {}
      : {
          match: {
            oem: best.oem,
            packageVersion: best.packageVersion,
            vehicleId: best.vehicleId,
            brand: best.brand,
            model: best.model,
            ...(best.platform !== undefined ? { platform: best.platform } : {}),
            score: best.score,
            trust: best.trust,
            ...(best.provenanceType !== undefined ? { provenanceType: best.provenanceType } : {}),
            engineIds: [...best.engineIds],
            gearboxIds: [...best.gearboxIds],
            ecus: {
              expected: best.expectedEcus,
              matched: best.matchedEcus,
              missing: [...best.missingEcus],
            },
            evidence: evidenceOf(best.evidence),
            conflicts: evidenceOf(best.conflicts),
          },
        }),
    ...(reason === undefined ? {} : { reason }),
    notes: [...resolution.notes],
    unexplained: [...resolution.unexplained],
    alternatives: resolution.candidates.slice(1).map((candidate) => ({
      vehicleId: candidate.vehicleId,
      oem: candidate.oem,
      score: candidate.score,
    })),
  };
}
