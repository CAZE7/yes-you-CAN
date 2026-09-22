# Konformanz-Register — Norm → Implementierung → Beleg → Lücke

> Stand: 2026-09-22 · gemessen am Commit, der diese Datei einführt.
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
| **ISO 21434 / UNECE R155** (Cybersecurity) | **teilweise** (seit ADR 0051) | **Umgesetzt:** Token-Tor vor allen 37 `/api/`-Routen (`apps/web/src/auth.ts`, `server.ts:handle()`), `httpOnly`/`SameSite=Strict`-Cookie, konstanter Vergleich, `strict-transport-security`, Zustand in der Startwarnung — 16 Tests, `auth.ts` 100/100/100/100. **Fehlt:** TARA-Bewertung, CSMS, Schwachstellenprozess, TLS-Option, Rate-Limit (CY-04) | Entwicklung (Rest) + CSO | Code-Teil erledigt, Prozess offen |
| **IEC 61508** | nicht anwendbar | Fahrzeugseitig gilt 26262; 61508 wäre nur für Industrieanlagen relevant | — | — |
| **MISRA** | nicht anwendbar | MISRA C/C++ — dieses Repository ist TypeScript. Das Äquivalent ist maschinell getornt: kein `any`, kein `@ts-ignore`, kein leeres `catch`, kein `process.exit` außerhalb des Einstiegs, keine Datei über 800 Zeilen — `tests/architecture/hygiene.test.ts` | — | — |
| **AUTOSAR** | nicht anwendbar | Kein AUTOSAR-Stack; die Plattform ist ein Diagnose-Werkzeug, keine Steuergeräte-Software | — | — |

## Was dieses Register *nicht* ist

Kein Zertifikat, keine Selbstauskunft gegenüber einem Auditor, keine Aussage über
Serientauglichkeit. Es ist die ehrliche Karte dessen, was ein Entwickler oder
Agent hier vorfindet — mit der Zusage, dass jede Zeile einen Anker hat oder als
Lücke dasteht.

**Zugehörig:** [ADR 0050](../adr/0050-standards-conformance-register.md),
[`README.md`](README.md) (Einstieg), AGENTS 34.21 (Messung vor Behauptung).
