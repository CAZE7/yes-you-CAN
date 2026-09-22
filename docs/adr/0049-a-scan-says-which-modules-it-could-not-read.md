# ADR 49 — Ein Scan sagt, welche Steuergeräte er nicht lesen konnte

- Status: akzeptiert (2026-09-22)
- Kontext: ADR 0033 (ein Messwert sagt, worüber er gemessen wurde), ADR 0039 (eine
  abgeschnittene Antwort ist ein Fehler, kein leerer Speicher), AGENTS 34.25 (Fehler
  werden behandelt oder protokolliert, nie verschluckt), AGENTS 22 (ein Befund kommt
  mit Beleg), 0.C.1 (ein Thema je PR)
- Betrifft: `packages/core/src/diagnostics/dtc-access.ts` (`scanAll` → Report),
  `packages/core/src/diagnostics/engine.ts` (`scanDtcs()`),
  `packages/domain/src/model.ts` (`UnreadEcuInfo`),
  `packages/domain/src/events.ts` (`DtcsReadPayload.unreadCount`),
  `packages/application/src/queries.ts` (`GetDtcScanGaps`),
  `packages/runtime/src/dtc-service.ts` (neu, aus `services.ts` geteilt),
  `packages/runtime/src/{handlers,mappers,services}.ts`,
  `apps/web/src/{backend,server,static-assets,dtc-view,views}.ts`
  (`static-assets.ts` neu), `apps/web/public/{app.js,api.js,index.html}`,
  `packages/shared/src/format.ts` (neu),
  `tools/simulators/src/scenarios.ts`, `tools/golden-sessions/src/{record,run}.ts`

## Problem

Die Workbench antwortete auf „welche Fehler stehen im Speicher?" mit **200 und einer
leeren Liste**, während kein einziges Steuergerät antwortete. Nachgemessen am
laufenden Server (`npm run demo`, Szenario `alternator_failure` auf `simulator-5ecu`):

| Messung | Ergebnis |
| --- | --- |
| `POST /api/dtc/scan`, T+45 s nach dem Lauf | **200 `{"dtcs":[]}`** |
| `POST /api/dtc/snapshot` (0x7EA, B1001) | **500** — ISO-TP-Timeout nach 75 ms |
| `GET /api/state` | `connected: true`, **10/10 erreichbar** |
| `GET /api/identify` | BCM `dtcCount: 1` (gecacht) |
| Server-Log nach select + start + Szenario + Scan | **3 Zeilen** |

Die Batterie war zu diesem Zeitpunkt von 8,79 V (T+8 s) auf den Bodenwert 8,01 V
(T+16 s) gefallen, die Messwerte eingefroren (Sample 1542, kein weiterer). Die drei
Aussagen, die der Operator bekam — „keine Fehler", „alle erreichbar", „ein Fehler
bekannt" — waren alle falsch, und keine der drei Komponenten hatte gelogen:

1. **`scanAll` verschluckte das Scheitern.** `dtc-access.ts` fing je Steuergerät,
   schrieb `log.warn("DTC scan failed for ECU")` und ließ das Gerät aus der
   Ergebnisliste weg. Weitermachen nach einem Fehler ist dabei *richtig* und getestet
   — ein Bus, an dem ein Modul hängt, darf keinen Scan kosten. Der Defekt war die
   Sichtbarkeit: das Ergebnis unterschied „keine Fehler" und „niemand hat geantwortet"
   nicht. Genau die Verwechslung, die ADR 0033 für Messwerte und ADR 0039 für
   abgeschnittene Antworten verbieten, war im Fehlerspeicher offen.
2. **Das `log.warn` kam nie an.** `createLogger` schreibt in die Sinks, die es
   übergeben bekommt — `sinks: []` ist der Default (`logger.ts:222-229`), und
   `ConsoleSink` (`:69`) hatte in der Workbench kein einziger Aufrufer. Der Server
   lief ohne Protokollierung, während seine Antworten ein leeres Fehlergedächtnis
   behaupteten.
3. **Die Anzeige hatte keinen Platz dafür.** Selbst ein Server, der die Lücke
   gekannt hätte, hätte sie nicht zeigen können: `renderDtcs(dtcs)` zeichnete Codes,
   und die Zusammenfassungszeile zählte sie.

