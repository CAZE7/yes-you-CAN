# Flow: Recording & Replay (eine Sitzung ist eine Wiedergabe)

> Pipeline: `CAN-Frame → RawTraceEntry (NDJSON) → Session-Archiv →
> ReplayBus → echter Core → IR-Vergleich`.

## Aufnahme (in jeder realen oder simulierten Session)

```text
CanBus (Adapter oder VirtualVehicle.testerBus)
  │  subscribe() — jeder Frame, vor und nach der Dekodierung
  ▼
@vdp/core (logging/session-logger.ts)   SessionLogger
  ├─ VehicleSessionData: session, ecus, dtcSnapshots, measurements, markers
  ├─ RawTraceEntry: { ts, id, data (hex), direction }   (NDJSON-Zeile, ADR 0004)
  └─ Messwerte: SamplePoint[] pro Signal (raw + value + unit)
  ▼
@vdp/storage (repository.ts, zip.ts, migrations.ts)
  ├─ SessionRepository.save(): JSON + NDJSON, versioniert (SESSION_SCHEMA_VERSION)
  ├─ Migrations: alte Schemas werden hochgemigriert, nie verworfen (ADR 0007)
  └─ ZIP-Export: deterministisches Archiv für Übergabe
```

## Replay (der Punkt des ganzen Mechanismus)

```text
Aufgenommenes Archiv (Datei oder Golden-Session-Fixtur)
  ▼
parseTraceLines() / parseSampleLines()   (@vdp/storage)
  ▼
ReplayBus / Time-Travel                   (@vdp/transport-can: replay.ts, time-travel.ts)
  │  liefert die Frames zeitlich exakt wie damals, als CanBus
  ▼
DiagnosticEngine (derselbe Code wie live)
  ├─ Discovery, Session, DTC-Scan, Messwerte — gegen den Replay-Stream
  ▼
IR: DtcObservation / SignalReading / SessionObservation (mit Provenance)
  ▼
Vergleich im IR-Vokabular:
  - Golden Sessions (tools/golden-sessions): Erwartung vs. Replay → diff
  - tests/replay: Fixture-driven Regressionen (z. B. abgeschnittene Antwort
    muss denselben Fehler produzieren wie damals, ADR 0039)
```

**Wichtige Kanten:**

- **Replay fährt den echten Core** — kein zweites „Replay-Protokoll“
  (ADR 0005). Der Unterschied zu live: nur der Bus ist virtuell.
- **Rohdaten sind der Vertrag:** ohne `RawTraceEntry` ist eine Session nicht
  replaybar (Workbench-Regel: Replay-Absage ohne Roh-Trace, ADR 0004).
- **Golden Session = Aufzeichnung + Erwartung + Lauf** (ADR 0036):
  `npm run golden:record` nimmt gegen den Simulator auf, replays über den
  Core und vergleicht in IR-Form. Erwartung und Aufnahme sind *Daten*.
- **Time-Travel statt Sleep:** Tests warten auf Bedingungen
  (`tests/helpers/wait.ts`, ADR 0019), nie auf eine Zeitscheibe.
- **Schema-Änderungen** laufen als Migration mit Version — alte Archive
  bleiben lesbar (Regel 34.14).

**Zugehörig:** [`tests/replay/`](../../tests/replay/),
[`tools/golden-sessions/`](../../tools/golden-sessions/),
[`tests/examples/simulator-scenario.example.ts`](../../tests/examples/simulator-scenario.example.ts).
