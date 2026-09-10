export * from './schema.js';
export * from './validate.js';
export { genericPackage } from './generic/generic-package.js';
export { vagExamplePackage } from './vag/vag-package.js';
export { mercedesExamplePackage } from './mercedes/mercedes-package.js';

import type { DefinitionPackage } from './schema.js';
import { genericPackage } from './generic/generic-package.js';
import { vagExamplePackage } from './vag/vag-package.js';
import { mercedesExamplePackage } from './mercedes/mercedes-package.js';

/** Registry of built-in packages; importers can add more at runtime (AGENTS 13). */
export class DefinitionRegistry {
  private readonly packages = new Map<string, DefinitionPackage>();

  constructor(initial: readonly DefinitionPackage[] = [genericPackage, vagExamplePackage, mercedesExamplePackage]) {
    for (const pkg of initial) this.register(pkg);
  }

  register(pkg: DefinitionPackage): void {
    this.packages.set(keyOf(pkg), pkg);
  }

  get(oem: string): DefinitionPackage | undefined {
    for (const [key, pkg] of this.packages) if (key === oem || pkg.oem === oem) return pkg;
    return undefined;
  }

  /** Look an ECU definition up across all packages by request identifier. */
  findEcuByAddress(txId: number, extended = false): { pkg: DefinitionPackage; ecuId: string } | undefined {
    for (const pkg of this.packages.values()) {
      for (const ecu of pkg.ecus) {
        // `extended` is optional in EcuAddress; unset means 11-bit addressing.
        if ((ecu.address.extended ?? false) === extended && ecu.address.txId === txId) return { pkg, ecuId: ecu.id };
      }
    }
    return undefined;
  }

  all(): DefinitionPackage[] {
    return Array.from(this.packages.values());
  }

  list(): Array<{ oem: string; name: string; version: string; ecus: number; signals: number }> {
    return this.all().map((pkg) => ({
      oem: pkg.oem,
      name: pkg.name,
      version: pkg.version,
      ecus: pkg.ecus.length,
      signals: pkg.signals.length,
    }));
  }
}

export function keyOf(pkg: DefinitionPackage): string {
  return `${pkg.oem}@${pkg.version}`;
}
