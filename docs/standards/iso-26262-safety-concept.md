# ISO 26262 — Sicherheitskonzept (Gerüst)

> **Status: Gerüst, kein Nachweis.** Diese Datei ist der *Anfang* eines
> Sicherheitskonzepts: die Struktur, die die Norm verlangt, ausgefüllt mit dem, was
> über dieses System messbar feststeht. Was fehlt, steht als Lücke darin und nicht
> als erledigte Zeile. Ein Auditor liest diese Datei als Beleg dafür, dass niemand
> einen Nachweis vortäuscht — nicht als Nachweis.
>
> Zugehörig: [`conformance.md`](conformance.md) (Register),
> [`hara-template.md`](hara-template.md) (Arbeitsblatt),
> [ADR 0050](../adr/0050-standards-conformance-register.md).

## 1. Item-Definition (26262-3 §5)

| Feld | Inhalt |
|---|---|
| **Item** | `yes-you-CAN` — Diagnoseplattform: Diagnose-Werkzeug (Workbench + Runtime), kein Steuergerät |
| **Funktion** | Fehlerspeicher lesen, Freeze Frames lesen, Identifikation, Fahrzeugauflösung, Messwerte lesen und aufzeichnen, **Schreiboperationen** (Codierung, Adaptation, Fehlerspeicher löschen) |
| **Grenze** | Außen: Fahrzeug-Bus (CAN / DoIP) über einen Adapter. Innen: `packages/*` + `apps/web`. Kein Zugriff auf Fahrfunktionen, keine Aktorik, keine Regelstrecke |
| **Schnittstellen** | `WritePort` (`packages/core/src/writes/`) als einzige Schreib-Tür; `SafetyManager` (`packages/domain/src/risk.ts`) als Freigabe-Instanz; HTTP-API der Workbench |
| **Annahmen** | Betrieb an einem Fahrzeug, das steht oder auf dem Prüfstand läuft. Kein Einsatz während der Fahrt. Bedienperson mit Diagnose-Sachkunde |

**Lücke:** Die Annahme „kein Einsatz während der Fahrt" ist nirgends erzwungen —
weder im Code noch in der Dokumentation gegenüber dem Benutzer. Siehe
[HARA-04](hara-template.md).

## 2. Sicherheitsziele (26262-3 §7) — Entwurf, nicht abgenommen

Die Sicherheitsziele ergeben sich aus der HARA; die ASIL-Einstufung ist **offen**
und darf nicht von einem Entwickler allein gesetzt werden.

| ID | Sicherheitsziel (Entwurf) | ASIL | Begründung fehlt |
|---|---|---|---|
| SG-1 | Eine Schreiboperation erreicht ein Steuergerät nur nach expliziter Freigabe mit gültigem Permit | offen | HARA-01 |
| SG-2 | Der Fehlerspeicher wird nicht geleert, während die Vorbedingungen dafür nicht geprüft sind | offen | HARA-02 |
| SG-3 | Ein Diagnoseergebnis nennt den Geltungsbereich — über welche Steuergeräte die Aussage gemacht wurde | offen | HARA-03, **seit ADR 0049 im Code umgesetzt** |
| SG-4 | Die Workbench ist nicht ohne Authentifizierung aus einem Netz erreichbar | offen | HARA-05, ISO 21434 — **seit ADR 0051 im Code umgesetzt** (Token-Tor), Bewertung steht aus |

**Beleg für SG-3:** `DtcScanReport.unread` (`packages/core/src/diagnostics/dtc-access.ts`),
Pflichtfeld `DtcsReadPayload.unreadCount`, Anzeige `#dtc-unread`. Das ist der Teil
dieses Konzepts, der bereits maschinell gepinnt ist.

**Beleg für SG-1/SG-2:** `WritePort.precheck()` / `run()` mit Permit und Stufenfolge;
**44 formale Write-Safety-Vektoren** (`tools/formal-conformance/vectors/safety.json`,
`npm run formal:conform` → 44/44). Was fehlt: die Rückverfolgbarkeit *von der
Anforderung zum Test* als gepflegte Tabelle — die Vektoren existieren, aber keine
Zeile sagt „dieser Vektor erfüllt SG-1".

## 3. Technische Sicherheitsanforderungen (26262-4 §6) — Lücke

Es gibt keine dokumentierte Ableitung von Sicherheitszielen auf technische
Anforderungen. Was existiert, sind Architektur-Regeln, die **dasselbe Muster**
haben, aber nicht als Sicherheitsanforderungen geführt werden:

| Existierende Regel | Wo maschinell geprüft | Könnte tragen |
|---|---|---|
| UI erreicht keinen Transport | `architecture/architecture.yaml`, `npm run check:deps` | SG-1 |
| Schreiben nur über `WritePort` | `tests/architecture/*` | SG-1 |
| Fehler werden behandelt oder protokolliert, nie verschluckt | `hygiene.test.ts` („no empty catch") | SG-3 |
| Ein Scan nennt die Module ohne Antwort | `engine-collaborators.spec.ts`, `backend-paths.spec.ts` | SG-3 |

**Aufgabe:** diese Tabelle in eine Anforderungsliste mit IDs überführen und je ID
den Test nennen, der sie belegt. Das ist Pflege, kein Entwurf — die Substanz ist da.

## 4. Bestätigungsmaßnahmen (26262-2)

| Maßnahme | Stand |
|---|---|
| Code-Review | vorhanden (PR-Prozess, CODEOWNERS `* @CAZE7`) |
| Statische Analyse | vorhanden: `biome check .` (479 Dateien), `tsc` in zwei strengen `noEmit`-Durchgängen |
| Testabdeckung mit Toren | vorhanden: global 94,12 / 86,36 / 95,93 / 95,51, per-file-Böden je Paket |
| Unabhängige Bewertung | **fehlt** — keine zweite Person, kein externes Assessment |
| Safety Review / Audit | **fehlt** |

## 5. Was konkret als Nächstes zu tun ist

1. **HARA ausfüllen** — [`hara-template.md`](hara-template.md), mit einer Person,
   die ASIL einstufen darf. Ohne das ist alles darunter Ratespiel.
2. **Rückverfolgbarkeit pflegen**: Anforderungs-ID → Test → Vektor. Eine Datei,
   eine Regel im CI, dass jede ID einen Test nennt.
3. ~~**SG-4 umsetzen**~~ — **erledigt** (ADR 0051): Token-Tor vor allen
   `/api/`-Routen, gemessen 401 ohne und 200 mit Token. Offen bleibt die Bewertung
   in der HARA.
4. **Annahme aus §1 erzwingen** oder streichen: entweder erkennt die Plattform
   „Fahrzeug fährt" und verweigert Schreiboperationen, oder die Annahme verschwindet
   aus dem Konzept. Eine Annahme, die niemand prüft, ist ein Haftungstext.
