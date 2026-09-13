export * from "./schema.js";
export * from "./validate.js";
export * from "./json.js";
export * from "./migrate.js";
export * from "./vehicles.js";
export * from "./evidence.js";
export * from "./resolve.js";
export {
  WMI_PROVENANCE,
  type WmiEntry,
  knownWmis,
  lookupWmi,
  regionForVin,
} from "./reference/wmi.js";
export { genericPackage } from "./generic/generic-package.js";
export { vagExamplePackage } from "./vag/vag-package.js";
export { mercedesExamplePackage } from "./mercedes/mercedes-package.js";
export {
  SIMULATOR_VIN,
  simulatorPackage,
  simulatorVehicle,
} from "./simulator/simulator-package.js";

import { genericPackage } from "./generic/generic-package.js";
import { mercedesExamplePackage } from "./mercedes/mercedes-package.js";
import { type VehicleResolution, type VehicleResolutionInput, VehicleResolver } from "./resolve.js";
import { type DefinitionPackage, type VehicleDefinition, indexVehicles, keyOf } from "./schema.js";
import { vagExamplePackage } from "./vag/vag-package.js";

/** A vehicle definition together with the package that declares it. */
export interface RegisteredVehicle {
  packageKey: string;
  oem: string;
  packageVersion: string;
  vehicle: VehicleDefinition;
}

/**
 * Registry of built-in packages; importers can add more at runtime (AGENTS 13).
 *
 * Packages are keyed by `oem@version`, so one manufacturer can be registered with
 * several versions or with several packages side by side (a brand package plus a
 * platform package) — which is the situation the vehicle axis exists for.
 */
export class DefinitionRegistry {
  private readonly packages = new Map<string, DefinitionPackage>();

  constructor(
    initial: readonly DefinitionPackage[] = [
      genericPackage,
      vagExamplePackage,
      mercedesExamplePackage,
    ],
  ) {
    for (const pkg of initial) this.register(pkg);
  }

  register(pkg: DefinitionPackage): void {
    this.packages.set(keyOf(pkg), pkg);
  }

  get(oem: string): DefinitionPackage | undefined {
    for (const [key, pkg] of this.packages) if (key === oem || pkg.oem === oem) return pkg;
    return undefined;
  }

  /** Every registered package, optionally narrowed to one manufacturer. */
  all(oem?: string): DefinitionPackage[] {
    const packages = Array.from(this.packages.values());
    return oem === undefined ? packages : packages.filter((pkg) => pkg.oem === oem);
  }

  /** Look an ECU definition up across all packages by request identifier. */
  findEcuByAddress(
    txId: number,
    extended = false,
  ): { pkg: DefinitionPackage; ecuId: string } | undefined {
    for (const pkg of this.packages.values()) {
      for (const ecu of pkg.ecus) {
        // `extended` is optional in EcuAddress; unset means 11-bit addressing.
        if ((ecu.address.extended ?? false) === extended && ecu.address.txId === txId)
          return { pkg, ecuId: ecu.id };
      }
    }
    return undefined;
  }

  /** One vehicle definition by id, searched across all packages. */
  findVehicle(vehicleId: string): RegisteredVehicle | undefined {
    for (const [packageKey, pkg] of this.packages) {
      const vehicle = indexVehicles(pkg).get(vehicleId);
      if (vehicle) {
        return { packageKey, oem: pkg.oem, packageVersion: pkg.version, vehicle };
      }
    }
    return undefined;
  }

  /** Every vehicle definition known, in registration order. */
  vehicles(): RegisteredVehicle[] {
    const result: RegisteredVehicle[] = [];
    for (const [packageKey, pkg] of this.packages) {
      for (const vehicle of pkg.vehicles ?? []) {
        result.push({ packageKey, oem: pkg.oem, packageVersion: pkg.version, vehicle });
      }
    }
    return result;
  }

  /**
   * Resolve a connected vehicle from VIN, identification values and discovery
   * (AGENTS 11). Ranked candidates with evidence — never a single hard answer.
   */
  resolveVehicle(input: VehicleResolutionInput): VehicleResolution {
    return new VehicleResolver(this.all()).resolve(input);
  }

  list(): Array<{
    oem: string;
    name: string;
    version: string;
    ecus: number;
    signals: number;
    vehicles: number;
  }> {
    return this.all().map((pkg) => ({
      oem: pkg.oem,
      name: pkg.name,
      version: pkg.version,
      ecus: pkg.ecus.length,
      signals: pkg.signals.length,
      vehicles: (pkg.vehicles ?? []).length,
    }));
  }
}