Daneben, im selben Messdurchgang gefunden und hier mitentschieden:

4. **Float-Format im Urteil.** Der Szenario-Check druckte
   `batteryVoltage < 12 (gelesen 10.770000000000001)`. `passed` war vorher numerisch
   entschieden — geleakt ist die Binärdarstellung in einen Satz, den ein Mensch liest.
5. **Goldene Sitzungen sind nicht byte-stabil.** `npm run golden:record` auf
   unverändertem Baum: **1804+/1804−**; nach Herausrechnen der Zeitstempel bleiben
   **44 Wertzeilen** Drift (`abs.wheel_speed` 40,76 → 40,78, `engine.rpm` 831,3 → 832,
   `maf` 4,23 → 4,24). Replay bleibt grün.

## Entscheidung

**1. Ein Scan beantwortet zwei Fragen, und beide kommen zurück.**
`DtcAccess.scanAll` liefert einen Report:

```ts
export interface UnreadEcu {
  readonly ecuId: string;
  readonly ecuName: string;
  readonly rxId: number;
  readonly reason: string;
}
export interface DtcScanReport {
  readonly scanned: readonly ScannedEcu[];
  readonly unread: readonly UnreadEcu[];
}
```

`DiagnosticEngine.scanDtcs(): Promise<DtcScanReport>`. Die Compiler haben alle 40+
Aufrufstellen aufgezählt — kein Aufrufer konnte die zweite Hälfte übersehen.

**2. Die Lücke reist als Query und als Ereignisfeld, nicht als neuer Rückgabetyp des
Befehls.** `readDtcs()` behält seine Signatur (sie ist der Lese-Pfad der Anwendung und
hat Konsumenten bis in die Beispiele); die Lücke kommt über
`QueryKinds.GetDtcScanGaps` (`runtime.commands.query(getDtcScanGaps())`) und über
`DtcsReadPayload.unreadCount` — **Pflichtfeld**, damit kein Ereignis mehr „gelesen"
sagen kann, ohne zu sagen, wie viel davon fehlte.

**3. Core besitzt `UnreadEcu`, Domain besitzt `UnreadEcuInfo`.**
`architecture.yaml` verbietet `@vdp/core` den Import von `@vdp/domain`; die Abbildung
(`mappers.toUnreadEcuInfo`) liegt im Runtime, wo sie für jeden anderen IR-Typ auch
liegt.

**4. Eine Lücke altert, wenn das Modul antwortet.** Ein Scan, der ein einzelnes
Steuergerät erreicht, streicht dessen Eintrag aus `lastUnread` — eine Antwort ist der
Beweis, dass die frühere Stille keine dauerhafte Eigenschaft des Fahrzeugs war.

**5. Der Prozess hängt den Sink an, nicht die Klasse.**
`createServerLogger()` (exportiert aus `apps/web/src/server.ts`) liefert
`createLogger("web", { level }, [new ConsoleSink()])`, Level aus `VDP_LOG_LEVEL`,
unbekanntes Wort fällt auf `INFO` — niemals auf Stille. Angeschlossen wird er im
CLI-Einstieg. `WebServer`'s Konstruktor bleibt sink-los: stdout ist die
Schnittstelle *des Prozesses* (dasselbe Argument wie bei den CLIs), und eine Klasse,
die ein Einbetter oder ein Test konstruiert, schreibt nicht ungefragt.

**6. Die Anzeige bekommt einen Platz.** `#dtc-unread` in `index.html`,
`renderUnreadEcus` in `app.js` (`Modul (0x7E9): Grund`), und in der
Zusammenfassungszeile der Zusatz ` · N× nicht gelesen`. Die Antwort auf „keine
Fehler" ist damit nie wieder eine Zahl ohne Geltungsbereich.

