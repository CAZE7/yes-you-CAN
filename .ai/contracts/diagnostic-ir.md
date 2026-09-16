# Vertrag: Diagnostic IR

**Verbindliche Quellen:** `packages/diagnostic-ir/README.md` (v. a.
„Does NOT do“), [`../docs/api/diagnostic-ir.md`](../docs/api/diagnostic-ir.md),
ADR 0033/0034/0037/0038, [`../architecture/architecture.yaml`](../architecture/architecture.yaml)
(`@vdp/diagnostic-ir`, `@vdp/core`, `@vdp/reports`, `@vdp/ai`).

## Die Regeln, die du nicht brechen darfst

1. **Jede Observation trägt `evidence`** — `proven` (mit `Provenance`:
   origin/at/ecuId/serviceId/raw/definitionVersion) oder `unproven` (mit
   Grund). `unproven` ist ein Befund, kein Warning (ADR 0033).
2. **Kein I/O, kein Protokoll, kein Transport, keine `node:`-Builtins** —
   `mayImport` bleibt `["@vdp/shared"]` (maschinell).
3. **Observation ≠ Enrichment:** `DtcObservation` (Fahrzeug) und
   `DtcEnrichment` (unser Wissen) tragen eigene Evidence; ein Report muss
   „die ECU meldete P0420, unsere Basis kennt ihn nicht“ sagen können
   (ADR 0037).
4. **Evidenz wird im Core gebaut** (`collectEvidence`,
   `session/observation.ts`) — dieses Paket trägt nur die *Formen*;
   UI/Report/AI zitieren, sie sammeln nicht (ADR 0038).
5. **Item-Ids sind Schlüssel** (`dtc:P0420@ecu-engine`) — stabil je
   Session, nie als Antwort-Text gerendert.
6. **Kein Reparatur-Wort:** „repair“ ist bewusst kein IR-Begriff (diese
   Schicht schlägt nichts zum Tun vor).

## Wenn du eine neue Observation-Form baust

1. Neues Modul in `packages/diagnostic-ir/src/` + Export in `src/index.ts`.
2. Erzeugung im Core (`session/observation.ts` o. Ä.) mit `proven(...)`.
3. ADR im neuen Template (Affected/Forbidden/Tests/AI notes, ADR 0043).
4. `docs/glossary.md` ergänzen (neuer Begriff = neue Zeile).
5. Beispiele in `tests/examples/` aktualisieren, wenn die Form Teil der
   vier Standard-Pfade wird.
