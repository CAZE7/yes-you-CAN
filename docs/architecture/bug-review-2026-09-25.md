# Bug-Review 2026-09-25

Tiefen-Review des gesamten Codebase (396 TS-Dateien, ~57k Zeilen außer Specs) über
mehrere Nächte. Ergebnis: **6 bestätigte Bugs** — alle behoben, jeder mit einer
Regressions-Test, die das Verhalten auf der Drahtebene oder der API-Ebene pinnt.
Zusätzlich: neue Unit-Tests für die DoIP-Link-Factory (vorher 66% Coverage, keine
direkte Unit-Spec), synchronisierte Golden-Sessions und eine vertane
Lockfile-Abweichung.

Stand: alle Gates grün — Build, Typecheck (both), Biome (551 Dateien),
2712 Tests / 8 skipped, 0 Fehlschläge.

## Behobene Bugs

### 1. ISO-TP: `frameCountFor` benutzte die 8-Byte-Grenze statt der Single-Frame-Kapazität

**Wo:** `packages/transport/iso-tp/src/connection.ts`
**Was:** Die Test-/Helfer-Funktion `frameCountFor` berechnete die Frame-Zahl aus
`payload.length / 7` — korrekt nur für Classic CAN. Auf CAN-FD (62 Byte Nutzlast)
würde ein 50-Byte-Payload in 8 Frames zerlegt, obwohl eine einzige
Single-Frame es trägt. Die Produktion nutzt dieselbe Logik für `canFd`-Busse.
**Fix:** Die Grenze ist jetzt `singleFrameCapacity` (7 bzw. 62), die Frame-Zahl
`Math.ceil(len / capacity)` mit der Single-Frame-Sonderregel — exakt ISO 15765-2
§9.4.2.
**Test:** Neue FD-Regressions-Tests in `connection.spec.ts`: 62 Byte → 1 Frame,
63 → 2; extended: 61 → 1, 62 → 2.

### 2. DoIP: Fremde DIAGNOSTIC_MESSAGE-Adressen wurden ungeprüft dem Tester zugestellt

**Wo:** `packages/transport/doip/src/transport.ts`
**Was:** Der `DIAGNOSTIC_MESSAGE`-Zweig des Rx-Parsers hat nie geprüft, ob die
`sourceAddress`/`targetAddress` im Header auf **diese** Tester-Session gehören.
Ein fehlerhaftes Gateway (oder ein Bus-Bug) konnte eine Antwort für ein *andere*
Testadresse dem wartenden Request als Antwort zuschreiben — eine Antwort auf die
falsche Frage, ohne dass jemand es sieht.
**Fix:** Prüfung `sourceAddress === this.targetAddress &&
targetAddress === this.testerAddress`; alles andere wird geloggt (`log.warn`)
und verworfen.
**Test:** Neue Spec in `doip.spec.ts`: fremde Source (0x1100) und falsches Target
(0x0e01) werden verworfen, das korrekte Paar geht durch. Die existierende
`FakeDoipEndpoint` antwortet mit korrekten Adressen, daher keine
Bestands-Regression.

### 3. WritePort: Das Permit wurde vor dem Bus nicht regeprüft

**Wo:** `packages/core/src/writes/port.ts`
**Was:** Der Docstring versprach „the permit's validity is re-checked at write
time" — der Code hat es nie getan. Ein Permit, das zwischen `confirm` und
`execute` abläuft (TTL) oder für eine andere ECU ausgestellt wurde, hätte die
Fahrzeugseite erreicht.
**Fix:** `safety.verifyPermit(permit, binding.ecuId)` wird im **execute-Stage**
abgefragt, bevor ein Frame die Leitung erreicht. Eine Ablehnung ist ein
fehlgeschriebenes Write und nimmt deshalb den Weg des fehlgeschriebenen Writes
mit: Rollback-Policy, Audit-Journal, Permit-Ergebnis. (Wichtig: die Prüfung
gehört *in* den Stage — das formale Modell `safety.json`
`flow-expired-permit-is-rechecked-before-the-bus-sees-a-frame` pinned genau das:
`state: "rolled-back"`, `writeReached: false`. Ein Abort *vor* dem Stage hätte
das Modell gebrochen.)
**Test:** Die bestehenden Formal-Vektoren + `safety-runner.spec.ts` decken den
Pfad jetzt gegen die Produktion ab (vorher nur gegen einen Stub, der die
Recheck-Semantik emulierte, während der WritePort selbst nichts checkte).

