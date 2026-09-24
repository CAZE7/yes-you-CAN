# Konformanz-Register — Norm → Implementierung → Beleg → Lücke

> Stand: 2026-09-23 · gemessen am Commit, der diese Datei einführt. Letzte Bewegung: ADR 0061/0062.
>
> **Leseregel:** Jede Zeile trägt einen **Beleg** (Datei, ggf. Zeile) oder das Wort
> **fehlt**. Eine Zeile ohne Beleg ist eine Behauptung, und Behauptungen stehen hier
> nicht. Was „implementiert" heißt, ist dabei eng gefasst: die Regel ist im Code
> umgesetzt *und* durch einen Test gepinnt. „Steht in einem Kommentar" ist kein
> Nachweis.
>
> **Wer diese Datei ändert:** zusammen mit der Änderung, die den Status bewegt
> (AGENTS 34.24 — Doku im selben PR). Eine Norm, deren Implementierung wächst, ohne
> dass diese Zeile wächst, ist eine Lücke, die niemand sieht.

## Kommunikations- und Diagnosenormen (produktseitig)

Diese Normen sind der Kern des Produkts. Status **implementiert** heißt: Regel im
Code + Test.

| Norm | Status | Beleg | Lücke |
|---|---|---|---|
| **ISO 14229-1** (UDS, Dienste/NRC) | implementiert | `packages/protocols/uds/src/client.ts` (16 Dienstemethoden), `nrc.ts` (**41 NRC-Codes**), `dtc.ts` (**24 Statusbyte-Felder**), `security.ts` | Kein vollständiger Dienstumfang eines Serien-Scans: 0x83/0x84/0x85/0x86/0x87 (Transfer) fehlen |
| **ISO 14229-2** (Session-Layer, P2/P2\*) | implementiert | `client.ts:153` (`p2Ms`/`p2StarMs` aus der Session-Antwort) | `S3`-Keepalive-Timer wird nicht automatisch gefahren — der Aufrufer hält die Session |
| **ISO 15765-2** (ISO-TP) | implementiert | `packages/transport/iso-tp/src/connection.ts`, `params.ts`; **28 formale Vektoren** in `tools/formal-conformance/vectors/isotp.json` | CAN-FD-Fluchtzeichen (SF_DL > 4095) als Pfad vorhanden, aber nicht gegen eine Referenzimplementierung verglichen |
| **ISO 15765-4** (OBD-IDs) | implementiert | OBD-Anfrage-IDs 0x7DF/0x7E0–0x7E7 im Simulator und in der Discovery | — |
| **ISO 13400-2** (DoIP) | implementiert | `packages/transport/doip/src/message.ts` (**17 Payload-Typen**), `discovery.ts`, `transport.ts` | TLS nach 13400-2 §7 nicht implementiert; DoIP-Aktivierungsprüfung gegen echten Tester fehlt |
| **ISO 11898-1** (CAN-Frame) | implementiert | `packages/transport/can/src/frame.ts` (`extended`, `fd`, `dlcToLength`) | CAN-FD mit > 64 Byte / BRS-Varianten nicht abgebildet |
| **ISO 14230** (KWP2000) | implementiert | `packages/protocols/kwp2000/src/services.ts` (**27 Dienste**), `client.ts` | 5-Baud-/FastInit-Initialisierung fehlt (nur logischer Dienstumfang) |
| **SAE J1979 / ISO 15031-5** (OBD-II) | implementiert | `packages/definitions/src/generic/generic-package.ts` (PID-Semantik, eigene Kodierung) | PID-Umfang ist der generische Satz, kein OEM-Ausbau |
| **SAE J2012** (DTC-Charakterform) | implementiert | `packages/definitions/src/schema.ts:273` (`"P0420"`), Dekodierung in `core/dtc` | — |

## Formale Absicherung

| Was | Status | Beleg | Lücke |
|---|---|---|---|
| ISO-TP-Konformanzvektoren | **28/28** | `npm run formal:conform`, `tools/formal-conformance/` | Referenzseite Haskell: `haskell NOT RUN` (keine GHC-Toolchain) — **nicht verifiziert** |
| Write-Safety-Vektoren | **44/44** | dito, `vectors/safety.json` | dito |
| Referenzmodelle in Haskell | syntaxgeprüft | `formal/*.hs` | Semantik nicht ausgeführt — ein Syntaxcheck ist kein Konformanzbeweis |
| Referenzmodelle in Rust | **nicht verifiziert** | `crates/yes_you_can_core` | Kein `cargo` in der Umgebung; 5 offene Befunde in AGENTS 0.E E25 |

