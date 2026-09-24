# Flow: Die Open/Closed-Grenze (was hinüber darf — und was nie)

> Konzept: [`docs/architecture/open-core-dual-licensing.md`](../architecture/open-core-dual-licensing.md)
> (Entwurf) · umgesetzt und gemessen: ADR [0059](../adr/0059-contracts-are-frozen-and-measured.md),
> ADR [0060](../adr/0060-third-party-licences-are-checked.md) ·
> Verträge: `architecture/architecture.yaml` (`contracts`),
> Record: [`architecture/public-api.json`](../../architecture/public-api.json)

Dieser Text beschreibt **nicht** das Konzept — das steht im Entwurf. Er beschreibt den
*gebauten* Zustand: welche Flächen es gibt, was über sie laufen darf, und welches Gate
jede Zusage hält. Jede Zeile ist heute im Baum messbar (`npm run ci`).

## 1. Die Grenze als Bild

```text
                    ┌──────────── offener Kern (MIT, dieses Repo) ─────────────┐
                    │  web · runtime · application · core · storage           │
                    │  adapters/* · transport/* · protocols/uds · tools/*     │
                    └───────────────▲──────────────────────────▲──────────────┘
                                    │                          │
                       Verträge (ADR 0059)              geschlossener Teil
                                    │                    (@vdp/enterprise-*, private)
   ┌────────────────────────────────┴──────────────────────────────────────────┐
   │ @vdp/diagnostic-ir   Belege + Hypothesen (was ein Ergebnis ist)           │
   │ @vdp/domain          Ports + Capabilities (wie man fragt)                 │
   │ @vdp/definitions     Schema + Provenance + Validator (was Daten sind)     │
   │ @vdp/protocols-oem   OemProtocol (Hersteller-Hook, importiert nichts)     │
   │ @vdp/ai              AnalysisProvider + AnalysisInput/Result              │
   │ @vdp/core            logging/integrity (IntegrityPort, Manifest, Signatur)│
   │ @vdp/protocols-uds   security (SeedKeyAlgorithm + verweigernder Default)  │
   └───────────────────────────────────────────────────────────────────────────┘
```

Sieben Flächen, jede mit `why` und einem Eintrag in `docs/api/`. Der Record friert sie
ein: **7 Verträge, 49 Flächen-Dateien, 5 externe Typquellen** — gemessen
(`npm run check:api`).

### Die Seiten je Naht

| Vertrag | Was er verspricht | Seite |
|---|---|---|
| `@vdp/diagnostic-ir` | Belege, Hypothesen, Beobachtungen (die Form eines Ergebnisses) | [`docs/api/diagnostic-ir.md`](../api/diagnostic-ir.md) |
| `@vdp/domain` | Ports, Projektionen, Capabilities, Risk-Policy (die Sprache) | [`docs/api/domain-ports.md`](../api/domain-ports.md) |
| `@vdp/definitions` | Schema, Provenance-Pflicht, Validator, Migration (die Daten) | [`docs/api/definitions-schema.md`](../api/definitions-schema.md) |
| `@vdp/protocols-oem` | `OemProtocol` + Registry (Hersteller-Hook ohne Importe) | [`docs/api/oem-protocol.md`](../api/oem-protocol.md) |
| `@vdp/ai` | `AnalysisProvider`, `AnalysisInput`, `AnalysisResult` (die Analyse) | [`docs/api/ai-provider.md`](../api/ai-provider.md) |
| `@vdp/core` | `logging/integrity`: `IntegrityPort`, Manifest, Signatur (die Integrität) | [`docs/api/integrity-port.md`](../api/integrity-port.md) |
| `@vdp/protocols-uds` | `security`: `SeedKeyAlgorithm` + verweigernder Default (der Zugang) | [`docs/api/seed-key.md`](../api/seed-key.md) |

`tests/architecture/docs.test.ts` hält beides: jedes `docs` in der YAML existiert und nennt
den Vertrag, jede Seite ist von hier aus verlinkt, und kein relativer Link im Repo zeigt
ins Leere.

## 2. Was über die Grenze darf

1. **Belege statt Rohdaten.** Ein geschlossener Provider bekommt `AnalysisInput` —
   Statistik-Zusammenfassungen, DTCs mit Provenance, ein `EvidenceSet`. Keine Rohproben,
   kein VIN ohne Zustimmung (`docs/api/ai-provider.md`).
2. **Fakten in Vertragsform.** `DefinitionPackage`, `DtcObservation`, `EcuSummary`,
   `MeasurementReading` (ADR 0004: `raw` bleibt `raw`) — nie eine interne Struktur.