### 4. Discovery: Funktionales TesterPresent-Probe mit falschem Sub-Byte

**Wo:** `packages/core/src/diagnostics/discovery.ts`
**Was:** Das funktionale Probe sendete `0x3E 0x80` — Bit 0x80 ist das
Suppress-Positive-Response-Indikator-Bit. Ein ECU, das ISO 14229-1 §9.4 korrekt
implementiert, antwortet dann **nicht** — und die Discovery hat dieses Modul für
tot erklärt, obwohl es lebt. (Bestätigt empirisch: Der Simulator hat keine
funktionale Adressierung; auf einem echten Fahrzeug wäre das ein
Entdeckungs-Fehlschlag für jedes korrekt implementierte Modul.)
**Fix:** Probe ist jetzt `0x3E 0x00` + Kommentar, der §9.4 nennt.
**Test:** Neue Spec pinnt die Draht-Bytes `3E 00` auf 0x7DF.

### 5. KWP2000: `readFaultCodes` akzeptierte abgeschnittene DTC-Listen

**Wo:** `packages/protocols/kwp2000/src/client.ts`
**Was:** Die positive Antwort wird in 3-Byte-Blöcke (DTC 2 Bytes + Status 1 Byte)
gesplittet. Eine Länge mit `(len − 2) % 3 !== 0` (z. B. ein abgeschnittener
MultiFrame) wurde stillschweigend so interpretiert, als wäre der letzte Block ein
vollständiger DTC — ein halbes DTC-Paar wurde als Code gemeldet, der es nie gab.
**Fix:** `ProtocolError` bei nicht-dividierbarer Länge — ein abgeschnittene Liste
ist kein „leerer Fehlerspeicher" (ADR 0039: fehlende Evidenz ist ein Fehler).
**Test:** Neue Spec mit `58 01 12 34 0D 56 78` (Rest-Byte 78).

### 6. UDS Client: `readDtcSnapshotRecord`/`readDtcExtendedDataRecord` gaben `null` statt Fehler bei zu kurzer Antwort

**Wo:** `packages/protocols/uds/src/client.ts`
**Was:** Positive Antworten unter 7 Bytes (minimum: SID, sub-function, DTC(3),
status(1), …) wurden als `null` zurückgegeben — „kein Snapshot vorhanden". Für
einen ECU, der eine positive Antwort sendet und dann abschneidet (Firmware-Bug,
Transport-Fehler), ist `null` eine Lüge: es gab eine Antwort, nur war sie
unvollständig.
**Fix:** `ProtocolError` bei positiver Antwort < 7 Bytes.
**Test:** Pinned-Test in `client-engine.spec.ts` jetzt
`assert.rejects(..., ProtocolError)`.

## Weitere Verbesserungen

- **DoIP-Link-Factory: neue Unit-Spec** (`packages/runtime/src/transport.spec.ts`,
  6 Tests). Vorher deckten nur die Integration-Tests die Factory ab; die
  Factory-Seams selbst waren ungetestet (66% Coverage):
  - `closeAll()` schließt und vergisst alle offenen Links
  - ein Socket, der sich weigert zu schließen, wird geloggt, nicht geworfen —
    und der Link verlässt trotzdem den Set (die Session-Teardown darf nicht in
    den Caller ausbrechen)
  - eine abgelehnte Routing-Activation (Code 0x06) hinterlässt keinen halboffenen
    Link
  - `states()`/`describe()` tragen die richtigen Adressen
  - `summariseLinkStates` reihen die sechs Zustände nach Schwere
