/**
 * Vehicle identity (AGENTS 11).
 *
 * A vehicle is never just a model name: the VIN plus the fields decoded from it
 * plus whatever the ECUs report make up the identity stored in a session.
 */

import { type VinAnalysis, analyseVin, guessModelYear } from "./vin.js";

export interface VehicleIdentity {
  vin?: string;
  vinAnalysis?: VinAnalysis;
  manufacturer?: string;
  brand?: string;
  model?: string;
  modelYear?: number;
  platform?: string;
  engine?: string;
  gearbox?: string;
  /** ECU identifiers discovered on the bus (see ECU explorer, AGENTS 12). */
  ecus?: string[];
  /** Free-form attributes a definition package or the user supplied. */
  attributes?: Record<string, string>;
}

export function createIdentityFromVin(
  vin: string,
  extra: Partial<VehicleIdentity> = {},
): VehicleIdentity {
  const analysis = analyseVin(vin);
  return {
    ...extra,
    vin: analysis.vin,
    vinAnalysis: analysis,
    modelYear:
      extra.modelYear ??
      (analysis.wellFormed ? (guessModelYear(analysis.modelYearChar) ?? undefined) : undefined),
    ecus: extra.ecus ?? [],
    attributes: extra.attributes ?? {},
  };
}

/** Human readable one-liner for reports and the UI header. */
export function describeVehicle(identity: VehicleIdentity | undefined): string {
  if (!identity) return "unknown vehicle";
  const parts = [
    identity.brand,
    identity.model,
    identity.modelYear ? String(identity.modelYear) : undefined,
  ].filter((part): part is string => Boolean(part));
  const label = parts.length > 0 ? parts.join(" ") : "unknown vehicle";
  return identity.vin ? `${label} (${identity.vin})` : label;
}

/**
 * VINs are personal data (AGENTS 27). This form is safe for logs/reports that
 * leave the machine.
 */
export function maskVin(vin: string | undefined, visiblePrefix = 3, visibleSuffix = 4): string {
  if (!vin) return "—";
  if (vin.length <= visiblePrefix + visibleSuffix) return "*".repeat(vin.length);
  // No slice(-n) tricks: slice(-0) is slice(0) and would leak the whole VIN when
  // visibleSuffix is 0. The tail is cut by positive index only.
  const tailStart = Math.max(visiblePrefix, vin.length - visibleSuffix);
  return `${vin.slice(0, visiblePrefix)}${"*".repeat(tailStart - visiblePrefix)}${vin.slice(tailStart)}`;
}
