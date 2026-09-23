# ADR 58 — Eine Ernte ist eine Beobachtung: read-only auslesen, als ODX beschreiben, mit `observed` als Quelle

- Status: akzeptiert (2026-09-23)
- Kontext: ADR 0003 (OEM-Wissen in Definition-Paketen mit Pflicht-Provenance),
  ADR 0004 (roh und dekodiert getrennt), ADR 0005 (Simulator und Replay statt
  Real-Fahrzeug), ADR 0033 (fehlender Beleg ist ein Fehlschlag), ADR 0049 (ein Scan
  sagt, welche Module er nicht lesen konnte), AGENTS 13 (OEM-Wissen ist Daten),
  AGENTS 24 (Provenance-Pflicht), AGENTS 30 (Fahrzeugdaten sind personenbezogen),
  AGENTS 34.11 (read-only vor write), ISO 14229-1 §11.3.4, ISO 22901-1 (ODX)
- Betrifft: `tools/harvest/**` (neu, `@vdp/harvest`),
  `packages/protocols/uds/src/{client,dtc,server}.ts` (Verfügbarkeitsmaske,
  `0x19 0x03`, Formatkennung), `packages/core/src/{diagnostics/ecu-session,dtc/scanner,session/session}.ts`,
  `packages/diagnostic-ir/src/dtc.ts`, `packages/definitions/src/{schema,json,validate,evidence}.ts`
  (`sourceType: "observed"`, Provenance je Signal/DTC/ECU),
  `apps/web/src/vehicle-view.ts`, `architecture/architecture.yaml`,
  `tsconfig.json`, `docs/flows/harvest.md`, `docs/code-map.md`

## Problem

Die Plattform kann ein Fahrzeug bestimmen, Fehlercodes lesen und je Code das Wissen
der bestimmten Variante zeigen — aber sie kann **kein Fahrzeug aufnehmen**. Jedes
Definitionspaket im Baum ist handgeschrieben (`generic`, `vag`, `mercedes`,
Simulator), und der Master-Backlog nennt denselben Flaschenhals an zwei Stellen:
P0 #10 („echte Fahrzeugaufzeichnungen laufen durch dieselbe Pipeline, sobald
Adapteraufzeichnungen vorliegen") und P2 #38 („größere OEM-Definitionsbasis wächst
mit #10: jede echte Session bringt Wissen zurück"). Ohne einen Weg, ein reales
Fahrzeug strukturiert auszulesen, bleibt jede Wissensbasis so groß wie die Zeit, die
jemand mit dem Tippen von DIDs verbracht hat.

Die Anfrage lautete: *„ein Werkzeug, das das Auto komplett ausliest und alles als
ODX-Datei speichert, damit ich mir kostenlos und legal Daten für mein System
abgreife"*. Drei Annahmen darin sind zu prüfen, bevor Code entsteht — sonst baut das
Werkzeug etwas, das es nicht geben kann:

1. **Ein Auto enthält kein ODX.** ODX (ISO 22901-1, ASAM ODX 2.2) ist ein
   *Austauschformat für Beschreibungen*: was ein Hersteller über ein Steuergerät
   veröffentlicht, damit ein Tester damit sprechen kann, ohne das Steuergerät zu
   kennen. Aus einem Fahrzeug lesbar sind Antworten — Adressen, Dienste, DIDs mit
   ihren Bytelängen, Fehlercodes mit Status und Freeze Frames. Eine ODX-Datei kann
   also nicht *extrahiert*, sondern nur *aus den Antworten geschrieben* werden.
2. **„Komplett" ist durch drei Grenzen begrenzt**, keine davon technisch:
   die DIDs, die ein Steuergerät überhaupt implementiert (der Rest antwortet
   `requestOutOfRange`), die Sitzung (viele DIDs antworten erst in der erweiterten
   Sitzung, und `0x10` ändert den Zustand des Fahrzeugs) und Security Access
   (`0x27`, den diese Plattform nicht umgeht — AGENTS 0.D, und ein fehlgeschlagener
   Versuch kann das Steuergerät sperren).
