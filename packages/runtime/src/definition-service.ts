/**
 * Definition service (target architecture §4, §32 Phase 3 "Definition
 * Registry").
 *
 * Bridges the versioned `DefinitionPackage` data into the domain's
 * `DefinitionProvider` port. The core only ever sees the port; today the
 * packages are imported values, tomorrow they can be loaded from JSON,
 * SQLite or a cloud API without the runtime changing.
 */

import type {
  DefinitionProvider,
  DidDefinitionRef,
  EcuDefinitionRef,
  FindDidQuery,
  FindEcuQuery,
  SignalDefinitionRef,
  VehicleDefinitionRef,
} from '@vdp/domain';
import { indexPackage, type DefinitionPackage, type EcuDefinition } from '@vdp/definitions';

export class PackageDefinitionProvider implements DefinitionProvider {
  readonly source: string;

  constructor(
    private readonly packages: readonly DefinitionPackage[],
    source = 'builtin-packages',
  ) {
    this.source = source;
  }

  listPackages(): VehicleDefinitionRef[] {
    return this.packages.map((pkg) => ({
      oem: pkg.oem,
      name: pkg.name,
      version: pkg.version,
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
      ...(ecu.services !== undefined && ecu.services.length > 0 ? { services: [...ecu.services] } : {}),
    };
  }
}
