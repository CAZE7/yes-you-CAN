# Lese-Paket: Workflows („wie laufe ich das System?“)

**Zweck:** Die Pipeline-Karten — was wo hindurchläuft, von CAN-Frame bis
Analyse.

## Lese-Liste nach Änderungstyp

| Du änderst … | Lies den Flow |
|---|---|
| einen Lese-Weg (DID, Signal, Session) | [`../docs/flows/diagnostic-read.md`](../docs/flows/diagnostic-read.md) |
| einen Write (Clear, Coding, Adaptation) | [`../docs/flows/diagnostic-write.md`](../docs/flows/diagnostic-write.md) |
| DTC-Scan, -Wissen, -Enrichment | [`../docs/flows/dtc-analysis.md`](../docs/flows/dtc-analysis.md) |
| Recording, Replay, Golden Sessions | [`../docs/flows/recording-replay.md`](../docs/flows/recording-replay.md) |
| Analyse, Provider, Zitate, Versionen | [`../docs/flows/ai-analysis.md`](../docs/flows/ai-analysis.md) |
| ein Fahrzeug read-only auslesen (Ernte, ODX/PDX, Definitions-Kandidat) | [`../docs/flows/harvest.md`](../docs/flows/harvest.md) |

## Ausführung (Befehle, die funktionieren — AGENTS 0.B)

```bash
npm ci && npm run build && npm run typecheck   # Kompilierung + strikter noEmit
npm run check                                  # biome (Lint + Format)
npm run check:deps && npm run check:manifests  # Architektur-Gates
npm run test:unit                              # schnelle Schleife
npm test                                       # 6 Ebenen (unit … architecture)
npm run test:coverage                          # Coverage-Gates
npm run ci                                     # alles in einem Tor
npm run demo                                   # Workbench + Simulator (8080)
npm run ai:context <topic>                     # AI-Kontext-Bundle
```

## Die drei Standard-Pfade (jeder hat ein ausführbares Beispiel)

1. **Read:** `tests/examples/diagnostic-read.example.ts`
2. **DTC-Analyse:** `tests/examples/dtc-analysis.example.ts`
3. **Evidence → AI:** `tests/examples/evidence-flow.example.ts`
4. **Simulator-Szenario:** `tests/examples/simulator-scenario.example.ts`

Lese ein Beispiel, bevor du API-Code neu zusammensuchst — das ist der
Sinn der Datei („so wird diese API benutzt“).