- **Golden-Sessions neu aufgenommen** nach Bug-4 (die Aufnahmen enthielten das
  alte Probe-Byte `3E 80`; `payload-differs@0x7df` bei Replay war der
  beabsichtigte Change)
- **Hygiene-Exemption** `connection.ts`: 888 → 893 Zeilen, Audit-Trail mit dem
  Grund ergänzt (ISO-15765-2-§9.4.2-Kommentar)
- **Lockfile synchronisiert**: `@vdp/adapter-host` und `@vdp/simulators`
  deklarieren `@vdp/transport-doip` in `package.json`, das commitete
  `package-lock.json` hatte die Einträge nicht — `npm ci` auf einem anderen
  Rechner hätte einen unsynchronen Zustand erzeugt.

## Verbesserungspotenzial — Harterung 2026-09-25

Punkte 1, 4–8 wurden am 2026-09-25 nacheinander umgesetzt (alle mit
Regressionstests; alle Gates grün: 2740 Tests / 0 Fehlschläge).

1. ~~**`SafetyManager.verifyPermit` nutzt `Date.now()` direkt**~~ — **fertig**:
   injizierbarer Clock (`SafetyManagerOptions.now`), standardmäßig `Date.now`;
   die TTL-Grenze ist jetzt exakt testbar ohne Wall-Clock-Wait oder Mock
   (issued → gültig bis `issuedAt + ttlMs` inklusive → ein ms später verfallen).
   Die Audit-Timestamps nutzen dieselbe Quelle.
