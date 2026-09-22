# HARA — Gefährdungsanalyse und Risikobewertung

> **Status: Entwurf mit Bewertung (2026-09-22).** S/E/C/ASIL sind als **Entwurf**
> ausgefüllt — begründet, aber **nicht abgenommen**. ISO 26262-3 §6 verlangt eine
> benannte Person für die Einstufung; dieser Entwurf ist die Vorlage für das Review,
> nicht das Review selbst. Was sich messen lässt (Ursache im Code, bestehende
> Gegenmaßnahmen) ist belegt; die Einstufung trägt eine Begründung, damit das Review
> sie prüfen kann.
>
> Zugehörig: [`iso-26262-safety-concept.md`](iso-26262-safety-concept.md),
> [`conformance.md`](conformance.md), ADR 0050/0051/0054.

## Methode

`ASIL = f(S, E, C)` nach ISO 26262-3 Tabelle 4. Skalen: S0–S3, E0–E4, C0–C3.
Für ein **Diagnose-Werkzeug** (nicht im Fahrzeug verbaut, Einsatz im Stand in der
Werkstatt) ist die Exposition grundsätzlich niedriger als für eine im Fahrzeug
verbaute Funktion — die Gefährdung entsteht nur, wenn das Werkzeug am Fahrzeug
angeschlossen ist und bedient wird.

## Gefährdungen

### HARA-01 — Ungewollte Schreiboperation erreicht ein Steuergerät

| Feld | Inhalt |
|---|---|
| **Gefährdung** | Eine Codierung oder Adaptation wird an ein Steuergerät geschrieben, ohne dass die Bedienperson sie auslösen wollte |
| **Ursache im System** | HTTP-Route ohne Authentifizierung → `runtime.writes.run()`; ein zweiter Tab, ein Skript oder ein Angreifer im Netz kann denselben Pfad nehmen |
| **Bestehende Gegenmaßnahmen** | **Token-Tor vor jeder `/api/`-Route** (ADR 0051 — gemessen: `POST /api/dtc/clear` ohne Token → 401); `WritePort.precheck()` vor `run()`; Permit mit Ablauf; Stufenfolge-Prüfung; **44 formale Write-Safety-Vektoren** (`npm run formal:conform` → 44/44); `SafetyManager`-Policy je Operation; **Rate-Limit** (ADR 0054, 100/60s, 429); **TLS-Option** (`--cert`/`--key`) |
| **Restrisiko** | Ohne konfiguriertes Token bleibt die API offen (Prüfstand-Fall, in der Startwarnung benannt); ein Token ist Besitz, nicht Identität — wer es hat, ist nicht unterscheidbar |
| S / E / C | **S2 / E2 / C2** — S2: Fehlcodierung kann Fahrverhalten ändern (z. B. falsche Codierung des BCM), aber im Stand, nicht während der Fahrt; E2: nur während Diagnose-Sitzung am stehenden Fahrzeug, nicht im Normalbetrieb; C2: Bedienperson kann vor dem Schreiben prüfen (`precheck`), aber ein entfernter Angreifer im Netz ist schwer beherrschbar |
| **ASIL** | **QM (Entwurf)** — S2+E2+C2 nach Tabelle 4 → QM. Begründung: Werkstatt-Szenario, stehendes Fahrzeug, zusätzliche Hürden (Token, Permit, Precheck). **Review erforderlich.** |
| **Maßnahme** | **Umgesetzt** in ADR 0051 (Token-Tor) + ADR 0054 (TLS, Rate-Limit); offen bleibt die formale Abnahme |

### HARA-02 — Fehlerspeicher wird geleert, obwohl die Vorbedingungen nicht geprüft sind

| Feld | Inhalt |
|---|---|
| **Gefährdung** | `clearDtcs` löscht Codes, bevor die Prüfung des Steuergeräts gelaufen ist; die Diagnose-Information ist weg |
| **Ursache im System** | Löschpfad ohne Vorbedingungsprüfung; ein Timeout, der als Erfolg gewertet wird |
| **Bestehende Gegenmaßnahmen** | Löschpfad führt über den `WritePort` (`packages/core/src/dtc/`), Vorbedingung `precheckDtcClear`; eine abgeschnittene Antwort ist ein Fehler und kein leerer Speicher (ADR 0039, `ProtocolError` in `parseDtcList`); Token-Tor schützt vor unautorisiertem Löschen |
| S / E / C | **S1 / E3 / C1** — S1: Verlust von Diagnose-Info, keine direkte Gefährdung; E3: jede Diagnose-Sitzung liest/löscht DTCs; C1: einfach beherrschbar (erneut auslesen, Log prüfen) |
| **ASIL** | **QM (Entwurf)** — S1+E3+C1 → QM |
| **Maßnahme** | Rückverfolgbarkeit HARA-02 → Test → Vektor herstellen (Traceability-Matrix in `docs/standards/traceability.md`) |

### HARA-03 — Diagnoseergebnis wird als vollständig gelesen, obwohl Steuergeräte nicht geantwortet haben