**7. Ein Formatierer, eine Stelle.** `formatMeasuredValue` in `@vdp/shared`
(ganze Zahlen bleiben ganze Zahlen, sonst zwei Nachkommastellen). Vier handschriftliche Kopien
wurden darauf zurückgeführt (`evidence/collect.ts`, `session/compare.ts`,
`apps/web/src/trace-view.ts` — der Szenario-Urteilstext war die fünfte in
Wartestellung). **Nicht** vereinheitlicht: `logging/session-logger.ts` (schreibt
bewusst, wie JavaScript druckt, damit CSV-Zelle und dekodierter Sample
übereinstimmen), `reports/pdf.ts` (PDF-Zeichenkoordinaten) und `reports/report.ts`
— für Letzteres müsste `@vdp/reports` `@vdp/shared` importieren dürfen
(`architecture.yaml:146`: `mayImport: [core, diagnostic-ir]`), und eine
Architekturkante für einen Zahlenformatierer zu weiten ist der schlechtere Tausch.

**8. Goldene Sitzungen: dokumentiert statt „repariert".** Der Drift kommt daher, dass
die lebenden Signale mit der Wanduhr weiterlaufen, während der Recorder seine eigene
Uhr schreibt. Ein Fix hieße, die Aufnahme einzufrieren — das ist ADR 0036' Thema,
nicht dieses. Festgehalten in `tools/golden-sessions/README.md`: ein
`golden:record` auf unverändertem Baum ist kein Befund gegen den Code, und
`git diff` auf den Fixtures gehört nach dem Aufzeichnen geprüft, nicht committet.

**9. Das Größenbudget hat zwei Teilungen verlangt, nicht zwei Ausnahmen.**
`server.ts` (784 → 822) und `services.ts` (791 → 812) wuchsen über die 800 Zeilen von
`tests/architecture/hygiene.test.ts`. Geteilt wurde an Nähten, die schon da waren:

- `apps/web/src/static-assets.ts` — MIME-Tabelle, Sicherheits-Header, die beiden
  Wurzelauflösungen und das Ausliefern von Bytes. Nebenwirkung, die sich gelohnt hat:
  die Sicherheitszweige sind jetzt ohne HTTP-Rundlauf testbar und **wurden** getestet
  (sie waren es vorher nicht).
- `packages/runtime/src/dtc-service.ts` — der Fehlerspeicher-Dienst, das Thema dieses
  ADR. Bewusst **kein** Re-Export aus `services.ts`: das hätte die beiden Module
  ineinander importieren lassen, und ein Zyklus, der nur von gehoisteten
  Funktionsdeklarationen lebt, ist ein Defekt mit Termin.

Die zwei bestehenden Ausnahmen (`backend.ts`, `app.js`) tragen ihre Zeilenzahl im
Begründungstext und wurden nachgemessen neu stated (1490 → **1510**, 1676 → **1702**);
das Gate verlangt genau das: „restate the number or split the file".

## Why

- **Eine leere Liste ist eine Aussage über einen Geltungsbereich.** ADR 0033 verlangt
  das für Messwerte; ein Fehlerspeicher-Scan ist derselbe Fall. „Keine Fehler" über
  zehn Module und „keine Fehler" über null Module sind unterschiedliche Sätze, und
  die Schnittstelle hatte für den zweiten keine Form.
- **Zwei schweigende Komponenten ergeben eine falsche Entscheidung des Operators.**
  Keiner der beiden Befunde war für sich dramatisch: `scanAll` schrieb ja ein
  `log.warn`. Zusammen war die Information nirgends — nicht in der Antwort, nicht im
  Protokoll, nicht in der Anzeige.
- **Weitermachen nach einem Fehler bleibt richtig.** Die Alternative — beim ersten
  stummen Modul abbrechen — hätte einen Scan an einem Bus gekostet, an dem ein Modul
  hängt. Getestet ist beides: der Abbruch *eines* Moduls und der Scan, bei dem alle
  antworten.
- **Der Compiler ist der Vollständigkeitsbeweis.** Eine neue Query und ein
  Pflichtfeld im Ereignis lassen sich nicht versehentlich ignorieren; ein optionales
  Feld schon.

## Alternatives

1. **`EcuSession.lastError` / `EcuSummary.lastError` als Kanal.** Verworfen: das ist
   Attach-/Identify-Vokabular, und die Alterung wäre unklar — wann wird ein
   `lastError` wieder leer? Die Scan-Lücke altert an einer messbaren Stelle: bei der
   nächsten Antwort.