3. **Die Registrierung, nicht das Geheimnis.** `SeedKeyAlgorithm` wird angemeldet; der
   Schlüssel selbst lebt im Closed-Modul (oder im HSM).
4. **Ein Ergebnis mit Herkunft.** Jede Antwort trägt Versionen und Zitate; ein
   geschlossenes Modul, das keine Provenance liefern kann, hat keinen Platz in der Kette.

## 3. Was nie hinüber darf (die Autoritäts-Regel)

- **Kein Schreibpfad.** Ein Closed-Modul bekommt keinen `WritePort`, keinen Bus, kein
  Steuergerät. Jeder Write läuft durch `WritePort` + `SafetyManager` (AGENTS 26/32/34.12)
  — offen, damit die Safety-Zusage prüfbar bleibt. Der Guardrail, dass `@vdp/ai` nur
  `@vdp/shared` + `@vdp/diagnostic-ir` erreicht, gilt für Closed-Module **unverändert**
  (`tests/architecture/guardrails.test.ts`).
- **Keine zweite Wahrheit.** Kein Closed-Modul parst die kanonische Signaturbindung nach,
  keines baut Evidenz neu (`collectEvidence` ist die eine Stelle, ADR 0038).
- **Keine unlizenzierten Daten** — weder hinein noch hinaus (AGENTS 24). Ein Wissensteil
  ist ein Lizenzvertrag, kein Datenverzeichnis.
- **Kein Vertrag „nachziehen“, damit ein Closed-Modul passt.** Die Vertragsänderung ist
  eine Entscheidung mit Version und Migrationshinweis; das Modul zieht nach.
- **Nichts zurücknehmen, was schon veröffentlicht war.** Die Grenze wächst nur in eine
  Richtung (Konzept §4.7).

## 4. Welches Gate was hält

| Zusage | Gate | Was „beißen“ heißt |
|---|---|---|
| Die Fläche ändert sich nicht unbemerkt | `npm run check:api` nach `npm run build` | `contract-drift` nennt die Datei (`~ dist/src/config.d.ts`); `--update` schreibt nur, wenn die Konfiguration gesund ist |
| Ein Subpfad ist Teil der Fläche | dito (`entries`) | `@vdp/definitions` wird über fünf Typ-Einstiegspunkte gemessen |
| Der Importgraph erlaubt nur die vorgesehenen Kanten | `npm run check:deps` | verbotene Kante = FAIL; eine Regel ohne Treffer = `blind-prefix` |
| Ein veröffentlichbares Paket hängt nie an einem privaten | `npm run check:manifests` | `private-dependency-leak` |
| Fremdcode unter verbotener/undeklarierter Lizenz | `npm run check:licenses` | `forbidden-license`, `unknown-license`, abgelaufene Ausnahme |
| Closed-Module erreichen keine Autorität | `tests/architecture/guardrails.test.ts` | erreichbarer Schreibpfad = FAIL |
| Jede Naht hat einen Doku-Eintrag | `tests/architecture/docs.test.ts` | fehlender/veralteter Eintrag oder toter Link = FAIL |

## 5. Was heute *nicht* existiert (ehrlich)

- **Kein `@vdp/enterprise-*`-Paket.** Die Kantenregel „nur `@vdp/runtime` und `@vdp/web`
  dürfen Enterprise importieren“ ist deshalb noch nicht in der YAML: eine Regel ohne
  Treffer wäre selbst ein Verstoß (`blind-prefix`). Sie kommt **mit** dem ersten Paket, in
  denselben PR.
- **Kein `EntitlementPort`, keine Lizenzprüfung, keine native Härtung.** Solange es keinen
  geschlossenen Code gibt, schützt nichts einen — und ein Schutz ohne Gegenstand wäre eine
  Behauptung (Konzept Phase 4/6).
- **Die Vertragsversion ist heute der Release-Stand** (`0.1.0`, Lockstep im Workspace).
  Ob Verträge nach der ersten Veröffentlichung einen eigenen Stand bekommen, ist offene
  Entscheidung E3/E6 des Konzepts — bis dahin ist `version-drift` ein Hilfsmittel, keine
  Versionszusage.

**Zugehörig:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md#3-die-harten-verträge-maschinell-geprüft),
[`docs/api/ai-provider.md`](../api/ai-provider.md), [`docs/api/integrity-port.md`](../api/integrity-port.md),
[`docs/api/seed-key.md`](../api/seed-key.md), [`docs/api/domain-ports.md`](../api/domain-ports.md),
[`docs/api/definitions-schema.md`](../api/definitions-schema.md),
[`docs/api/oem-protocol.md`](../api/oem-protocol.md), ADR
[0060](../adr/0060-third-party-licences-are-checked.md).