## Prozess- und Sicherheitsnormen

Hier ist der ehrliche Befund: **keine dieser Normen ist implementiert**, und keine
lässt sich durch Code allein erfüllen. Sie verlangen einen Prozess, Rollen und
Abnahmen, die es in diesem Repository nicht gibt. Die Gerüste unter
[`iso-26262-safety-concept.md`](iso-26262-safety-concept.md),
[`hara-template.md`](hara-template.md) und
[`iso-21434-cybersecurity.md`](iso-21434-cybersecurity.md) sind der Anfang, nicht
der Nachweis.

| Norm | Status | Was fehlt | Wer | Aufwand |
|---|---|---|---|---|
| **ISO 26262** (Funktionale Sicherheit) | **fehlt** | Item-Definition, HARA, Sicherheitsziele mit ASIL, technische Sicherheitsanforderungen, Nachweis je Anforderung, Bestätigung review | Sicherheitsverantwortlicher + Abnahme durch OEM | Prozess, nicht PR |
| **ASPICE** (Prozessreifegrad) | **fehlt** | Basispraktiken je Prozessgebiet, Bidirektionale Rückverfolgbarkeit als *Pflege*regel, Assessment | Prozessorganisation | Assessment extern |
| **ISO 21434 / UNECE R155** (Cybersecurity) | **teilweise** (seit ADR 0051+0054) | **Umgesetzt:** Token-Tor (37 Routen, 16 Tests, 100% Coverage), Rate-Limit (100/60s + 10 SSE/IP → 429, 10 Tests), TLS-Option (`--cert`/`--key`, 3 Tests), HSTS + 5 Security-Header, Body-Limit 1 MB, Pfad-Eindämmung, SHA-256 Sitzungs-Integrität. **Entwurf vorhanden:** TARA-Bewertung (6 Gefährdungen mit Risiko), CSMS-Gerüst, SECURITY.md. **Fehlt:** Formale Abnahme durch CSO, Rollen, Reaktionszeiten (Organisation) | CSO (Abnahme) | Code-Teil erledigt, Prozess offen |
| **Lizenz und Rechte** (wer darf was mit diesem Code) | **teilweise umgesetzt** (seit ADR 0061/0062) | **Code-Teil:** `LICENSE` (vollständiger Apache-2.0-Text), `NOTICE`, `TRADEMARK.md` (Lizenz ≠ Marke, § 6), `"license"` in 30 Manifesten, CLA Fassung 1.0 in `docs/legal/cla.md` + Register `docs/legal/contributors.md`, geprüft von `tests/architecture/legal.test.ts` | **Prozess offen:** anwaltliche Prüfung des CLA (Fragenliste in `docs/architecture/open-core-phase-0-rights.md` §6), Signaturwerkzeug/Bot für Zustimmungen (0.E E28), Markenanmeldung. Registriert ist heute keine Fremdzustimmung, weil es keinen Fremdbeitrag gibt (gemessen: 1 Commit, 1 Autor). Je OEM-Datenpaket ist die Abgrenzung Software/Datenbank (Art. 61/63 VO (EU) 2018/858) eine eigene Entscheidung |
| **IEC 61508** | nicht anwendbar | Fahrzeugseitig gilt 26262; 61508 wäre nur für Industrieanlagen relevant | — | — |
| **MISRA** | nicht anwendbar | MISRA C/C++ — dieses Repository ist TypeScript. Das Äquivalent ist maschinell getornt: kein `any`, kein `@ts-ignore`, kein leeres `catch`, kein `process.exit` außerhalb des Einstiegs, keine Datei über 800 Zeilen — `tests/architecture/hygiene.test.ts` | — | — |
| **AUTOSAR** | nicht anwendbar | Kein AUTOSAR-Stack; die Plattform ist ein Diagnose-Werkzeug, keine Steuergeräte-Software | — | — |

## Betrieb und Werkzeuge