2. **Rückgabetyp von `readDtcs()` ändern.** Verworfen: der Befehl ist der Lese-Pfad
   der Anwendung, Konsumenten reichen bis in die Doku-Beispiele; der Bruch wäre groß
   gewesen, der Gewinn keiner — die Lücke ist ein *zweites* Ergebnis, nicht ein
   anderes.
3. **`ConsoleSink` als Default in `createLogger`.** Verworfen: dann druckt jeder Test,
   der einen Logger anfasst. Der Sink gehört an den Rand, wo stdout die
   Schnittstelle ist.
4. **Ausnahmen statt Teilungen im Größenbudget.** Verworfen: die Regel existiert,
   damit Dateien reviewbar bleiben; eine Zahl in einer Ausnahmeliste zu erhöhen ist
   keine Antwort auf „die Datei ist zu groß".
5. **`@vdp/reports` für `@vdp/shared` freigeben.** Verworfen — siehe Entscheidung 7.
6. **Die goldenen Fixtures einfrieren.** Verworfen: anderes Thema (ADR 0036), und ein
   „Fix", der die Aufnahme stoppt, würde den Befund beseitigen, statt ihn zu beheben.

## Affected packages

| Paket | Änderung |
| --- | --- |
| `@vdp/core` | `scanAll`/`scanDtcs` liefern `DtcScanReport`; `UnreadEcu` exportiert |
| `@vdp/domain` | `UnreadEcuInfo`; `DtcsReadPayload.unreadCount` (Pflicht) |
| `@vdp/application` | `QueryKinds.GetDtcScanGaps`, `getDtcScanGaps()` |
| `@vdp/runtime` | `dtc-service.ts` (neu, geteilt), `toUnreadEcuInfo`, Query-Registrierung |
| `@vdp/web` | `static-assets.ts` (neu), `createServerLogger`, `unreadEcus` im Zustand, Anzeige |
| `@vdp/shared` | `format.ts` (neu): `formatMeasuredValue` |
| `@vdp/simulators` | Urteilstext über `formatMeasuredValue` |
| `golden-sessions` | Report-Destrukturierung in `record.ts`/`run.ts` |

Kein `mayImport` wurde geweitet. Keine neue Abhängigkeit.

## Forbidden implementations

- **Die Lücke in ein optionales Feld stecken.** `unreadCount` ist Pflicht; ein
  `dtcs-read`-Ereignis ohne sie ist ein Typfehler, kein Stil.
- **`unread` verwerfen und nur `scanned` weiterreichen.** Das war der Defekt. Wer die
  erste Hälfte will, schreibt `.scanned` — sichtbar, nicht stillschweigend.
- **Einen Sink in einem Konstruktor oder als `createLogger`-Default anhängen.**
- **Eine vierte Kopie des Formatierers schreiben** (oder eine der drei
  dokumentierten Ausnahmen „vereinheitlichen", ohne ihren Grund zu lesen).
- **`static-assets.ts` umgehen** und Header oder MIME-Tabelle an einer zweiten Stelle
  setzen: die Policy gilt für jede Antwort, auch für den SSE-Strom.
- **Die Scan-Lücke als `lastError` am Steuergerät ablegen** (Alternative 1).

## Tests

Biss an beiden Enden gemessen, nicht behauptet:

- `packages/core/src/diagnostics/engine-collaborators.spec.ts` — „scanAll keeps going
  when one ECU fails — and names the one it could not read" pinnt `ecuId`/`ecuName`/
  `rxId`/`reason`; neu „a scan every module answered reports no gaps". **Ohne die
  Sammlung rot** (nachgemessen: `unread.push` entfernt → 1 failed / 19 passed).
- `packages/runtime/src/runtime.spec.ts` — „the scan reports what it could not read as
  a read model of its own": Query und `unreadCount` im Ereignis stimmen mit der
  Antwort überein.
- `apps/web/test/backend-paths.spec.ts` — „a bus where nobody answers reports the
  modules, not an empty fault list" mit `injectChaos({ dropRate: 1 })`: leere
  `dtcs`, **nicht** leeres `unread`, `rxId` als `0x…`, Zustand und Antwort
  deckungsgleich, `resetChaos` heilt. **Ohne die Sammlung rot** (nachgemessen).
- `apps/web/test/server-logging.spec.ts` (neu, 3) — der Prozess-Logger erreicht
  stdout, `WARN` kommt bei Default-Level durch, `VDP_LOG_LEVEL=error` unterdrückt
  `INFO`, ein unbekanntes Wort fällt auf `INFO`. **Ohne den Sink rot** (nachgemessen:
  3 failed).
- `apps/web/test/static-assets.spec.ts` (neu, 7) — Panel-Auslieferung, `/lib/`,
  404 mit Pfad, und die beiden Sicherheitszweige (leerer Pfad, NUL-Byte, `..`) direkt
  statt über HTTP. `static-assets.ts` 95 Statements / **75 Zweige** / 100 Funktionen /
  97,43 Zeilen; ungedeckt bleibt `resolveChartLibDir`'s `catch` (die Auflösung von
  `@vdp/charts` lässt sich ohne Deinstallation nicht zum Scheitern bringen).
