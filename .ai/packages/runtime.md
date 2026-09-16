# Lese-Paket: `@vdp/runtime`

**Zweck:** Die Kompositions-Wurzel — Services, Command Bus, Events, Audit.

## Lese-Liste

1. [`../../packages/runtime/README.md`](../../packages/runtime/README.md).
2. [`../../docs/api/runtime.md`](../../docs/api/runtime.md) — die
   vollständige Public-API (Services, Command Bus, `evidence`, `writes`,
   `audit`, `dispose`).
3. ADR 0014 (domain/application/runtime), 0038 (Evidence an einer
   Stelle), 0032 (WritePort), 0023/0026 (Fahrzeugauflösung).
4. Beispiel: [`../../tests/examples/diagnostic-read.example.ts`](../../tests/examples/diagnostic-read.example.ts)
   (ganze Plattform über die Application-API).

## Die Regeln, die du nicht brechen darfst

1. **Headless:** kein HTTP, kein DOM, kein UI-Toolkit — die App ist eine
   Projektion (ADR 0014/0006, maschinell).
2. **Public Surface = Services + Command Bus** — die Engine ist internes
   Detail; nichts außerhalb des Runtime greift in sie (ADR 0014).
3. **Evidenz: eine Stelle** — `runtime.evidence` (ADR 0038).
4. **Writes: eine Tür** — `runtime.writes` (ADR 0032).
5. **Transport-Seam:** `linkFactory` erlaubt DoIP/Custom ohne Core-
   Änderung (AGENTS 5/36).
6. **Events für jeden Schritt** — der Audit-Trail ist die
   Rekonstruktionsbasis (AGENTS 10); ein neuer Service-Pfad publiziert
   seine Events.

## Häufige Aufgaben

- Neue Client-Fähigkeit: Command/Query in `@vdp/application` + Handler in
  `handlers.ts` (Code-Map-Zeile).
- Neue Service-Methode: `services.ts` + Event + Test in
  `tests/integration/runtime.test.ts`.
- Kontext-Bundle: `npm run ai:context diagnostic-ir`
