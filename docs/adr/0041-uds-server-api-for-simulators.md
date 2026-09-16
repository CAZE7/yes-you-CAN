# ADR 41 — Der UDS-Server hat eine Simulator-API; Casts in interne Maps sind keine

- Status: akzeptiert (2026-09-15)
- Kontext: AGENTS 32 (Simulator), ADR 0005 (Simulator/Replay statt Hardware), ADR 0039 (gesunde ECU, lügender Draht), ADR 0040 (Fahrzeugmodell)
- Betrifft: `packages/protocols/uds/src/server.ts`, `packages/protocols/uds/src/server.spec.ts`, `tools/simulators/src/high-fidelity-vehicle.ts`, `tools/simulators/src/virtual-can.ts`

## Problem

Der High-Fidelity-Simulator brauchte DIDs, die er selbst *berechnet* — Batteriespannung am
BCM, Zündungsposition, Codierblock, Leerlaufadaption, Gateway-Routing. Der Server bot dafür
nur den Konstruktor (`options.dids`). Die Antwort des Simulators war:

```ts
const server = ecu.server as unknown as { dids?: Map<number, ServerDid> };
if (server.dids instanceof Map) server.dids.set(didDef.did, didDef);
```

Ein Cast auf ein Privates, danach eine `instanceof`-Prüfung, damit ein Rename nicht knallt,
sondern **leise** bleibt: `server.dids` wäre `undefined`, die Bedingung griffe nicht, und
der Simulator antwortete auf 0x2001 mit dem, was das Definitions-Paket gerade so hergibt.

Das eigentliche Loch war damit nicht benannt. Ein **berechnetes** DID lässt sich nicht als
Schreibfeld abbilden: `handleWriteDataByIdentifier` speicherte einen Write, indem er die
Definition ersetzte (`value: () => payload.subarray(3).slice()`). Für eine Speicher-DID
richtig, für `bcm.battery_voltage` fatal — nach einem Test-Write wäre die gemessene
Spannung eingefroren gewesen, und die Diagnose hätte den Wert des letzten Testers gelesen
statt das Fahrzeug. Für 0x0200 (Codierung) und 0x2100 (Adaption), die ein Steuergerät in
**eigener** Erinnerung hält, gab es keinen Haken überhaupt.

Dasselbe Muster, zweiter Ort: `createVirtualCanNetwork` hing sein `deliver` nachträglich ans
Objekt, und der Bus las es mit Cast zurück.

## Entscheidung

1. **DID-Registrierung ist API**: `registerDid()`, `registerWritableDid()`,
   `unregisterDid()`, `hasDid()`, `registeredDids`. Der Konstruktor ruft dasselbe
   (`for (const did of options.dids ?? []) this.registerDid(did)`) — es gibt genau einen Weg
   in die Map. Ein Feld umbenennen ist jetzt ein Compile-Fehler im Simulator, nicht eine
   Bedingung, die still nicht greift.
2. **`registerWritableDid` kann `writable` nicht vergessen**: die Form verlangt `write` und
   setzt `writable: true` selbst.
3. **Schreib-Haken für berechnete DIDs**: `ServerDid.write?: (payload) => number`, Zahl =
   NRC zur Ablehnung, `undefined` = angenommen. Mit Haken wird die Read-Closure **nicht**
   ersetzt — der Wert bleibt leben. Ohne Haken bleibt das bisherige Verhalten. Wirft der
   Haken: `generalReject` (0x10) plus Log; ein kaputter Transport darf keine unhandled
   rejection sein (ADR 0039 unverändert).
4. **Fehlerspeicher ist API, nicht Feld**: `setDtc(dtc)` (Upsert; deklarierte Felder
   bleiben, `status` gewinnt), `setDtcStatus` delegiert daran, `removeDtc(code)` (Alterung
   — bewusst nicht Clear, der Unterschied ist für einen Scan sichtbar) und
   `get dtcMemory`. `VirtualVehicle.setDtc`, `clearAllDtcs` und das Fahrzeugmodell
   schreiben ausschließlich darüber.
5. **Das virtuelle Netz deklariert, was es tut**: `impair(impairment): () => void`,
   `impairments`, `impairmentStats()`; die Busse halten ein `VirtualCanWire` (öffentlicher
   Typ mit `deliver`), beide Casts sind weg. Das Handle hebt die Störung auf, damit ein
   Szenario kein globalen Zustand hinterlässt.
6. **Der Simulator nutzt nur das.** `high-fidelity-vehicle.ts` und `virtual-vehicle.ts`
   enthalten kein `as unknown as` mehr. Verbleibende 36 Stellen (gemessen:
   `grep -rn "as unknown as" --include=*.ts packages apps tools tests | grep -v node_modules | grep -vc spec`)
   liegen in Spec-Dateien, die Stub-Double für Interfaces bauen — kein Produktionspfad,
   keine interne Map. Diese Klasse von Testdouble ist hier erlaubt und wird nicht als
   Erfolg verbucht; sie ist nur nicht dasselbe Problem.

## Was die Umstellung sofort fing

Der Simulator überschrieb mit seinem Map-Poke die DIDs 0x2001/0x2002, die im Paket **als
Signale** deklariert sind — Lesepfad und Skala kamen aus zwei Quellen. Nach der Umstellung
antwortet 0x2001 über `signalValue` → Modellwert → `encodeSignal` mit der Paket-Skala
(0,01 V/bit). Der Integrations-Test liest die Spannung über UDS und sieht genau den
Zahlenwert, auf den der Monitor reagiert hat; zwei offene Enden wurden ein Kreis.

Zweitens: die Lese-DIDs des Fahrzeugs (0x2001, 0x2002, 0x0100, 0x0101) sind jetzt
ausdrücklich **nicht** schreibbar (`registerDid` ohne `writable`). Ein Tester, der eine
Messung erfinden will, bekommt `conditionsNotCorrect` (0x22) statt eines still
überschriebenen Wertes — gepinnt durch
`apps/web`-nahen Spec `a measurement DID is read-only, so a write cannot freeze the cause away`.

## Konsequenzen

- `ServerDid`/`WritableServerDid` sind Teil des Simulator-Vertrags; Änderungen daran sind
  API-Änderungen.
- `dtcMemory` ist Leserechte; ein Test, der einer Fixture-ECU einen Code geben will, nutzt
  `setDtc`.
- Eine Biome-Regel gegen „Cast in eine Server-Map" wurde **nicht** eingeführt: eine Regel
  auf konkrete Feldnamen wäre ein zweites Vokabular für einen Satz, der in diesem ADR steht
  (vgl. ADR 0029/0031: eine Regel, eine Heimat). Der Hebel ist der Typ — Map privat, API
  öffentlich — und `npm run check:manifests` (ADR 0042) hält die Importgraph-Aussage
  darunter ehrlich.