- `packages/shared/src/format.spec.ts` (neu, 4) — `10.770000000000001` → `"10.77"`,
  Integer bleiben Integer, Vorzeichen, locale-frei.
- Angepasst, nicht abgeschwächt: `ports.spec.ts` (5 Ereignisse mit `unreadCount`),
  `tests/examples/dtc-analysis.example.ts` (zerlegt `{ scanned, unread }` und
  behauptet `unread` leer), `scenario-chain`, `full-stack`, `scenario-file`,
  `oem-hooks`, `regression`, `adapters.spec.ts`, `server.spec.ts`.

**Messung am Stand dieses Commits:** `npm run ci` **EXIT 0** — `tsc -b` sauber,
`biome check .` **479 Dateien** grün, `check:deps` „28 packages placed, 83 edges,
6 rules", `check:manifests` agree, **2311 Tests / 159 Dateien** (1 Skip, 170 s),
Coverage-Gate `armed` → `measured 90.2 s — 94,12 / 86,36 / 95,93 / 95,51`;
`npm run test:coverage` **EXIT 0**, **2310 passed / 2 skipped**, global
**94,12 / 86,37 / 95,93 / 95,51**, **0** Gate-Verletzungen; `formal:conform`
**28/28 und 44/44** mit ehrlichem `haskell NOT RUN`; `golden:record` EXIT 0
(„27 ok, 1 skipped"), Fixtures danach zurückgesetzt — der Drift ist Befund 8.

## AI implementation notes

- Die Kette ist `dtc-access.ts` → `engine.ts` → `dtc-service.ts` → `handlers.ts` →
  `backend.ts` → `dtc-view.ts` → `app.js`. Wer eine Hälfte ändert, findet die andere
  über den Typ: `DtcScanReport` hat genau zwei Felder.
- `QueryKinds` ist in `packages/application/src/commands.spec.ts` als sortierte Liste
  gepinnt („stable wire contract") — eine neue Query gehört dort hinein.
- Der Runtime hat **keinen** Query-Bus: `runtime.commands.query(...)` für Queries,
  `.dispatch(...)` für Befehle.
- `views.ts` ist node-frei und wird von `backend.ts` weitergereicht; darüber prüft
  `tsconfig.frontend.json` die `public/*.js` gegen den Wire-Contract. Ein Typ, den die
  Anzeige braucht, gehört nach `views.ts`.
- `markup.spec.ts` prüft, dass die strengen Selektoren der JS-Seite in `index.html`
  vorkommen — ein neues Element in der Anzeige braucht dort keinen Eintrag, wohl aber
  eine `id`.
- Einen Scan mit stummen Modulen erzwingt man **nicht** über einen Runtime-Test:
  `makeSilentBus()` liefert null Handles, und in die Registry des `DiagnosticEngine`
  zu greifen wäre ein privater Implementierungs-Cast (AGENTS 0.0). Die Pfade sind
  core (Stub-`EcuHandle`) und `apps/web` (`injectChaos`).