3. **„Kostenlos" ist für Herstellerdaten falsch, „legal" hat zwei verschiedene
   Wege.** ODX-/PDX-Pakete eines Herstellers sind dessen Publikation: Der Zugang ist
   über Art. 61 VO (EU) 2018/858 für unabhängige Akteure verpflichtend, in
   maschinenlesbarer Form, und Art. 63 erlaubt dafür „angemessene und verhältnismäßige"
   Gebühren (EuGH C-319/22; seit 23.06.2026 ergänzt um VO (EU) 2026/699 zu sicheren
   Zugängen). Kostenlos ist das nicht. **Kostenlos und legal ist dagegen die eigene
   Messung**: was ein Fahrzeug antwortet, das man selbst besitzt oder für dessen
   Auslesen man beauftragt ist, ist eine Beobachtung ersten Grades — kein
   Eingriff, keine Umgehung, keine fremde Publikation. Genau dafür fehlt das Werkzeug.

Gemessen am Stand vor dieser Entscheidung: `grep -ril odx` fand im gesamten Baum
**einen** Treffer, in `package-lock.json`. Es gab keinen Pfad von einem Fahrzeug zu
einer Datei.

Daneben, beim Lesen des DTC-Pfads gefunden und hier mitentschieden:

4. **Die DTC-Verfügbarkeitsmaske wurde weggeworfen.** Jede `0x19`-Listenantwort
   trägt als drittes Byte die *DTC status availability mask* (ISO 14229-1 §11.3.4.2):
   welche der acht Statusbits dieses Steuergerät überhaupt setzt. `parseDtcList(response, 3)`
   begann *hinter* diesem Byte, und `dtcSeverity(bits)` las alle acht Bits — ein
   Steuergerät, das `confirmedDtc` nie meldet, wurde also über ein Bit eingestuft,
   das es nie gesetzt hat. „Bit nicht gesetzt" und „Bit wird nicht gemeldet" sind
   verschiedene Aussagen, und ADR 0033 verbietet genau diese Verwechslung.
5. **Der Simulator antwortete mit einem Layout, das kein reales Steuergerät nutzt.**
   `0x19 0x01` (`reportNumberOfDTCByStatusMask`) ist laut §11.3.4.2 sechs Bytes:
   SID, Subfunktion, Verfügbarkeitsmaske, **DTC-Formatkennung**, Anzahl (2 Bytes).
   `server.ts` ließ die Formatkennung weg — fünf Bytes, die Anzahl an der falschen
   Stelle. Ein gegen die Norm geschriebener Client hätte den Simulator richtig und
   ein reales Fahrzeug falsch gelesen.
6. **`0x19 0x03` war nicht implementiert.** Ohne
   `reportDTCSnapshotIdentification` weiß ein Leser nicht, *wie viele* Freeze Frames
   ein Code hat; „alle Freeze Frames lesen" bedeutete raten (`0xff`) und ein Rat, der
   nichts trifft, ist von „kein Environment-Daten aufgezeichnet" nicht zu
   unterscheiden.

## Entscheidung

**Ein read-only-Ernte-Werkzeug, dessen Ergebnis eine Beobachtung ist — und drei
Projektionen dieser Beobachtung.**

### 1. `@vdp/harvest` (Werkzeug, keine Schicht)

`harvestVehicle({ bus, definitions, plan, identity })` fährt einen vollständigen
read-only-Durchgang über ein Fahrzeug und liefert einen `HarvestReport`:

```text
Discovery (funktional + Einzelproben, EcuDiscovery aus @vdp/core)
  ├─ antwortet → HarvestedEcu { Adresse, Dienste, DIDs, Fehlerspeicher, Lücken }
  └─ deklariert, aber stumm → HarvestUnread { rxId, txId, reason }
je ECU:
  Dienste       sichere Sonden aus core (0x10/0x11/0x19/0x22/0x31/0x3E)
                + „never sent" für 0x14/0x27/0x28/0x2F/0x34/0x85 mit Grund
  Identifikation F190/F187/F181/F18C … (roh + ASCII-Hinweis)
  DID-Sweep     F180–F1FF und F400–F4FF, Doppellesung für Stabilität
                Verweigerungen gruppiert nach Planbereich + NRC (nicht je DID)
  Fehlerspeicher 0x19 0x01 → 0x03 → 0x02 → 0x04/0x06 (fault-memory.ts)
```

