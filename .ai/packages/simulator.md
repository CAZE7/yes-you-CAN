# Lese-Paket: Simulator & Replay

**Zweck:** Das virtuelle Fahrzeug — Verhaltensmodell, Szenarien,
Fault-Injection, Golden Sessions.

## Lese-Liste

1. [`../../tools/simulators/README.md`](../../tools/simulators/README.md)
   und [`../../tools/golden-sessions/README.md`](../../tools/golden-sessions/README.md).
2. [`../../docs/flows/recording-replay.md`](../../docs/flows/recording-replay.md).
3. ADRs: 0005 (Simulator & Replay), 0036 (Golden Sessions), 0039
   (Fault-Injection an der Link-Seam), 0040 (Verhaltensmodell + Szenario-
   Engine), 0041 (UDS-Server-API für Simulatoren), 0046 (Szenariodateien),
   0048 (die Dateien unter `scenarios/` **sind** der Katalog).
4. Das E2E-Beispiel: [`../../tests/integration/scenario-chain.test.ts`](../../tests/integration/scenario-chain.test.ts)
   und [`../../tests/examples/simulator-scenario.example.ts`](../../tests/examples/simulator-scenario.example.ts).

## Die Regeln, die du nicht brechen darfst

1. **Antwort über den Draht** (ADR 0040): der Simulator antwortet als ECU
   über CAN/ISO-TP/UDS — Tests poken nie Simulator-Felder direkt
   (`vehicle.dtcMemory` etc.), sie lesen den Scan.
2. **`runScenario` assertet nie** — er liefert `ScenarioRun`
   (checks, unexpected, passed, timeline); das Urteil gehört in den Test.
3. **UDS-Server-API für alles** (ADR 0041): `registerDid`,
   `registerWritableDid`, `setDtc` — Casts in interne Maps sind verboten.
4. **Fault-Injection sitzt an der Link-Seam** (ADR 0039) — die Plattform
   muss den Schaden sehen wie an einem echten Bus.
5. **Determinismus als Kette:** der Seed der Szenariodatei läuft bis in den
   Lauf (`runScenario(…, { seed })`, `lastScenario` → `AnalysisInput`);
   Modellzeit statt Wanduhr; Warten auf Bedingungen
   (`tests/helpers/wait.ts`), nie fixen Sleeps.
6. **Golden Sessions sind Daten** (ADR 0036): Aufzeichnung + Erwartung +
   Lauf; der Vergleich läuft im IR-Vokabular über den echten Core.

## Weiter

- Kontext-Bundle: `npm run ai:context simulator`
- UDS-Server-Details: [`.ai/contracts/uds.md`](../contracts/uds.md)
