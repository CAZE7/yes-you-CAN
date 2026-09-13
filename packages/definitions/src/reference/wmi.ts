/**
 * World Manufacturer Identifier reference data (ISO 3780 / ISO 3779, 49 CFR 565).
 *
 * The WMI is the only part of a VIN whose meaning is standardised worldwide:
 * positions 1–3 name the manufacturer. Everything behind it (VDS, model year,
 * plant) is manufacturer practice, which is why it belongs in a definition
 * package and not in code.
 *
 * **Honesty about this table (AGENTS 24):** it is a small own compilation of
 * publicly documented WMIs — enough to name a manufacturer and a country for a
 * European/NA/Asian VIN, and enough to *test* the vehicle axis end to end. It is
 * deliberately not exhaustive and it is not OEM truth: an unknown WMI must stay
 * unknown ({@link lookupWmi} returns `undefined`) instead of being guessed.
 * Growth happens by adding entries with their own provenance, from licensed or
 * authoritative sources, never by scraping a commercial product's database.
 */

import type { Provenance } from "../schema.js";

export interface WmiEntry {
  /** Positions 1–3 of the VIN, upper case. */
  wmi: string;
  manufacturer: string;
  /** Retail brand, when it differs from the legal manufacturer. */
  brand?: string;
  /** ISO 3166-1 alpha-2 of the manufacturing country. */
  country?: string;
}

export const WMI_PROVENANCE: Provenance = {
  sourceType: "own",
  source: "own compilation of publicly documented WMI assignments (ISO 3780 / 49 CFR 565)",
  notes: "Not exhaustive. Unknown WMIs stay unknown; extend with sourced entries only (AGENTS 24).",
};