Der Frageplan ist **Daten** (`plan.ts`): Bereiche, Budgets, Abstände, welche
Recordnummern gefragt werden. Er ist vor dem Lauf druckbar (`--print-plan`) und
reist im Datensatz mit, damit eine Lücke von einem Verzicht unterscheidbar bleibt.

### 2. Read-only ist eine Eigenschaft des Werkzeugs, nicht eine Absicht

- Gesendet wird nur, was `SAFE_PROBES` enthält — dieselben sechs Sonden, die core
  bereits als harmlos entscheidet (unassigned session type, unassigned reset type,
  DID 0x0000, abgeschnittene Anfrage).
- `FORBIDDEN_HARVEST_SERVICES` nennt jeden Schreibdienst mit Grund; diese Dienste
  werden **nie gesendet** und erscheinen im Datensatz als `not-probed`.
- `0x2E` (WriteDataByIdentifier) wird *nicht einmal sondiert*, außer mit
  `--probe-writes`: die Sonde ist zwar harmlos (Längenprüfung schlägt fehl, bevor
  etwas geschrieben wird), aber „harmlos" ist ein Argument, das ein Leser des
  Datensatzes nicht prüfen kann. Ohne das Flag gilt wörtlich: **kein Schreibdienst
  wird gesendet.**
- `harvest.spec.ts` scannt die eigenen Quelldateien nach Aufrufen der Schreib-APIs
  (`clearDiagnosticInformation`, `writeDataByIdentifier`, `startRoutine`,
  `securityAccess*`, `ecuReset(`, …) und fällt, sobald einer auftaucht.

### 3. Provenance bekommt die Quelle `observed`

`Provenance.sourceType` erweitert um `"observed"` (neben `own`, `standard`,
`licensed`, `community`, `reverse-engineered`, `example-placeholder`), und
`SignalDefinition`, `DtcDefinition` und `EcuDefinition` bekommen je ein eigenes
optionales `provenance`-Feld. Begründung: ein Paket aus einer Ernte ist *als Ganzes*
beobachtet, aber die einzelne Zeile braucht ihre eigene Quelle — „diese 17 Byte an
DID 0xF190 wurden am 23.09. um 10:00 gelesen" ist eine andere Aussage als „dieses
Paket stammt aus einer Ernte". Regeln in `validate.ts`:

- `observed` ohne `retrievedAt` → Warnung: eine Messung ohne Datum ist von einer
  Vermutung nicht zu unterscheiden (Reparatur, Softwarestand, Verkauf).
- `observed` mit `license` → Warnung: eine Messung ist nicht lizenziert; ein
  Lizenzfeld behauptet Rechte an einer fremden Publikation.
- `provenanceTrust("observed") = 0.9`: über `community` (0.8), weil ersten Grades,
  unter `own`/`standard`/`licensed` (1.0), weil niemand es gegen eine Publikation
  prüfen kann und es über die Bedeutung der Bytes nichts sagt.
- Die UI nennt sie „am Fahrzeug ausgelesen — Bedeutung nicht dokumentiert".

### 4. ODX ist eine Projektion der Beobachtung, nicht eine zweite Wahrheit

`odx/diag-layer.ts` schreibt ein `DIAG-LAYER-CONTAINER`-Dokument (ODX 2.2,
`MODEL-VERSION="2.2.0"`), ein `BASE-VARIANT` je ECU, und darin:

