# Task: Diagnose-Regel / -Logik hinzufügen

**Kontext:** „Neue Diagnose-Logik“ = eine Regel, die aus Beobachtungen
einen Befund macht (z. B. „Batterie unter 11 V → X“). Die Frage ist fast
immer: **welche Art** von Regel?

## Die vier Orte — und warum genau vier

| Art der Regel | Ort | Warum |
|---|---|---|
| **Dekodierung** (Bytes → Wert) | Definition-Paket (Daten) + `packages/core/src/measurements/decoder.ts` (Format) | Wissen ist Daten (ADR 0003); der Decoder ist die eine Stelle für das Format (ADR 0004) |
| **Fehlererkennung im Fahrzeug-Modell** (Simulator!) | `tools/simulators/src/vehicle-monitors.ts` + `vehicle-model.ts` | Monitore *latchen* Fehler im Modell (ADR 0040) — das ist die Simulator-Hälfte, nicht die Diagnose-Hälfte |
| **Beurteilung von Belegen** (Hypothese/Check) | `packages/definitions` (dokumentierter Check, Daten) + `packages/core/src/evidence/hypotheses.ts` (Bewertungs-Logik) | Die Regel ist dokumentiertes Wissen + veröffentlichte Heuristik (ADR 0038) |
| **Anomalie-Erkennung auf Messwerten** | `packages/runtime/src/signal-analysis-service.ts` | Analyse ist eine Service-Fähigkeit am Runtime, keine UI-Logik |

## Schritte

1. **Art festlegen** (Tabelle oben) — falscher Ort = Review-Defekt.
2. **Im richtigen Ort implementieren** — jede Zeile der Code-Map
   (`docs/code-map.md`) nennt die primäre Stelle.
3. **Belegkette prüfen:** die Regel darf nur auf Observations/Evidenz
   operieren, die einen Beleg tragen (ADR 0033) — „kein Wert“ und
   „nicht beobachtet“ sind unterschiedlich (IR: `SignalGap`).
4. **Keine doppelte Vokabel:** der Befund spricht IR-Wörter
   (`docs/glossary.md`) — kein neues „DiagnosticResult“.
5. **Test mit Symptombeschreibung** (Leitplanke 0.D): jeder gefundene
   Fehler wird ein Regressionstest.
6. **Doku im selben PR** (Regel 34.24): README des Pakets, Flow-Doku
   (falls der Pfad sichtbar wird), Glossar (neuer Begriff), ADR
   (architektonisch?).
7. **Tor:** `npm run check:deps && npm run check:manifests && npm test`.

## Stop-Signale

- Regel „schnell“ in `apps/web` oder `packages/reports` → falsch: UI/
  Reports konsumieren Befunde, sie erzeugen keine (außer: es ist eine
  reine Darstellung eines bestehenden Befunds).
- Regel liest `DiagnosticEngine`-Felder statt IR/Domain-Views →
  ADR 0014 (Public Surface).
- Regel „weiß“ etwas, das nicht im `EvidenceSet` steht → zweite Kopie
  der Belege (ADR 0038).
