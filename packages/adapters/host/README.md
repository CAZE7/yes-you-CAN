# `@vdp/adapter-host`

**Layer:** adapter · **Pfad:** `packages/adapters/host/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../../architecture/architecture.yaml)

## Purpose

Der Host-Adapter: alles, was mit dem *Host* zu tun hat — Serial-TTY-Zugriff
(`serial.ts`), der **seitenefektfreie Probing-Katalog** (`catalog.ts`) und
die Adapter-Auswahl (`selection.ts`). Die Workbench fragt dieses Paket:
„was ist auf dieser Maschine verfügbar, und was wurde gewählt?“.

## Responsibilities

- Serial-Stream für ELM327/CANable (`serial.ts`, `node:`-Tty)
- Probing-Katalog: `AdapterCatalog` + `createHostAdapterCatalog()` — alle
  Adapter mit `AdapterEntry`/`AdapterDescription` und `AdapterProbe`
  (Nebenwirkungsfrei: kein Öffnen von Interfaces, kein Schreiben)
- Adapter-Auswahl: `parseAdapterArgv`, `validateSelection`,
  `selectionFromPayload`, `DEFAULT_ADAPTER_ID = "simulator"` (`selection.ts`)
- Bitrate-Wissen: `ELM327_DEFAULT_BAUD`, `SLCAN_DEFAULT_BAUD`, `supportedBitrates()`
- **Adapter-Doctor** (`doctor.ts`): die Vorab-Checkliste für den Hardware-Tag —
  Einstellungen → Verfügbarkeit → Öffnen/Handshake (Firmware) →
  Fahrzeugspannung → funktionaler, read-only TesterPresent-Ping; CLI
  `npm run adapter:doctor` (apps/web `doctor-cli.ts`), Exit 0/2/3
- **SocketCAN-Fallback** (`socketcan-fallback.ts`): `/sys/class/net`-Wahrheit
  (Existenz, ARPHRD_CAN = 280, `operstate`) plus die Auflösungskette
  natives Modul → can-utils (candump/cansend, ein Prozess pro Frame — benannt).
  Klassisches CAN **und** CAN-FD reisen (`#`/`##`-Form, BRS = Bit 0 der
  Flags-Ziffer nach `linux/can.h`); CAN-FD am SocketCAN-Adapter wird mit
  `--can-fd` opt-in geschaltet, nie vermutet.

## Does NOT do

- keine Protokoll-(UDS)-Logik, keine Core-Kenntnis (Layer-Regel)
- keine Diagnose-Orchestrierung: es meldet Verfügbarkeit, die Workbench
  entscheidet
- keine versteckten Probes: ein `AdapterProbe`, der ein Interface öffnet
  oder schreibt, ist ein Defekt

## Public API

`src/index.ts`: `catalog.ts`, `selection.ts`, `serial.ts` komplett
(`AdapterCatalog`, `createHostAdapterCatalog`, `AdapterEntry`,
`parseAdapterArgv`, `validateSelection`, `selectionFromPayload`, …).

## Dependencies

`@vdp/shared`, `@vdp/transport-can` und die peer-Adapter
(`canable`, `elm327`, `socketcan`).

## Data Flow

```text
Workbench (apps/web/src/adapters.ts)
  → createHostAdapterCatalog() → AdapterEntry-Liste (+ Probes)
  → validateSelection/selectionFromPayload → CanFactory-Create (peer-Adapter)
```

## Important invariants

- **Einziges Adapter-Paket mit `node:`-Builtins** (Regel in
  `architecture.yaml`; die anderen Adapter halten sich sauber) — das ist
  *der* Host-Kontakt der Plattform.
- **Probing ohne Nebenwirkungen** (`catalog.ts` gemessen 100/95, Gate 92/78).

## Tests

Co-lokatierte `src/*.spec.ts` (injizierter Binding, gewöhnliche Datei als
Serial-Ersatz — ADR 0016).

## Examples

```ts
import { createHostAdapterCatalog, validateSelection } from "@vdp/adapter-host";

const catalog = createHostAdapterCatalog();
const selection = validateSelection(catalog, { id: "elm327" }); // was ist verfügbar?
```