| Was | Status | Beleg | Lücke / Begründung |
|---|---|---|---|
| **Goldene Sitzungen** | **implementiert** (seit ADR 0052) | `tools/simulators/src/virtual-vehicle.ts` (`clock`), `tools/golden-sessions/src/record.ts` (50-ms-Phasen), `virtual-vehicle-clock.spec.ts` (3, Biss gemessen) — zwei Läufe auf demselben Baum: **0 Wertzeilen Drift** (vorher 44), 3472 Zeilen nur Zeitstempel | Zeitachse des Traces bleibt Wanduhr (1782× `timestamp`, 1690× `t`) — kein Defekt, ein Trace hält fest, *wann* etwas geschah |
| **Abhängigkeiten** | **gepflegt** | `package.json` / `package-lock.json`, `npm audit` **0** Schwachstellen, `npm outdated` **0** (Biome 2.5.14 seit ADR 0054), `biome check .` 486 Dateien grün (Biome 2.5.14) | — |
| **Lizenzen des Fremdcodes** | **gemessen** (seit ADR 0060) | `architecture/architecture.yaml` (`licenses`, zwei Geltungsbereiche), `npm run check:licenses` → `tests/architecture/licenses.test.ts`; Messung: 108 Drittpakete, **0 Produktion / 108 Entwicklung**, alle innerhalb der Richtlinie; MPL-2.0 (12× `lightningcss`) ist im Entwicklungsbereich erlaubt, nicht im Produktionsbereich | Kein SPDX-Report/Attribution-Bündel für eine Auslieferung — heute gibt es keine Produktionsabhängigkeiten (ADR 0002) |
| **Vertragsfläche (Open/Closed-Grenze)** | **gemessen** (seit ADR 0059) | `architecture/architecture.yaml` (`contracts`, 7 Flächen), `architecture/public-api.json` (49 Dateien, 5 externe Typquellen), `npm run check:api` nach `npm run build` → `tests/architecture/api.test.ts`; `private-dependency-leak` in `npm run check:manifests` | Der geschlossene Teil existiert noch nicht; die Grenze ist vorbereitet, nicht besiedelt |
| **Hardware-Tests** | **Grenze dokumentiert** | `tests/hardware/vcan.test.ts`, `socketcan-conformance.test.ts` — skippen deterministisch ohne `vcan0` (ADR 0016/0017) | Kein `vcan` in dieser Umgebung — `npm run test:hardware` meldet Skip, kein Fail; Grenze, keine Lücke |
| **Rate-Limit** | **implementiert** (seit ADR 0054) | `apps/web/src/rate-limit.ts` (100 Req/60s/IP + 10 SSE/IP → 429), `server.ts` `handle()` + `streamEvents()`, `rate-limit.spec.ts` 10 Tests (Biss: 100→429) | — |
| **TLS** | **implementiert** (seit ADR 0054) | `apps/web/src/server.ts` (`--cert`/`--key`, `VDP_TLS_CERT`/`VDP_TLS_KEY`, `https.createServer`), `tls.spec.ts` 3 Tests, HSTS `max-age=31536000` | Zertifikat nicht im Repo, nur Pfad — Inhalt nie committen |
| **Formale Werkzeuge** | **nicht verifiziert** | `command -v cargo ghc stack rustc` → keines vorhanden | `haskell NOT RUN` in `npm run formal:conform` ist ehrlich, nicht grün geredet (ADR 0045) |
| **CSMS** | **Gerüst vorhanden** (seit ADR 0054) | `docs/standards/csms.md` (Policy, TARA, Schwachstellen-Prozess, Nachweis), `SECURITY.md` (Meldeweg, unterstützte Versionen) | Rollen, Reaktionszeiten, Audit-Plan — Organisation, nicht Code |

## Was dieses Register *nicht* ist

Kein Zertifikat, keine Selbstauskunft gegenüber einem Auditor, keine Aussage über
Serientauglichkeit. Es ist die ehrliche Karte dessen, was ein Entwickler oder
Agent hier vorfindet — mit der Zusage, dass jede Zeile einen Anker hat oder als
Lücke dasteht.

**Zugehörig:** [ADR 0050](../adr/0050-standards-conformance-register.md),
[ADR 0051](../adr/0051-workbench-api-knows-its-caller.md),
[ADR 0052](../adr/0052-the-signal-model-clock-is-a-parameter.md),
[ADR 0053](../adr/0053-deps-hardware-and-tooling-boundary.md),
[ADR 0054](../adr/0054-tls-rate-limit-and-csms.md),
[`README.md`](README.md) (Einstieg), AGENTS 34.21 (Messung vor Behauptung).