| Feld | Inhalt |
|---|---|
| **Gefährdung** | Bedienperson liest „keine Fehler" und schließt ein Steuergerät aus, das nie geantwortet hat — falsche Reparatur-Entscheidung |
| **Ursache im System** | `scanAll` ließ ausgefallene Steuergeräte aus der Ergebnisliste weg; der Server hatte keinen Log-Sink |
| **Bestehende Gegenmaßnahmen** | **Umgesetzt (ADR 0049):** `DtcScanReport.unread`, Pflichtfeld `unreadCount`, Anzeige `#dtc-unread`, `createServerLogger()`. Biss gemessen: Sammlung entfernt → Tests rot |
| S / E / C | **S1 / E4 / C2** — S1: falsche Reparatur-Entscheidung, aber kein direkter Eingriff; E4: jeder Scan, bei dem ein Modul nicht antwortet; C2: Bedienperson kann `unread` sehen, aber muss es beachten |
| **ASIL** | **QM (Entwurf)** — S1+E4+C2 → QM. Sicherheitsziel SG-3 trägt, Umsetzung vorhanden |
| **Maßnahme** | Als Sicherheitsziel SG-3 in die Anforderungsliste aufgenommen — erledigt |

### HARA-04 — Schreiboperation während der Fahrt

| Feld | Inhalt |
|---|---|
| **Gefährdung** | Codierung/Adaptation trifft ein Steuergerät, während das Fahrzeug bewegt wird |
| **Ursache im System** | Die Plattform kennt keine Fahrgeschwindigkeit als Schreib-Vorbedingung; die Annahme „Fahrzeug steht" ist nirgends erzwungen |
| **Bestehende Gegenmaßnahmen** | **Teilweise:** `SafetyManager` prüft `stationary` als Vorbedingung (aus `vehicleState`), aber keine automatische Erkennung über Geschwindigkeit; Doku-Annahme in Sicherheitskonzept §1; Token-Tor verhindert entfernte Auslösung während der Fahrt |
| S / E / C | **S3 / E1 / C3** — S3: Schreiben während der Fahrt kann Fahrverhalten ändern, worst-case; E1: sehr geringe Exposition — Annahme „Fahrzeug steht" + Werkstatt-Kontext, aber nicht erzwungen; C3: während der Fahrt schwer beherrschbar |
| **ASIL** | **A (Entwurf)** — S3+E1+C3 → QM oder A je nach Interpretation; konservativ A gewählt, weil E1 unsicher ist. **Review erforderlich**, und Maßnahme (Geschwindigkeit als Vorbedingung) empfohlen |
| **Maßnahme** | Geschwindigkeit als Vorbedingung in `SafetyManager`-Policy aufnehmen — offen, Aufwand mittel |

### HARA-05 — Unautorisierter Netzzugriff auf die Workbench

| Feld | Inhalt |
|---|---|
| **Gefährdung** | Jede Person im selben Netz liest Fahrzeugdaten und löst Schreiboperationen aus |
| **Ursache im System** | `--host=0.0.0.0` bindet alle Schnittstellen; ohne Token offene API |
| **Bestehende Gegenmaßnahmen** | **Token-Tor** (ADR 0051) mit `httpOnly; SameSite=Strict`-Cookie und konstantem Vergleich; **TLS-Option** (ADR 0054, `--cert`/`--key`, `VDP_TLS_CERT`/`VDP_TLS_KEY`); **Rate-Limit** (ADR 0054, 100 Req/60s, 10 SSE/IP, 429); `strict-transport-security` gesetzt; `WARN`-Zeile beim Start, die den Zustand nennt (`authenticated: true|false`, `tls: true|false`); Sicherheits-Header (CSP `frame-ancestors 'none'`, `x-frame-options: DENY`, etc.) |
| **Lücke messbar** | Ohne konfiguriertes Token offene API (Prüfstand-Fall, benannt); ohne TLS-Zertifikat kein Schutz gegen Abhören, aber HSTS gesetzt |
| S / E / C | **S2 / E2 / C2** — wie HARA-01, da gleiche Angriffsfläche für Schreiben |
| **ASIL** | **QM (Entwurf)** — S2+E2+C2 → QM, mit TLS und Token als zusätzliche Hürden |
| **Maßnahme** | **Umgesetzt** in ADR 0051+0054; Bewertung im Review bestätigen |

## Auswertung (Entwurf)

| ID | S | E | C | ASIL (Entwurf) | Status |
|---|---|---|---|---|---|
| HARA-01 | S2 | E2 | C2 | QM | Token+Permit+RateLimit+TLS vorhanden, Abnahme offen |
| HARA-02 | S1 | E3 | C1 | QM | Precheck vorhanden, Traceability offen |
| HARA-03 | S1 | E4 | C2 | QM | **Erledigt** (ADR 0049) |
| HARA-04 | S3 | E1 | C3 | **A** | Maßnahme empfohlen (Geschwindigkeit als Vorbedingung) |
| HARA-05 | S2 | E2 | C2 | QM | Token+TLS+RateLimit vorhanden, Abnahme offen |

**Nächster Schritt:** Review mit benannter Person (Safety Manager), die S/E/C
bestätigt und ASIL freigibt. Bis dahin ist alles Entwurf — aber ein Entwurf mit
Begründung, nicht ein leeres Feld.