| Beobachtung | ODX-Form |
|---|---|
| DID-Antwort | `DIAG-SERVICE` + `REQUEST`/`POS-RESPONSE`: SID und DID als `CODED-CONST`, Nutzlast als `A_BYTEFIELD` mit `MIN-LENGTH == MAX-LENGTH ==` beobachtete Länge |
| Fehlerspeicher | `DIAG-SERVICE` für `0x19 0x02` mit der beobachteten Antwort als Byte-Rezept |
| Fehlercodes | `DTC-DOP` → `DTC` je Code: `TROUBLE-CODE` als 24-Bit-Zahl, `DISPLAY-TROUBLE-CODE` = `P0420-00`, `TEXT` = „gemeldet, Bedeutung nicht dokumentiert", Status/Maske/Snapshot-Zahl als `SDG` |
| Freeze Frames | `ENV-DATA-DESC` + `ENV-DATA` je Aufzeichnung, roh, mit `DTC-VALUE` |
| Adresse, Timing, Dienste, Lücken | `SDGS`/`SD`-Paare je Variante |
| Provenance | `SDG` mit `provenance=observed`, `source`, `retrieved-at`, `vin-redacted`, `platform-version` |

`odx/pdx.ts` packt `index.xml` (ODX-`CATALOG`) und das Dokument in ein ZIP — mit
`createZip` aus `@vdp/storage`, weil dieses Repo bereits einen
abhängigkeitsfreien ZIP-Schreiber mit CRC-32 hat.

**Kein Erfunden wird:** keine Skalierung, keine Einheiten, keine physikalischen
Typen über „diese Bytes" hinaus, keine Namen für Steuergeräte, die kein Paket
deklariert, keine `POS-RESPONSE` für eine DID, die verweigert wurde. Eine Verweigerung
steht als Zählung mit NRC und Bereich in den `SDG`s — ein Dienst ohne Antwort wäre
eine Aussage, die das Fahrzeug nie gemacht hat.

**Nicht enthalten ist die ODX-C-Schicht** (`COMPARAM-SPEC`). ISO-15765-Kommunikationsparameter
korrekt zu beschreiben heißt, die Comparam-Subsets der Norm mitzuführen — das ist
eine Abhängigkeitsentscheidung (ADR 0002/0010), keine Schreiberentscheidung. Die
Adressierung reist deshalb als `SDG`, und das Dokument sagt das selbst.

### 5. Die Gegenprüfung läuft gegen eine zweite Implementierung

`odx/verify.ts` übergibt das Dokument **`odxtools`** (MIT, Mercedes-Benz) und prüft
drei Dinge: das Dokument parst, jede beobachtete Anfrage **encodiert** zurück auf die
gesendeten Bytes, jede beobachtete Antwort **decodiert** zurück auf die Bytes, die
ankamen. `odxtools` ist **keine Abhängigkeit** dieses Repos: es wird als externer
Prüfer gespawned, und fehlt er, meldet das Werkzeug `odxtools NOT RUN` mit Grund und
bleibt grün — ein Prüfer, der nicht laufen kann, ist nicht durchgefallen, er ist
nicht gelaufen (dieselbe Regel wie `formal/README.md` für die Haskell-Referenz).

### 6. Der Definitions-Kandidat ist ein Kandidat

`definition.ts` überführt die Beobachtung in ein `DefinitionPackage` (Schema v3), das
durch `validateDefinitionPackage` läuft — dieselben Regeln wie ein handgeschriebenes
Paket, keine zweite Validierung. Drei Grenzen:

- **Nur eine Länge mit dokumentierter Kodierung wird ein Signal**: 1/2/3/4 Byte →
  `uint8/16/24/32`, druckbar → `ascii`. Elf Byte unbekannter Bedeutung werden **kein**
  Signal, sondern ein Eintrag in `skipped` mit Grund — ein erfundenes `uint8` an
  Offset 0 wäre eine Dekodierung, die niemand dokumentiert hat (AGENTS 13).
- **Nur ein Code in J2012-Zeichenform wird ein DTC**; `PA123` bleibt Beobachtung und
  landet in `skipped`, statt gebogen zu werden.
- **Die Beschreibung sagt „gemeldet"**, nie „bedeutet": „Am 2026-09-23 von ECU 0x7e8
  mit Status 0x2f gemeldet. Bedeutung nicht dokumentiert — dies ist eine Beobachtung."

### 7. Die Maske reist mit (Punkte 4–6 des Problems)

