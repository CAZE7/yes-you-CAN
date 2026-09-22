# Traceability — Anforderung → Code → Test → Vektor

> **Status: Entwurf, gepflegt seit ADR 0053.** Diese Datei ist die Rückverfolgbarkeit,
> die ISO 26262-4 §6 und ASPICE SWE.2 verlangen: von der Anforderung zum Test. Sie
> ist nicht vollständig — sie zeigt das Muster, nach dem weitere Zeilen hinzukommen
> müssen. Eine Anforderung ohne Test ist eine Behauptung; ein Test ohne Anforderung
> ist Dekoration.

## Methode

Jede Zeile: ID → Beschreibung → Code (Datei:Zeile) → Test (Datei) → Vektor (falls
vorhanden) → Status. **Beleg** heißt: die Datei existiert und der Test ist grün.

## Sicherheitsziele (aus `iso-26262-safety-concept.md`)

| ID | Beschreibung | Code | Test | Vektor | Status |
|---|---|---|---|---|---|
| SG-1 | Schreiboperation nur nach expliziter Freigabe mit gültigem Permit | `packages/core/src/writes/write-port.ts` (`precheck`/`run`), `domain/src/risk.ts` (`SafetyManager`) | `write-port.spec.ts`, `safety-manager.spec.ts` | `vectors/safety.json` 44/44 | **Implementiert** |
| SG-2 | Fehlerspeicher wird nicht geleert ohne Vorbedingungsprüfung | `core/src/dtc/dtc-access.ts` (`precheckDtcClear`), `runtime/src/dtc-service.ts` | `dtc-access.spec.ts`, `engine-collaborators.spec.ts` | — | **Implementiert** |
| SG-3 | Diagnoseergebnis nennt Geltungsbereich (welche Module geantwortet haben) | `core/src/diagnostics/dtc-access.ts` (`DtcScanReport.unread`), `runtime/src/mappers.ts` | `engine-collaborators.spec.ts` (dropRate 1 → `unread` voll), `backend-paths.spec.ts`, `ports.spec.ts` (5 Events mit `unreadCount`) | — | **Implementiert** (ADR 0049) |
| SG-4 | Workbench nicht ohne Authentifizierung aus Netz erreichbar | `apps/web/src/auth.ts` (Token-Tor), `server.ts` (`handle()`), `rate-limit.ts`, TLS `--cert`/`--key` | `auth.spec.ts` 16 Tests (Biss: Tor aus → 2 rot), `rate-limit.spec.ts` 12, `tls.spec.ts` 3 | — | **Implementiert** (ADR 0051+0054) |

## Cybersecurity-Ziele (aus `iso-21434-cybersecurity.md`)

| ID | Beschreibung | Code | Test | Status |
|---|---|---|---|---|
| CY-01 | Kein unautorisierter Lesezugriff | `auth.ts` + `server.ts` Tor | `auth.spec.ts` (401 mit Satz) | **Implementiert** |
| CY-02 | Keine unautorisierte Schreiboperation | `auth.ts` Tor + `WritePort` Permit | `auth.spec.ts` (`POST /api/dtc/clear` → 401) | **Implementiert** |
| CY-03 | Sitzungs-Manipulation fällt auf | `session-logger.ts` `rawTraceManifest` SHA-256 | `protocol/*` golden verifiziert | **Implementiert** |
| CY-04 | Kein DoS über SSE/Polling | `rate-limit.ts` 100/60s + 10 SSE/IP → 429 | `rate-limit.spec.ts` 12, live 429 | **Implementiert** (ADR 0054) |
| CY-05 | Kein Abhören | `server.ts` TLS-Option + `static-assets.ts` HSTS | `tls.spec.ts` 3, HSTS-Header in jedem Response | **Implementiert** (ADR 0054) |
| CY-06 | Kein Pfad-Durchgriff | `paths.ts` Segment-Vergleich | `static-assets.spec.ts` 7 | **Implementiert** |

## Kommunikationsnormen (aus `conformance.md`)

| Norm | Code | Test | Vektor | Status |
|---|---|---|---|---|
| ISO 14229-1 (UDS Dienste/NRC) | `protocols/uds/src/client.ts` (16 Dienste), `nrc.ts` (41 Codes), `dtc.ts` (24 Felder) | `client.spec.ts`, `dtc.spec.ts` | — | Implementiert |
| ISO 15765-2 (ISO-TP) | `transport/iso-tp/src/connection.ts` | `connection.spec.ts` | `isotp.json` 28/28 | Implementiert |
| ISO 13400-2 (DoIP) | `transport/doip/src/message.ts` (17 Typen) | `doip.spec.ts` | — | Implementiert |
| ISO 11898-1 (CAN) | `transport/can/src/frame.ts` | `frame.spec.ts` | — | Implementiert |
| Write-Safety | `core/src/writes/` | `write-*.spec.ts` | `safety.json` 44/44 | Implementiert |

## Betrieb und Werkzeuge

| Was | Code | Test | Status |
|---|---|---|---|
| Goldene Sitzungen reproduzierbar | `simulators/src/virtual-vehicle.ts` (`clock`), `golden-sessions/src/record.ts` | `virtual-vehicle-clock.spec.ts` 3 (Biss: 2 rot ohne Fix), `replay` 17, `golden-sessions` 42 | Implementiert (ADR 0052) |
| Deps gepflegt | `package.json` | `npm audit` 0, `npm outdated` 1 bewusst offen | Gepflegt |
| Hardware-Grenze | `tests/hardware/vcan.test.ts` | Skippt ohne vcan0 | Dokumentiert |

## Pflege

- Neue Anforderung → neue Zeile **im selben PR** (AGENTS 34.24).
- Jede Zeile braucht Code + Test. Ohne Test ist die Anforderung nicht belegt.
- Vektoren, wo vorhanden (ISO-TP, Write-Safety), zusätzlich nennen.
- Diese Datei altert: wenn eine Datei verschoben wird, ist der Beleg falsch.
  Lieber Zeile löschen als falschen Anker stehen lassen.

**Zugehörig:** `conformance.md`, `iso-26262-safety-concept.md`, `hara-template.md`,
`iso-21434-cybersecurity.md`, `csms.md`, ADR 0050–0054.