const ENTRIES: readonly WmiEntry[] = [
  // Germany
  { wmi: "WAU", manufacturer: "Audi AG", brand: "Audi", country: "DE" },
  { wmi: "WUA", manufacturer: "Audi AG", brand: "Audi", country: "DE" },
  { wmi: "WBA", manufacturer: "Bayerische Motoren Werke AG", brand: "BMW", country: "DE" },
  { wmi: "WBS", manufacturer: "BMW M GmbH", brand: "BMW M", country: "DE" },
  { wmi: "WDB", manufacturer: "Mercedes-Benz AG", brand: "Mercedes-Benz", country: "DE" },
  { wmi: "WDC", manufacturer: "Mercedes-Benz AG", brand: "Mercedes-Benz", country: "DE" },
  { wmi: "WDD", manufacturer: "Mercedes-Benz AG", brand: "Mercedes-Benz", country: "DE" },
  { wmi: "W1V", manufacturer: "Mercedes-Benz AG", brand: "Mercedes-Benz", country: "DE" },
  { wmi: "WME", manufacturer: "smart GmbH", brand: "smart", country: "DE" },
  { wmi: "WMA", manufacturer: "MAN Truck & Bus SE", brand: "MAN", country: "DE" },
  { wmi: "WVW", manufacturer: "Volkswagen AG", brand: "Volkswagen", country: "DE" },
  { wmi: "WV1", manufacturer: "Volkswagen AG", brand: "Volkswagen Nutzfahrzeuge", country: "DE" },
  { wmi: "WV2", manufacturer: "Volkswagen AG", brand: "Volkswagen Nutzfahrzeuge", country: "DE" },
  { wmi: "WVG", manufacturer: "Volkswagen AG", brand: "Volkswagen", country: "DE" },
  { wmi: "WP0", manufacturer: "Porsche AG", brand: "Porsche", country: "DE" },
  { wmi: "WP1", manufacturer: "Porsche AG", brand: "Porsche", country: "DE" },
  { wmi: "WF0", manufacturer: "Ford-Werke GmbH", brand: "Ford", country: "DE" },
  { wmi: "W0L", manufacturer: "Adam Opel AG", brand: "Opel", country: "DE" },
  { wmi: "W0V", manufacturer: "Opel Automobile GmbH", brand: "Opel", country: "DE" },
  // Czechia
  { wmi: "TMB", manufacturer: "Škoda Auto a.s.", brand: "Škoda", country: "CZ" },
  { wmi: "TMT", manufacturer: "Škoda Auto a.s.", brand: "Škoda", country: "CZ" },
  // Hungary
  { wmi: "TRU", manufacturer: "Audi Hungaria Zrt.", brand: "Audi", country: "HU" },
  // France / Spain
  { wmi: "VF1", manufacturer: "Renault SAS", brand: "Renault", country: "FR" },
  { wmi: "VF3", manufacturer: "Peugeot", brand: "Peugeot", country: "FR" },
  { wmi: "VF7", manufacturer: "Citroën", brand: "Citroën", country: "FR" },
  { wmi: "VSS", manufacturer: "SEAT S.A.", brand: "SEAT", country: "ES" },
  // Italy
  { wmi: "ZFA", manufacturer: "Fiat Group Automobiles", brand: "Fiat", country: "IT" },
  { wmi: "ZAR", manufacturer: "Alfa Romeo", brand: "Alfa Romeo", country: "IT" },
  { wmi: "ZFF", manufacturer: "Ferrari S.p.A.", brand: "Ferrari", country: "IT" },
  {
    wmi: "ZHW",
    manufacturer: "Automobili Lamborghini S.p.A.",
    brand: "Lamborghini",
    country: "IT",
  },
  // United Kingdom
  { wmi: "SAL", manufacturer: "Land Rover", brand: "Land Rover", country: "GB" },
  { wmi: "SAJ", manufacturer: "Jaguar Cars", brand: "Jaguar", country: "GB" },
  { wmi: "SCF", manufacturer: "Aston Martin Lagonda", brand: "Aston Martin", country: "GB" },
  { wmi: "SCC", manufacturer: "Lotus Cars", brand: "Lotus", country: "GB" },
  // Sweden
  { wmi: "YV1", manufacturer: "Volvo Car Corporation", brand: "Volvo", country: "SE" },
  { wmi: "YS2", manufacturer: "Scania AB", brand: "Scania", country: "SE" },
  // Japan / Korea / China
  { wmi: "JHM", manufacturer: "Honda Motor Co.", brand: "Honda", country: "JP" },
  { wmi: "JTD", manufacturer: "Toyota Motor Corporation", brand: "Toyota", country: "JP" },
  { wmi: "JTE", manufacturer: "Toyota Motor Corporation", brand: "Toyota", country: "JP" },
  { wmi: "JN1", manufacturer: "Nissan Motor Co.", brand: "Nissan", country: "JP" },
  { wmi: "JF1", manufacturer: "Subaru Corporation", brand: "Subaru", country: "JP" },
  { wmi: "KM8", manufacturer: "Hyundai Motor Company", brand: "Hyundai", country: "KR" },
  { wmi: "KMH", manufacturer: "Hyundai Motor Company", brand: "Hyundai", country: "KR" },
  { wmi: "KNA", manufacturer: "Kia Corporation", brand: "Kia", country: "KR" },
  { wmi: "KNE", manufacturer: "Kia Corporation", brand: "Kia", country: "KR" },
  { wmi: "LRW", manufacturer: "Tesla (Giga Shanghai)", brand: "Tesla", country: "CN" },
  // North America
  { wmi: "1HG", manufacturer: "Honda of America Mfg.", brand: "Honda", country: "US" },
  { wmi: "1FA", manufacturer: "Ford Motor Company", brand: "Ford", country: "US" },
  { wmi: "1FT", manufacturer: "Ford Motor Company", brand: "Ford", country: "US" },
  { wmi: "1G1", manufacturer: "General Motors", brand: "Chevrolet", country: "US" },
  { wmi: "1GC", manufacturer: "General Motors", brand: "Chevrolet", country: "US" },
  { wmi: "5YJ", manufacturer: "Tesla, Inc.", brand: "Tesla", country: "US" },
  { wmi: "7SA", manufacturer: "Tesla, Inc.", brand: "Tesla", country: "US" },
  { wmi: "2HG", manufacturer: "Honda Canada Inc.", brand: "Honda", country: "CA" },
  { wmi: "3VW", manufacturer: "Volkswagen de México", brand: "Volkswagen", country: "MX" },
  // South America
  { wmi: "9BW", manufacturer: "Volkswagen do Brasil", brand: "Volkswagen", country: "BR" },
];

const BY_WMI = new Map<string, WmiEntry>(ENTRIES.map((entry) => [entry.wmi, entry]));

/**
 * Look a WMI up. `undefined` means "this build does not know it" — callers must
 * report that instead of falling back to a guess (AGENTS 24).
 */
export function lookupWmi(wmi: string | undefined): WmiEntry | undefined {
  if (!wmi) return undefined;
  return BY_WMI.get(wmi.slice(0, 3).toUpperCase());
}

/** Every WMI this build knows, for diagnostics and for importers. */
export function knownWmis(): WmiEntry[] {
  return ENTRIES.map((entry) => ({ ...entry }));
}

/**
 * Geographic region of a VIN from its first character (ISO 3780 assignment).
 *
 * This is the one piece of VIN semantics that is standard for *all*
 * manufacturers, so it is safe to keep as reference data: A–H Africa, J–R Asia,
 * S–Z Europe, 1–5 North America, 6–7 Oceania, 8–9 South America.
 */
export function regionForVin(vin: string | undefined): string | undefined {
  const first = vin?.slice(0, 1).toUpperCase();
  if (!first) return undefined;
  if (first >= "A" && first <= "H") return "Africa";
  if (first >= "J" && first <= "R") return "Asia";
  if (first >= "S" && first <= "Z") return "Europe";
  if (first >= "1" && first <= "5") return "North America";
  if (first === "6" || first === "7") return "Oceania";
  if (first === "8" || first === "9") return "South America";
  return undefined;
}