- `dtcSeverity(bits, availabilityMask = 0xff)` stuft nur aus Bits, die das
  Steuergerät implementiert; `supportedStatusBits`/`unsupportedStatusBits` machen
  die Maske lesbar.
- `DtcRecord.availabilityMask`, `DtcReport`, `readDtcReportByStatusMask()`,
  `readSupportedDtcReport()`, `readDtcCountByStatusMask()`,
  `readDtcSnapshotIdentification()`; die alten Methoden bleiben als Projektionen,
  kein Aufrufer musste ändern.
- Server: `0x19 0x03` implementiert, `0x19 0x01` mit Formatkennung (sechs Bytes,
  `dtcFormatIdentifier` konfigurierbar).
- IR: `DtcObservation.availabilityMask` (optional, nie auf 0xff defaultet — das
  würde die Behauptung erfinden); `EcuSession.dtcAvailabilityMask` als Sitzungsdatum.

### 8. Personenbezogenes bleibt maskiert

Die VIN ist personenbezogen (AGENTS 30). Default ist `redactVin()` — WMI und die
letzten vier Stellen bleiben (die Positionen, gegen die ein Paket matcht), die Mitte
wird maskiert, und `identity.vinRedacted: true` sagt es im Datensatz. `--keep-vin`
ist der einzige Weg zum Klartext, und die Ernte schreibt dann eine Note.

## Why

- **Beobachtung und Wissen getrennt halten ist die einzige Version, die später
  nicht lügt.** Ein Werkzeug, das aus `0xF190 → 17 druckbare Bytes` ein Signal
  „VIN" mit `uint8`-Dekodierung machte, hätte eine Wissensbasis erzeugt, die zu 90 %
  aus Vermutungen besteht und zu 100 % wie Dokumentation aussieht. `observed` plus
  `skipped` plus `asciiHint` als *Hinweis* halten den Unterschied maschinenlesbar.
- **Read-only als Eigenschaft, nicht als Absicht.** Die Plattform hat eine
  Safety-Kette für Schreibvorgänge (ADR 0032/0033); eine Ernte braucht sie nicht,
  weil sie nichts schreibt — und genau das muss ein Leser prüfen können, ohne den
  Code zu lesen: Plan, `not-probed`-Liste, Quell-Scan im Test.
- **Eine zweite Implementierung ist der einzige Beweis für ein Format.** Wer ODX
  selbst schreibt und selbst testet, prüft sein eigenes Lesen der Norm. `odxtools`
  hat 29/29 Anfragen auf die gesendeten Bytes und 29/29 Antworten auf die
  empfangenen Bytes zurückgeführt (gemessen 2026-09-23, odxtools 11.6.0,
  Simulator-Fahrzeug) — ein Byte weniger, und die Prüfung fällt.
- **Die Maske mitzunehmen kostet ein Feld und verhindert eine falsche Aussage.**
  Ohne sie ist jede Severity-Klassifikation eine Behauptung über Bits, die das
  Steuergerät vielleicht nie setzt.
- **Der Simulator muss der Norm folgen, nicht der Bequemlichkeit.** Ein Simulator,
  der fünf statt sechs Bytes antwortet, trainiert Clients an, reale Fahrzeuge falsch
  zu lesen — und ist dabei grün, weil beide Seiten denselben Fehler machen.

## Alternatives

