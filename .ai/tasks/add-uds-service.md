# Task: UDS-Service hinzufügen

**Kontext:** [`npm run ai:context uds`](../README.md) erzeugt das Bundle.
Regeln: [`.ai/contracts/uds.md`](../contracts/uds.md), ADR 0013/0039/0041.

## Schritte

1. **Service-Id + Semantik festhalten:** `packages/protocols/uds/src/services.ts`
   (`SID`-Konstante; ISO-14229-Nummer im Kommentar, Regel 34.18).
2. **Client-Methode:** `packages/protocols/uds/src/client.ts` — Request-
   Bau, Response-Parsing, NRC-Handling (0x78 = Retry/Zeitbudget, andere
   NRCs = Fehler *mit Grund*, ADR 0018). `client.spec.ts` erweitern:
   positiv, negativ (NRC), abgeschnittene Antwort (ADR 0039).
3. **Server-Seite (Simulator):** `packages/protocols/uds/src/server.ts` —
   die Antwort-Logik hinter der Server-API (ADR 0041: `registerDid`/
   `registerRoutine` o. Ä., *nie* Casts in interne Maps).
4. **Kern-Orchestrierung (falls der Service Teil einer Diagnose-Aktion
   ist):** `packages/core/` (Engine/Service) — die Engine bleibt die
   Orchestrierung, der Protokoll-Layer bleibt der Draht.
5. **Application-Layer (falls ein Client es anstoßen kann):**
   `packages/application/src/commands.ts` + Handler im
   `packages/runtime/src/handlers.ts`.
6. **Definitionen (falls der Service an OEM-Wissen hängt):**
   `packages/definitions/` (Daten + Provenance, ADR 0003).
7. **Doku im selben PR (Regel 34.24):**
   - `docs/api/uds.md` (neuer Symbol-Eintrag),
   - `docs/flows/diagnostic-read.md` (falls der Lese-Pfad sich ändert),
   - Package-README `packages/protocols/uds/README.md`,
   - ADR, falls die Entscheidung architektonisch ist (Regel 34.15).
8. **Tor:** `npm run check:deps && npm run check:manifests && npm test`
   (Projekt `protocol` ist die Konformanz-Suite).

## Stop-Signale (Review-Blockade)

- `CanBus`-Import in `packages/protocols/uds/` → falsche Schicht.
- Zweite NRC-/DTC-Status-Logik → Glossar „Verbotene Doppelnamen“.
- Simulator-Test, der ein Server-Feld liest statt des Drahts (ADR 0040).
- Neue Dependency für „ein Byte-Parsing“ → `@vdp/shared` hat es schon.
