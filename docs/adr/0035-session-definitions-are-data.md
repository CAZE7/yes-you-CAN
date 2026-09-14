# ADR 32 — Sitzungsdefinitionen sind Daten, die Zustandsmaschine ist ein Modul

- Status: akzeptiert (2026-09-14)
- Kontext: ISO 14229-1 §10.2 (DiagnosticSessionControl, Sitzungsübergänge), ISO 14229-2 §7 (S3Server), AGENTS 9/12 (UDS-Semantik), Master-Backlog P0 #9
- Betrifft: `packages/protocols/uds/src/session-state.ts` (neu), `packages/protocols/uds/src/server.ts`, `packages/protocols/uds/src/index.ts`, `tools/simulators/src/virtual-vehicle.ts`, `tests/protocol/uds-conformance.test.ts` (neu), `packages/protocols/uds/src/session-state.spec.ts` (neu)

## Problem

Das Sitzungs-Gating war im `UdsServer` **Code, nicht Konfiguration**, und es war
über den Dispatch verstreut:

1. **Welche Sitzung gibt es?** `sessions?: readonly number[]` war eine Liste von
   Zahlen. Sie sagte nicht, wie eine Sitzung heißt, aus welcher sie erreichbar
   ist, welche Dienste sie erlaubt und welche Zeitparameter sie hat.
2. **Was darf eine Sitzung?** Jeder Dienst prüfte für sich
   (`if (this.sessions.includes(...))`, verteilt über die Handler). Damit war die
   Antwort auf „darf ich in Sitzung X löschen?“ eine Suche über hundert Zeilen.
3. **Übergänge existierten nicht.** Ein `0x10 0x02` (Programming) wurde aus der
   Default-Sitzung heraus genauso positiv beantwortet wie aus der erweiterten —
   ein ECU, das eine nicht definierte Transition annimmt, landet in einem Zustand,
   den niemand vorgesehen hat. ISO 14229-1 §10.2 verlangt hier
   `conditionsNotCorrect` (0x22).
4. **S3 war ein Timer-Afterthought.** Der Ablauf der Sitzung (S3Server, ISO
   14229-2 §7) fiel an einzelnen Stellen an, statt an genau einer.
5. **Der Simulator hatte eine eigene Meinung.** Er benutzte dieselbe Liste, aber
   „welche Sitzung welche Dienste erlaubt“ war an keiner Stelle beschrieben — die
   Testumgebung konnte also still großzügiger sein als ein echtes Steuergerät.

## Entscheidung

1. **Eine Sitzung ist ein Datenrecord.** `SessionDefinition` beschreibt `type`
   (Subfunktion), `name` (für Log/Diagnose/NRC-Text), `from` (erlaubte
   Ausgangssitzungen), `services` (erlaubte Dienste; fehlt die Liste, ist alles
   erlaubt, was das ECU überhaupt anbietet), `p2Ms`/`p2StarMs`/`s3Ms`
   (Zeitparameter, fallen sonst auf die ECU-Timing-Werte zurück). Die
   Standard-Sätze sind Funktionen und kein Objekt im Server:
   `defaultSessionDefinition()`, `extendedSessionDefinition()`,
   `programmingSessionDefinition()` (nur aus `[EXTENDED]` erreichbar),
   `standardSessions()` und `simulatorSessions()`.

2. **Die Zustandsmaschine ist ein eigenes Modul.** `SessionStateMachine` kennt den
   aktiven Typ, die Aktivität (für S3), `request()` (Übergang), `reset()`,
   `activity()`, `tick()` und die eine Frage, die der Dispatch stellt:
   `serviceRefusal(sid) → NRC | null`. Der Server ruft sie **pro Request** auf,
   bevor er einen Handler ausführt; Handler bleiben reine Fachlogik.