| Alternative | Warum nicht |
|---|---|
| ODX-/PDX-Pakete der Hersteller herunterladen und importieren | Rechtlich der sauberste Weg zu *dokumentiertem* Wissen (Art. 61/63 VO (EU) 2018/858), aber nicht kostenlos und nicht automatisierbar: Zugang je Herstellerportal, Gebühren, teils SERMI-Autorisierung für sicherheitsbezogene RMI. Bleibt als eigener Importer offen (Backlog), braucht aber Lizenz- und Provenance-Entscheidungen je Quelle |
| Einen ODX-Parser statt eines Schreibers bauen | Ohne Paket von außen gibt es nichts zu parsen; der Schreiber ist der Teil, der aus einer Messung ein Austauschformat macht. Beides zusammen ist ein eigener Schritt, sobald eine Quelle exists |
| `odxtools` als Python-Abhängigkeit ins Repo | ADR 0002: keine Laufzeit-Abhängigkeiten; ein Werkzeug, das XML schreibt, braucht keinen Parser. Als *externer Prüfer* ist es willkommen und als solcher behandelt (optional, `NOT RUN` ist ehrlich) |
| Die Ernte als Engine-Methode in `@vdp/core` | Core ist die Diagnose-Engine; eine Ernte ist ein Lauf mit Plan, Budgets und Dateiausgabe. Als Werkzeug bleibt die Engine klein und die Ernte testbar, ohne die Workbench zu berühren (dieselbe Grenze wie `@vdp/golden-sessions`) |
| Jede verweigerte DID einzeln speichern | Gemessen: 1126 Einträge bei einem Simulator-Fahrzeug, 26 Antworten — die Antworten wären im Rauschen untergegangen. Gruppiert nach Planbereich + NRC steht dieselbe Information in drei Zeilen |
| `0x2E` standardmäßig sondieren (wie core) | „Die Anfrage schlägt vor dem Schreiben fehl" ist richtig, aber nicht prüfbar für jemanden, der den Datensatz liest. Als Opt-in bleibt die Default-Aussage wörtlich wahr |
| Verfügbarkeitsmaske auf 0xff defaulten, wenn sie fehlt | Das würde behaupten, das Steuergerät melde alle acht Bits — genau die Erfindung, die ADR 0033 verbietet. Abwesend bleibt abwesend |

## Affected packages

| Paket | Änderung |
|---|---|
| `@vdp/harvest` (neu, `tools/harvest`) | Ernte, Plan, Beobachtungsmodell, ODX-D-/PDX-Schreiber, Gegenprüfung, Definitions-Kandidat, CLI |
| `@vdp/protocols-uds` | Verfügbarkeitsmaske im Report, `0x19 0x01/0x03`, maskenbewusste Severity, Server-Formatkennung |
| `@vdp/core` | `readDtcs` merkt sich die Maske, `readDtcSnapshotIdentifications()`, Beobachtung trägt die Maske |
| `@vdp/diagnostic-ir` | `DtcObservation.availabilityMask` |
| `@vdp/definitions` | `sourceType: "observed"`, Provenance je Signal/DTC/ECU, Validierungsregeln, `provenanceTrust` |
| `@vdp/web` | Provenance-Label für `observed` |
| `architecture/architecture.yaml` | `@vdp/harvest` als Werkzeug platziert, Node-Builtins für seine CLI erlaubt |

## Forbidden implementations

- **Keine Bedeutung ohne Quelle.** Eine Ernte darf keine Signalnamen, Einheiten,
  Skalierungen oder DTC-Texte erfinden; `asciiHint` ist als Hinweis gekennzeichnet
  und nichts darf ihn als Dekodierung behandeln.
- **Kein Schreibdienst, auch nicht als Sonde** — außer über `--probe-writes`, und
  dann steht es im Datensatz.
- **Kein zweiter ODX-Schreiber und kein zweiter Frageplan.** Die Regel, welche
  Dienste sicher sind, lebt in core; die Regel, was gefragt wird, in `plan.ts`.
- **Keine Verweigerung als Wert.** `requestOutOfRange` ist eine Verweigerung mit NRC,
  ein Timeout ist eine Lücke — beides darf nicht zu „DID mit 0 Byte" werden.
- **Kein `NOT RUN` als Grün.** Fehlt `odxtools`, sagt das Werkzeug es; ein Test, der
  die Prüfung überspringt, darf sie nicht als bestanden zählen.
- **Keine VIN im Klartext ohne `--keep-vin`.**

## Migration

Additiv, kein Bruch:

1. `readDtcByStatusMask()`/`readSupportedDtc()` behalten ihre Signatur und liefern
   die Records der neuen Report-Methoden — kein Aufrufer musste ändern (gemessen:
   eine Produktionsaufrufstelle in `ecu-session.ts`).
