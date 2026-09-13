/**
 * Definition service (target architecture §4, §32 Phase 3 "Definition
 * Registry").
 *
 * Bridges the versioned `DefinitionPackage` data into the domain's
 * `DefinitionProvider` port. The core only ever sees the port; today the
 * packages are imported values, tomorrow they can be loaded from JSON,
 * SQLite or a cloud API without the runtime changing.
 */

import {
  type DefinitionPackage,
  type EcuDefinition,
  type VehicleCandidate,
  type VehicleResolution,
  VehicleResolver,
  indexPackage,
} from "@vdp/definitions";
import type {
  DefinitionProvider,
  DidDefinitionRef,
  EcuDefinitionRef,
  FindDidQuery,
  FindEcuQuery,
  ResolveVehicleQuery,
  SignalDefinitionRef,
  VehicleCandidateRef,
  VehicleDefinitionRef,
  VehicleEvidenceRef,
  VehicleResolutionRef,
} from "@vdp/domain";

export class PackageDefinitionProvider implements DefinitionProvider {
  readonly source: string;
  private readonly resolver: VehicleResolver;

  constructor(
    private readonly packages: readonly DefinitionPackage[],
    source = "builtin-packages",
  ) {
    this.source = source;
    this.resolver = new VehicleResolver(packages);
  }

  listPackages(): VehicleDefinitionRef[] {
    return this.packages.map((pkg) => ({
      oem: pkg.oem,
      name: pkg.name,
      version: pkg.version,
      vehicles: (pkg.vehicles ?? []).length,
    }));
  }

  findEcu(query: FindEcuQuery): EcuDefinitionRef | undefined {
    for (const pkg of this.packages) {
      if (query.oem !== undefined && pkg.oem !== query.oem) continue;
      for (const ecu of pkg.ecus) {
        const matches =
          (query.id !== undefined && ecu.id === query.id) ||
          (query.rxId !== undefined && ecu.address.rxId === query.rxId) ||
          (query.txId !== undefined && ecu.address.txId === query.txId);
        if (matches) return this.toEcuRef(pkg, ecu);
      }
    }
    return undefined;
  }

  findDid(query: FindDidQuery): DidDefinitionRef | undefined {
    for (const pkg of this.packages) {
      const signalIndex = indexPackage(pkg);
      for (const [ecuId, dids] of signalIndex.byDid) {
        if (query.ecu !== undefined && ecuId !== query.ecu) continue;
        const signals = dids.get(query.did);
        if (signals && signals.length > 0) {
          // Length-checked above, so index 0 exists (noUncheckedIndexedAccess guard).
          const first = signals[0] as (typeof signals)[number];
          return {
            did: query.did,
            ecu: ecuId,
            name: first.name,
            signalIds: signals.map((signal) => signal.id),
          };
        }
      }
      // Identification DIDs carry no signals but are still defined data.
      for (const ecu of pkg.ecus) {
        if (query.ecu !== undefined && ecu.id !== query.ecu) continue;
        const identification = ecu.identification?.find((entry) => entry.did === query.did);
        if (identification) return { did: query.did, ecu: ecu.id, name: identification.label };
      }
    }
    return undefined;
  }

  findSignal(signalId: string): SignalDefinitionRef | undefined {
    for (const pkg of this.packages) {
      const signal = indexPackage(pkg).byId.get(signalId);
      if (signal) {
        return {
          id: signal.id,
          name: signal.name,
          ecu: signal.ecu,
          did: signal.did,
          ...(signal.unit !== undefined ? { unit: signal.unit } : {}),
        };
      }
    }
    return undefined;
  }

  /**
   * Resolve the connected vehicle from VIN, identification values and discovery
   * (AGENTS 11). The ranking and the evidence are computed by the definitions
   * layer; this method only narrows the result to the domain's view, so the
   * domain stays free of definition types (ADR 0014).
   */
  resolveVehicle(query: ResolveVehicleQuery): VehicleResolutionRef {
    const resolution = this.resolver.resolve({
      ...(query.vin !== undefined ? { vin: query.vin } : {}),
      ...(query.identifications !== undefined
        ? { identifications: query.identifications.map((fact) => ({ ...fact })) }
        : {}),
      ...(query.discoveredAddresses !== undefined
        ? { discoveredAddresses: query.discoveredAddresses.map((address) => ({ ...address })) }
        : {}),
      ...(query.declared !== undefined ? { declared: { ...query.declared } } : {}),
    });
    return toResolutionRef(resolution);
  }

  private toEcuRef(pkg: DefinitionPackage, ecu: EcuDefinition): EcuDefinitionRef {
    return {
      id: ecu.id,
      name: ecu.name,
      oem: pkg.oem,
      protocol: ecu.protocol,
      address: {
        txId: ecu.address.txId,
        rxId: ecu.address.rxId,
        ...(ecu.address.extended !== undefined ? { extended: ecu.address.extended } : {}),
      },
      ...(ecu.services !== undefined && ecu.services.length > 0
        ? { services: [...ecu.services] }
        : {}),
    };
  }
}

function toEvidenceRef(evidence: VehicleCandidate["evidence"][number]): VehicleEvidenceRef {
  return {
    kind: evidence.kind,
    observed: evidence.observed,
    expected: evidence.expected,
    weight: evidence.weight,
    reason: evidence.reason,
  };
}

function toCandidateRef(candidate: VehicleCandidate): VehicleCandidateRef {
  return {
    oem: candidate.oem,
    packageVersion: candidate.packageVersion,
    vehicleId: candidate.vehicleId,
    brand: candidate.brand,
    model: candidate.model,
    platform: candidate.platform,
    provenanceType: candidate.provenance.sourceType,
    engineIds: [...candidate.engineIds],
    gearboxIds: [...candidate.gearboxIds],
    score: candidate.score,
    trust: candidate.trust,
    evidence: candidate.evidence.map(toEvidenceRef),
    conflicts: candidate.conflicts.map(toEvidenceRef),
    expectedEcus: candidate.coverage.expected,
    matchedEcus: candidate.coverage.matched,
    missingEcus: [...candidate.coverage.missing],
  };
}

/**
 * Narrow a definition-layer resolution to the domain view.
 *
 * `best` is the first candidate by construction, so it is taken from the mapped
 * list instead of being mapped twice — a client comparing `best` with
 * `candidates[0]` must see the same object, not two equal ones.
 */
function toResolutionRef(resolution: VehicleResolution): VehicleResolutionRef {
  const candidates = resolution.candidates.map(toCandidateRef);
  const best = resolution.best === undefined ? undefined : candidates[0];
  const ref: VehicleResolutionRef = {
    candidates,
    unresolved: resolution.unresolved,
    notes: [...resolution.notes],
    unexplained: [...resolution.unexplained],
  };
  if (best !== undefined) ref.best = best;
  if (resolution.vinLookup !== undefined) ref.vinLookup = { ...resolution.vinLookup };
  return ref;
}