2. **`UdsClient.transmit` zählt `stats.timeouts++` bei jedem Link-Fehler** —
   noch offen (siehe „Noch offen" unten).
3. **`SupervisedDoipLink`-Reconnect**: noch offen (siehe „Noch offen" unten).
4. ~~**DoIP-Rx-Queue ist unbegrenzt**~~ — **fertig** (`transport/doip`): der
   Reassembly-Puffer ist hart begrenzt (`maxMessageBytes`, Default 64 KiB) —
   sowohl gegen deklarierte Längen (ein Peer kann 4 GiB deklamieren und Bytes
   tröpfeln) als auch gegen einzelne übergroße Chunks; die Antwort-Queue ist
   begrenzt (`maxQueuedResponses`, Default 16) — bei Überlauf geht das älteste
   Queue-Antwort weg, der Verlust wird geloggt und in `getStatus()` als
   `droppedRxCount` geführt (neues Feld in `ConnectionStatus`).
5. ~~**`runtime/transport.ts` `describe()` hardkodiert `targetAddress: 0`**~~ —
   **fertig**: die Factory beschreibt jetzt nur, was die offene Link wirklich
   trägt (tatsächliche `targetAddress`); ohne offene Link ist das Feld
   abwesend — eine Adresse, die niemand geöffnet hat, ist kein erfundener Wert
   in der Session-Record (AGENTS 24).
6. ~~**`auth.ts` vertraut `*.e2b.app` als Host/Origin**~~ — **fertig**: das
   Wildcard-Vertrauen ist weg; `validateRequestOrigin` nimmt jetzt eine
   explizite `trustedHosts`-Liste (exakte Treffer, case-insensitive). Der
   Sandbox-Preview-Host wird abgeleitet (`{port}-{E2B_SANDBOX_ID}.e2b.app`),
   nicht wildcarded. Zusätzlich weg: der `--host 0.0.0.0`-Catch-all, der
   vorher *jeden* Host-Header vertraut hat (Bind-Adresse ≠ Hostname).
7. ~~**Rate-Limit-Map ist unbegrenzt**~~ — **fertig** (`rate-limit.ts`):
   `maxTrackedIps` (Default 10 000) begrenzt die Window-Map hart; bei
   Cap-Treffer werden erst abgelaufene Windows weggefegt, dann die ältesten
   IPs evictet — eine rotierende Quelladresse kann die Map nicht mehr wachsen
   lassen. Evictete IPs starten einfach ein frisches Window (Graceful
   Degradation).
8. ~~**`?token=` wird auf jedem Pfad akzeptiert**~~ — **fertig** (`server.ts` +
   neues `host-rules.ts`): der Token-Austausch ist jetzt ein *Dokument*-Flow —
   nur `/` und `.html`-Pfade. `/api/*` liefert JSON (kein 302) und nimmt das
   Token aus Header oder Cookie; Assets/`/lib/` ignorieren den Query-Parameter
   (ein Token in einer Asset-URL vermehrt nur Leckstellen: Proxy-Logs, Referer).

### Noch offen (bewusst nicht geändert)

- **`UdsClient.transmit` zählt `stats.timeouts++` bei jedem Link-Fehler** —
  auch bei einem Disconnect. Die Statistik ist nur informativ, aber „Timeout"
  ist eine falsche Ursache für einen weggebrochenen Link.
- **`SupervisedDoipLink` „Revive schlägt fehl, Budget aufgebraucht, Link bleibt
  `error`"** ist nur im Integration-Test abgedeckt — eine dedizierte Unit-Test
  wäre wünschenswert.

## Abgeschlossen geprüfte Bereiche (ohne Befund)

- `tools/simulators/src/high-fidelity-vehicle.ts` (711), `vehicle-model.ts` (767),
  `virtual-vehicle.ts` (543), `scenario-file.ts` (749) — die Behaviour-Modelle
  sind sorgfältig konstruiert: Debounce/Hysteresis korrekt, Freeze-Frame wird
  synchron am Latch-Punkt gelesen, Monitor-Regeln (Regel 3/4) eingehalten
- `packages/adapters/host/src/catalog.ts` (700) — Probe/Teardown sauber,
  Reconnect-Policy wird durch das geteilte `reconnectPolicyOf` gebunden
- `packages/definitions/src/validate.ts` (611), `resolve.ts` (669),
  `json.ts` (563) — der Validator, der Resolver und der JSON-Parser sind
  durchdacht; `ecus` ist im Schema required, die `?? []`-Guards sind defensiv
- `packages/core/src/diagnostics/engine.ts` (282), `ecu-attacher.ts` (195),
  `session-opener.ts` (141), `ecu-links.ts` (154), `dtc-access.ts` (186)
- `packages/ai/src/heuristic.ts` (407) — die Heuristik ist explizit, jede
  Feststellung zitiert ihre Evidenz, Confidence ist eine Obergrenze
- Frontend `apps/web/public/*.js` (3454 Zeilen) — typisiert (JSDoc),
  `request()` mappt jeden Endpoint auf seine Shape, keine XSS-vektoren
- `apps/web/src/backend.ts`, `server.ts`, `views.ts`, `scenario-view.ts`
- `packages/reports/src/report.ts` — HTML-Escaping korrekt
- `packages/storage/src/repository.ts`, `packages/dtc/scanner.ts`,
  `packages/measurements/signal-analysis.ts`
- `tools/harvest/src/odx/diag-layer.ts` (787), `tools/trace-analyzer/src/index.ts`
  (622)
- Alle `packages/transport/can`, `packages/protocols/uds` (client/server/
  session-state/link), `packages/protocols/kwp2000`, `packages/shared`

## Ausgeschlossen (geprüft, kein Bug)

- Discovery-RxId-Filter mit `-1` — korrekt (funktionale Antwort kommt von
  jeder Adresse)
- Backend-ecuRef-Case/Padding — konsistent
- UDS 0x19 0x04-Layout — matches ISO 14229-1 (über py-uds-Doku bestätigt)
- Scanner describe/definitionOf Case-Split — bewusst