2. `dtcSeverity(bits)` ohne Maske verhält sich wie vorher (Default 0xff); bestehende
   Tests bleiben grün, zwei bewusst ersetzte Aussagen sind die
   Server-Formatkennung (`response[3]`/`[4]` → `[4]`/`[5]`) und die neue
   `0x19 0x03`-Antwort.
3. `DtcObservation.availabilityMask`, `EcuSession.dtcAvailabilityMask`,
   `SignalDefinition.provenance`, `DtcDefinition.provenance`, `EcuDefinition.provenance`
   sind optional: gespeicherte Sitzungen und alte Pakete bleiben lesbar, kein
   Schema-Bump (dieselbe Regel wie ADR 0037 für `evidence`).
4. `"observed"` ist ein neues Mitglied einer Union — der Compiler zählte die Stellen
   auf (`evidence.ts`, `json.ts`, `vehicle-view.ts`), keine Suche.
5. Die Ernte selbst ist ein Werkzeug: nichts importiert sie, kein Laufzeitpfad ändert
   sich, die Workbench bleibt unberührt.

## Tests

- `tools/harvest/src/*.spec.ts`, `odx/*.spec.ts` — 93 Tests: Plan und Read-only-Regel
  (inkl. Quell-Scan), Beobachtungsmodell (ECU-Id, VIN-Maskierung, ASCII-Hinweis),
  ODX-Struktur (Dienst/Byte-Rezept, DTC-DOP, ENV-DATA, SDG-Provenance, Escaping,
  PDX-Katalog und ZIP-Inhalt), Definitions-Kandidat (Validierung, `observed` auf
  jeder Ebene, `skipped` mit Grund, SemVer), CLI (Grammatik, Exit-Codes, Artefakte,
  `NOT RUN`), Ernte gegen ein reales UDS-Stack (`VirtualVehicle`).
- `odx/verify.spec.ts` — die Gegenprüfung gegen `odxtools`: immer der ehrliche
  `not-run`-Pfad, und — nur wenn die Bibliothek installiert ist — Parse,
  Encode-Rundlauf, Decode-Rundlauf und der Biss (eine falsche Erwartung muss fallen).
- `packages/protocols/uds/src/{dtc,client,server}.spec.ts` — Maske, maskenbewusste
  Severity, `0x19 0x01/0x03`, Formatkennung.
- `packages/core/src/diagnostics/ecu-session.spec.ts` — Maske auf dem
  Sitzungsrecord, Snapshot-Identifikation als Daten und Verweigerung als Antwort.
- `packages/definitions/src/{validate,json}.spec.ts` — `observed`-Regeln, Provenance
  je Element, Fehlerpfade.
- Gemessen am Stand: `npm run ci` grün, `check:deps` „29 packages placed, 92 edges",
  `check:manifests` agree, ODX-Gegenprüfung `verified` (29/29 encode, 29/29 decode,
  0 Abweichungen).

## AI implementation notes

- Eine Ernte ist **read-only**; wer Schreibdienste braucht, baut einen Schreibpfad
  über den Write-Port (ADR 0032), nicht in dieses Werkzeug.
- Neue Fragen an ein Fahrzeug gehören in `plan.ts` als Daten (Bereich, Budget,
  Recordnummer) — nicht als Schleife im Treiber.
- Jede neue Beobachtung braucht: ein Feld im Modell, eine Zeile in der ODX-Projektion
  (oder eine bewusste Entscheidung, dass ODX sie nicht ausdrücken kann, als `SDG`
  plus Text im Dokument) und einen Eintrag im Definitions-Kandidaten oder in
  `skipped`.
- `exactOptionalPropertyTypes` gilt: ein optionales Feld wird mit bedingtem Spread
  gesetzt, nie mit `undefined` zugewiesen.
- Die Gegenprüfung ist optional und extern; ein Test, der sie nicht fahren kann,
  meldet das, statt sie zu emulieren.
- Personenbezogene Daten (VIN, Standort, Fahrverhalten) maskieren oder weglassen;
  `--keep-vin` ist die einzige Ausnahme und schreibt eine Note.
