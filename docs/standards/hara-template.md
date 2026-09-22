# HARA — Gefährdungsanalyse und Risikobewertung (Arbeitsblatt)

> **Status: Arbeitsblatt, nicht ausgefüllt.** Die Spalten `S` (Schwere), `E`
> (Exposition), `C` (Beherrschbarkeit) und `ASIL` sind **leer**, weil sie eine
> Einstufung durch eine Person verlangen, die dafür benannt ist (ISO 26262-3 §6).
> Ein Entwickler, der sie selbst ausfüllt, produziert eine Zahl ohne Geltung — das
> ist genau die Verwechslung, die AGENTS 34.21 im Kleinen verbietet.
>
> Ausgefüllt ist, was sich messen lässt: die Gefährdung, ihre Ursache im Code und was
> heute dagegen steht.

## Methode

`ASIL = f(S, E, C)` nach ISO 26262-3 Tabelle 4. Skalen: S0–S3, E0–E4, C0–C3.

## Gefährdungen

### HARA-01 — Ungewollte Schreiboperation erreicht ein Steuergerät

| Feld | Inhalt |
|---|---|
| **Gefährdung** | Eine Codierung oder Adaptation wird an ein Steuergerät geschrieben, ohne dass die Bedienperson sie auslösen wollte |
| **Ursache im System** | HTTP-Route ohne Authentifizierung → `runtime.writes.run()`; ein zweiter Tab, ein Skript oder ein Angreifer im Netz kann denselben Pfad nehmen |
| **Bestehende Gegenmaßnahmen** | **Token-Tor vor jeder `/api/`-Route** (ADR 0051 — gemessen: `POST /api/dtc/clear` ohne Token → 401); `WritePort.precheck()` vor `run()`; Permit mit Ablauf; Stufenfolge-Prüfung; **44 formale Write-Safety-Vektoren** (`npm run formal:conform` → 44/44); `SafetyManager`-Policy je Operation |
| **Restrisiko** | Ohne konfiguriertes Token bleibt die API offen (Prüfstand-Fall, in der Startwarnung benannt); ein Token ist Besitz, nicht Identität — wer es hat, ist nicht unterscheidbar |
| S / E / C | ___ / ___ / ___ |
| **ASIL** | **offen** |
| **Maßnahme** | **Umgesetzt** in ADR 0051 (Token-Tor); offen bleibt die Bewertung |

### HARA-02 — Fehlerspeicher wird geleert, obwohl die Vorbedingungen nicht geprüft sind

| Feld | Inhalt |
|---|---|
| **Gefährdung** | `clearDtcs` löscht Codes, bevor die Prüfung des Steuergeräts gelaufen ist; die Diagnose-Information ist weg |
| **Ursache im System** | Löschpfad ohne Vorbedingungsprüfung; ein Timeout, der als Erfolg gewertet wird |
| **Bestehende Gegenmaßnahmen** | Löschpfad führt über den `WritePort` (`packages/core/src/dtc/`), Vorbedingung `precheckDtcClear`; eine abgeschnittene Antwort ist ein Fehler und kein leerer Speicher (ADR 0039, `ProtocolError` in `parseDtcList`) |
| S / E / C | ___ / ___ / ___ |
| **ASIL** | **offen** |
| **Maßnahme** | Rückverfolgbarkeit HARA-02 → Test → Vektor herstellen |

### HARA-03 — Diagnoseergebnis wird als vollständig gelesen, obwohl Steuergeräte nicht geantwortet haben

| Feld | Inhalt |
|---|---|
| **Gefährdung** | Bedienperson liest „keine Fehler" und schließt ein Steuergerät aus, das nie geantwortet hat — falsche Reparatur-Entscheidung |
| **Ursache im System** | `scanAll` ließ ausgefallene Steuergeräte aus der Ergebnisliste weg; der Server hatte keinen Log-Sink |
| **Bestehende Gegenmaßnahmen** | **Umgesetzt (ADR 0049):** `DtcScanReport.unread`, Pflichtfeld `unreadCount`, Anzeige `#dtc-unread`, `createServerLogger()`. Biss gemessen: Sammlung entfernt → Tests rot |
| S / E / C | ___ / ___ / ___ |
| **ASIL** | **offen** |
| **Maßnahme** | Als Sicherheitsziel SG-3 in die Anforderungsliste aufnehmen |

### HARA-04 — Schreiboperation während der Fahrt

| Feld | Inhalt |
|---|---|
| **Gefährdung** | Codierung/Adaptation trifft ein Steuergerät, während das Fahrzeug bewegt wird |
| **Ursache im System** | Die Plattform kennt keine Fahrgeschwindigkeit als Schreib-Vorbedingung; die Annahme „Fahrzeug steht" ist nirgends erzwungen |
| **Bestehende Gegenmaßnahmen** | **keine im Code** — nur die Annahme im Sicherheitskonzept §1 |
| S / E / C | ___ / ___ / ___ |
| **ASIL** | **offen** |
| **Maßnahme** | Entweder Geschwindigkeit als Vorbedingung in `SafetyManager`-Policy, oder die Annahme aus dem Konzept streichen |

### HARA-05 — Unautorisierter Netzzugriff auf die Workbench

| Feld | Inhalt |
|---|---|
| **Gefährdung** | Jede Person im selben Netz liest Fahrzeugdaten und löst Schreiboperationen aus |
| **Ursache im System** | Keine Authentifizierung, keine TLS; `--host=0.0.0.0` bindet alle Schnittstellen |
| **Bestehende Gegenmaßnahmen** | **Token-Tor** (ADR 0051) mit `httpOnly; SameSite=Strict`-Cookie und konstantem Vergleich; `strict-transport-security` gesetzt; `WARN`-Zeile beim Start, die den Zustand nennt (`authenticated: true|false`); Sicherheits-Header (CSP mit `frame-ancestors 'none'`, `x-frame-options: DENY`, `cross-origin-resource-policy: same-origin`); `x-content-type-options: nosniff` |
| **Lücke messbar** | ohne TLS kein Schutz gegen Abhören (CY-05); ohne konfiguriertes Token offene API; kein Rate-Limit (CY-04) |
| S / E / C | ___ / ___ / ___ |
| **ASIL** | **offen** |
| **Maßnahme** | Token-Authentifizierung, HSTS, optional TLS — ISO 21434 |

## Auswertung

Offen, bis S/E/C gesetzt sind. Ohne ASIL gibt es keine Ableitung auf
Sicherheitsziele, und ohne Sicherheitsziele ist Abschnitt 2 des
Sicherheitskonzepts ein Entwurf — was dort auch so steht.
