## Was ändert sich?

<!-- Kurz und konkret. Verlinke ADRs/Issues. -->

## Definition of Done (AGENTS 35)

- [ ] Implementierung + Error Handling
- [ ] Tests auf den passenden Ebenen (unit / integration / protocol / replay / regression, AGENTS 31)
- [ ] Strukturiertes Logging für neue Diagnoseoperationen (AGENTS 33)
- [ ] UI-Anbindung, falls relevant — keine CAN-/UDS-Logik in der UI (AGENTS 34.4)
- [ ] Doku aktualisiert; Architekturentscheidungen als ADR (AGENTS 34.15)

## Verifikation (AGENTS 34.21 — Messung vor Behauptung)

- [ ] `npm run build` grün
- [ ] `npx biome check .` grün
- [ ] `npm test` grün (Node 22 und 24 in CI)
- [ ] Bei Norm-Details: ISO-Referenz im Code-Kommentar (AGENTS 34.18)

## Leitplanken

- [ ] Roh und dekodiert bleiben getrennt (ADR 0004, AGENTS 34.7)
- [ ] Read-only vor Write; Schreiboperationen laufen über den SafetyManager (AGENTS 26, 34.11)
- [ ] Keine Secrets im Code (AGENTS 34.16), keine ungeklärten Fremddaten (AGENTS 24, 34.17)
- [ ] Neue Laufzeit-Abhängigkeiten nur gemäß ADR 0010 — mit Maintenance-Nachweis, Lizenz-Check (MIT/Apache-2.0/BSD) und regeneriertem Lockfile
- [ ] Security-Baseline unverändert (ADR 0009: localhost-Default, Security-Header, Body-Limit, GET-only Stream)