3. **Unbekannt ist nicht dasselbe wie verboten.**
   - Sitzungstyp nicht definiert → `subFunctionNotSupported` (0x12), die NRC
     nennt die definierten Typen.
   - Typ definiert, aber aus der aktuellen Sitzung nicht erreichbar →
     `conditionsNotCorrect` (0x22), die Sitzung bleibt unverändert.
   - Dienst implementiert, aber in dieser Sitzung nicht erlaubt → `0x7F`
     (`serviceNotSupportedInActiveSession`).
   - Dienst **nicht** implementiert → `0x11` (`serviceNotSupported`), in jeder
     Sitzung. Die Zustandsmaschine antwortet darauf nie „nicht erlaubt“ — wer
     `0x11` verdient, darf nicht als Sitzungsproblem erscheinen.

4. **Lesen und Schreiben sind getrennt.** Die Default-Sitzung erlaubt die
   Lese-/Session-Dienste (`0x10`, `0x11`, `0x19`, `0x22`, `0x3E`); die
   schreibenden Dienste (`0x14`, `0x27`, `0x2E`, `0x31`) sind erst in einer
   Nicht-Default-Sitzung erlaubt. Ein Tester **muss** also eine Sitzung
   anfordern, bevor er löscht — genau die Information, die ein Diagnosegerät aus
   `0x7F` zusätzlich bekommt.

5. **S3 an genau einer Stelle.** Jede Anfrage ist Aktivität; `tick()` (aus
   `handle()`) setzt eine abgelaufene Sitzung auf den Default zurück. Ein
   ECU-Reset ist ein Sitzungswechsel auf Default.

6. **Der Simulator benutzt dieselben Definitionen.** `simulatorSessions()` ist
   das, was `VirtualVehicle` seinen ECUs gibt — die Testumgebung kann nicht
   großzügiger sein als die ECU, weil es derselbe Code ist.

## Konsequenzen

- **Der Conformance-Test hat jetzt eine Form statt einer Meinung:**
  `tests/protocol/uds-conformance.test.ts` fährt **eine** Tabelle von Regeln
  gegen **zwei** Backends — den `UdsServer` direkt und den virtuellen Wagen über
  virtuelles CAN + ISO-TP. 48 Tests: 10 Dienst-×-Sitzungsfälle, 9 Übergänge, S3
  (mit injizierter Uhr), `0x78`-Paar, ECU-Reset und Definition-Fixtures.
  Ein Backend, das die Regeln bricht, fällt hier auf — nicht erst im Fahrzeug.
- **Bestehende Tests waren der Prüfstein, nicht das Opfer.** Die Teständerungen
  in `server.spec.ts`, `client.spec.ts` und `regression.test.ts` sind
  Konsequenzen der Regel (`0x7F` statt Dienstantwort in der Default-Sitzung, ein
  Regressionstest fragt zuerst `0x7F` und dann `0x13` in der erlaubten Sitzung).
  Die Regel wurde nicht aufgeweicht, um Tests zu retten.
- **Ein Fehler wurde dabei sichtbar:** der Test „ohne `securityAccess`-Konfiguration
  ist 0x27 nicht implementiert“ war grün aus dem falschen Grund (er prüfte Byte 2
  des Seeds) — ein geteiltes Test-Harness kann „Dienst fehlt“ maskieren. Er ist
  jetzt gegen ein nacktes `UdsServer` ohne Harness-Defaults geschrieben.
- **`securityAccess` ist weiter eine Option, keine Sitzung:** ohne sie bleibt
  `0x27` ein nicht implementierter Dienst (0x11) — auch in der erweiterten
  Sitzung. Das ergibt sich jetzt aus der Dienste-Tabelle des Servers, nicht aus
  einem Sonderfall in der Sitzungslogik.
- **Was offen bleibt:** `0x85` (ControlDTCSetting) und `0x2F`
  (InputOutputControlByIdentifier) sind in `WRITE_SERVICES` der Maschine
  vorgesehen, aber der Server registriert sie noch nicht — sie werden mit
  ihrem Handler aktiv, nicht per Sichtbarkeits-Flag.
