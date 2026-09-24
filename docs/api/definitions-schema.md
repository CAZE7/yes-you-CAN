# Public API: `@vdp/definitions` — das Datenkontrakt für Definitionen

> Paket: [`packages/definitions/`](../../packages/definitions/README.md) ·
> Layer: **contract** (importiert nur `@vdp/shared`) ·
> ADRs: [0003](../adr/0003-definition-packages.md), [0023](../adr/0023-vehicle-resolution.md),
> [0024](../adr/0024-dtc-knowledge-per-variant.md), [0058](../adr/0058-harvest-as-observation.md) ·
> Vertrag im Record: `@vdp/definitions` — **fünf Typ-Einstiegspunkte** (`.`, `./generic`,
> `./vag`, `./mercedes`, `./simulator`)

Dieses Paket ist die Trennlinie zwischen *Software* und *Daten*. Ein Closed-Teil verkauft
in der Praxis selten Code allein, sondern Wissen (DTC-Semantik, Prüfschritte,
Signalauslegung) — und dieses Wissen hat hier ein **Schema**, einen **Validator** und eine
**Provenance-Pflicht**. Der Vertrag ist deshalb nicht „irgendein JSON“, sondern die Form,
die ein Paket erfüllen muss, egal wer es geschrieben oder lizenziert hat.

## Was hier Vertrag ist

**1. Das Schema.** `CURRENT_SCHEMA_VERSION`, `SUPPORTED_SCHEMA_VERSIONS`, `DefinitionPackage`,
`VehicleDefinition`, `EcuDefinition`, `SignalDefinition`, `DtcDefinition`,
`FreezeFrameField`, `EngineDefinition`, `GearboxDefinition`, `VinMatcher`,
`VehicleEcuRef`, `MeasurementCheckDefinition`, `FailurePatternDefinition`,
`DtcKnowledgeDefinition`. Eine Fremdlieferung, die diesen Typen nicht gehorcht, ist kein
Definitionspaket.

**2. Provenance ist Pflicht.** `Provenance` mit `PROVENANCE_SOURCE_TYPES`
(`own`, `standard`, `licensed`, `community`, `observed`, …) und der Regel: **`observed`
ohne `retrievedAt` ist eine Warnung, `observed` mit `license` ist eine Warnung**
(„gemessen, nicht lizenziert“, AGENTS 24/30). Herstellerdaten ohne Rechte sind kein
Datenbestand, sondern ein Haftungsfall — deshalb ist `sourceType` Teil des Schemas und
nicht ein Kommentar.

**3. Prüfen und Migrieren.** `validateDefinitionPackage(pkg) → ValidationResult`,
`assertValidPackage`, `isSupportedSchemaVersion`, `needsUpgrade`, `upgradePackage`.
Ein Paket aus einer älteren Schemaversion wird **gehoben**, nicht stillschweigend falsch
gelesen.

**4. Parsen ist ein Tor.** `parseDefinitionPackage(source)`,
`parseDefinitionPackageJson(json)` — die einzigen Wege, aus ungeprüftem JSON ein
`DefinitionPackage` zu machen. Ein `as DefinitionPackage`-Cast auf Fremddaten ist genau
die Abkürzung, die ein Validator verhindern soll (ADR 0041: Casts in interne Strukturen
sind keine).

**5. Auflösen und indexieren.** `VehicleResolver`, `VehicleResolution`,
`VehicleCandidate`, `VehicleResolutionInput`, `IdentificationFact`,
`EcuCoverage`, `VinLookup`, `indexPackage`, `indexEcus`, `indexVehicles`,
`ecusOfVehicle`, `keyOf`. Eine Auflösung, die ohne solche Fakten auskommt, rät.

**6. Wissen je Code.** `findDtcKnowledge(packages, query)`, `DtcKnowledgeHit`,
`DtcKnowledgeScope`, `documentedDtcCodes`, `dtcKnowledgeQuery` — „was dokumentiert ein
Paket zu diesem Code“ ist eine Abfrage, keine Suche im Text.

**7. Die ausgelieferten Pakete sind Beispiele.** `genericPackage`, `vagExamplePackage`,
`mercedesExamplePackage`, `simulatorPackage`, `highFidelityPackage`, `knownWmis`,
`SIMULATOR_VIN` — die OEM-Pakete sind `example-placeholder` und **nie** als Wahrheit
über ein reales Fahrzeug zu behandeln (README, AGENTS 24).

## Die Kanten (maschinell geprüft)

1. **Ein Subpfad ist Teil der Fläche.** Ein Konsument darf
   `import … from "@vdp/definitions/vag"` schreiben; der Record misst deshalb **alle fünf**
   Typ-Einstiegspunkte, nicht nur `index.d.ts` (ADR 0059).
2. **Das Paket kennt kein Protokoll und keinen Transport** — `mayImport` bleibt
   `["@vdp/shared"]` (`npm run check:deps`).
3. **Jedes Definition-Paket trägt Provenance** — `packages/definitions/src/*.spec.ts` und
   die Schema-Regeln; die goldenen Sitzungen pinnen die ausgelieferten Pakete.

## Häufige Fehler

- **Ein neues Feld ohne Migrationspfad** → `upgradePackage` fällt, oder schlimmer: alte
  Pakete werden falsch gelesen. Schemaänderung = `CURRENT_SCHEMA_VERSION` + Migration +
  Test.
- **`observed` als `standard` verkaufen.** Am Fahrzeug gemessen heißt nicht „nach Norm
  dokumentiert“ (`provenanceTrust("observed") = 0.9`) — die Verwechslung ist eine falsche
  Zusage (ADR 0058).
- **Zahlen ohne Einheit/Skalierung erfinden:** eine Länge ohne dokumentierte Kodierung
  wird kein Signal, sondern ein `skipped`-Eintrag.

**Zugehörig:** [`docs/api/domain-ports.md`](domain-ports.md) (`DefinitionProvider`), der
Flow [`docs/flows/open-core-boundary.md`](../flows/open-core-boundary.md) (wo Daten zu
Vertrag werden), `AGENTS 24` (keine unlizenzierten OEM-Daten).
