/**
 * Records the trace fixtures in `tests/fixtures/traces/` (AGENTS 31.5, ADR 0005).
 *
 * Why a recorder and not hand-written hex: a trace fixture is a *wire recording*,
 * and hand-written frames tend to be frames nobody would ever see (wrong SF_DL,
 * a First Frame whose length does not match its Consecutive Frames, a Flow
 * Control that answers nothing). This script runs the repository's own stack —
 * `UdsServer` behind an `IsoTpConnection`, a `UdsClient` in front of another one,
 * a virtual CAN wire in between — and writes every frame it sees, in both
 * directions, as a `candump -l` (SocketCAN) log.
 *
 * Deterministic by construction: the timestamps come from a virtual clock that
 * advances 1 ms per recorded frame (the Response-Pending trace advances by the
 * configured `pendingResponseDelayMs` instead), the ECU clock is the same virtual
 * clock, and the epoch base is a fixed constant. Re-running the script reproduces
 * the committed files byte for byte:
 *
 *   npm run build && node scripts/record-trace-fixtures.mjs && git diff --exit-code tests/fixtures/traces
 *
 * The replay side (`tests/integration/iso-tp-trace.spec.ts`) does *not* trust this
 * script: it checks each fixture against ISO 15765-2 structurally (SF_DL, FF_DL,
 * Consecutive Frame sequence numbers, block pacing) and asserts the reconstructed
 * UDS payloads against byte sequences written from ISO 14229-1, so a recorder bug
 * shows up as a red test instead of as a fixture that agrees with itself.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UdsClient, UdsServer } from "@vdp/protocols-uds";
import { createLogger, toHex } from "@vdp/shared";
import { IsoTpConnection } from "@vdp/transport-iso-tp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "tests", "fixtures", "traces");

/** Fixed epoch base so the recorded absolute timestamps never move: 2026-09-22T00:00:00Z. */
const BASE_EPOCH_MS = Date.UTC(2026, 8, 22);
const IFACE = "vcan0";
const TESTER_ID = 0x7e0;
const ECU_ID = 0x7e8;
/** Response-Pending gap the ECU of trace 3 leaves between NRC 0x78 and the real answer. */
const PENDING_GAP_MS = 25;

const logger = createLogger("trace-recorder", { level: "ERROR" });

const VIN = "1HGCM82633A004352";
const SPARE_PART = "03C906016K";
const ECU_SERIAL = "00 11 22 33";

const ascii = (text) => new TextEncoder().encode(text);
const hexBytes = (text) =>
  new Uint8Array(
    text
      .split(/\s+/)
      .filter(Boolean)
      .map((byte) => Number.parseInt(byte, 16)),
  );

/** One recorded frame: virtual-clock offset, identifier, payload, whose side it came from. */
const recording = [];
let clockMs = 0;

/**
 * Is this frame a Single Frame carrying `7F <sid> 78` (RequestCorrectlyReceived-
 * ResponsePending, ISO 14229-1 §9.3.2.2)? The NRC does not start at byte 0: a
 * Single Frame carries its length in the low PCI nibble, so the negative response
 * sits at bytes 1..3 — reading `payload[0] === 0x7f` here would miss every pending
 * frame that arrives segmented as a Single Frame, which is all of them.
 */
function isResponsePendingFrame(payload) {
  if ((payload[0] & 0xf0) !== 0x00) return false; // Single Frame PCI only
  return (payload[0] & 0x0f) === 3 && payload[1] === 0x7f && payload[3] === 0x78;
}

/** Advance the virtual clock; the pending gap is the one step that is not 1 ms. */
function advance(ms = 1) {
  clockMs += ms;
}

/**
 * Two `CanBus` nodes on one virtual wire. Every frame is recorded from the
 * tester's point of view (`tx` = tester sent it, `rx` = it arrived from the ECU),
 * which is what a `candump` on the tester's socket shows when the interface echoes
 * its own transmissions.
 */
function createWire() {
  const info = {
    id: "virtual",
    kind: "virtual",
    name: "Virtual CAN (recorder)",
    channels: [IFACE],
  };
  const capabilities = { can: true, canFd: false, doip: false, isoTpOffload: false, channels: 1 };
  /** Subscriber lists per side: "tx" is the tester's socket, "rx" the ECU's. */
  const listeners = new Map([
    ["tx", []],
    ["rx", []],
  ]);

  /** Record one frame, then hand it to the *other* node's subscribers. */
  function transmit(side, frame) {
    recording.push({
      t: clockMs,
      side,
      canId: frame.id,
      extended: frame.extended === true,
      payload: Uint8Array.from(frame.payload),
    });
    advance();
    // A Response-Pending answer is two messages separated by the ECU's own delay;
    // the virtual clock carries that gap so the replay can pace it (ADR 0005).
    if (frame.id === ECU_ID && isResponsePendingFrame(frame.payload)) {
      advance(PENDING_GAP_MS - 1);
    }
    for (const entry of listeners.get(side === "tx" ? "rx" : "tx")) {
      if (
        entry.filters &&
        !entry.filters.some((filter) => (frame.id & filter.mask) === (filter.id & filter.mask))
      ) {
        continue;
      }
      entry.listener({ ...frame, direction: "rx", timestamp: BASE_EPOCH_MS + clockMs });
    }
  }

  return {
    busFor(side) {
      const own = listeners.get(side);
      return {
        info,
        capabilities,
        async open() {},
        async close() {},
        isOpen: () => true,
        async send(frame) {
          transmit(side, frame);
        },
        subscribe(listener, filters) {
          const entry = { listener, ...(filters ? { filters } : {}) };
          own.push(entry);
          return () => {
            const index = own.indexOf(entry);
            if (index >= 0) own.splice(index, 1);
          };
        },
      };
    },
  };
}

const timing = { nAsMs: 0, nBsMs: 500, nCrMs: 500, stMinMs: 0, stMinTxMs: 0, blockSize: 0 };

/** Wire an ECU: ISO-TP node + `UdsServer` behind it. */
function createEcu(wire, options) {
  const bus = wire.busFor("rx");
  const connection = new IsoTpConnection(
    bus,
    {
      txId: ECU_ID,
      rxId: TESTER_ID,
      timing,
      sleep: async () => undefined,
      now: () => BASE_EPOCH_MS + clockMs,
    },
    logger,
  );
  connection.open();
  const server = new UdsServer(
    {
      onMessage: (listener) => connection.onUnsolicited(listener),
      send: (payload) => connection.sendOnly(payload),
    },
    { logger, clock: () => BASE_EPOCH_MS + clockMs, ...options },
  );
  server.start();
  return { connection, server };
}

/** Wire the tester: ISO-TP node + `UdsClient` in front of it. */
function createTester(wire) {
  const bus = wire.busFor("tx");
  const connection = new IsoTpConnection(
    bus,
    {
      txId: TESTER_ID,
      rxId: ECU_ID,
      timing,
      sleep: async () => undefined,
      now: () => BASE_EPOCH_MS + clockMs,
    },
    logger,
  );
  connection.open();
  const client = new UdsClient(connection, {
    name: "engine-gateway",
    logger,
    timing: { p2Ms: 50, p2StarMs: 5000 },
  });
  return { connection, client };
}

const baseDids = [
  { did: 0xf190, value: () => ascii(VIN) },
  { did: 0xf187, value: () => ascii(SPARE_PART) },
  { did: 0xf18c, value: () => hexBytes(ECU_SERIAL) },
];

/** Frames of one trace, recorded between two `resetRecording()` calls. */
function resetRecording() {
  recording.length = 0;
  clockMs = 0;
}

/** candump -l line: `(<epoch>.<µs>) <iface> <id>#<data hex, uppercase>`. */
function toCandump(entry) {
  const seconds = (BASE_EPOCH_MS + entry.t) / 1000;
  const id = entry.canId
    .toString(16)
    .toUpperCase()
    .padStart(entry.extended ? 8 : 3, "0");
  const data = toHex(entry.payload).replaceAll(" ", "").toUpperCase();
  return `(${seconds.toFixed(6)}) ${IFACE} ${id}#${data}`;
}

function writeTrace(file, title, provenance, structure) {
  const header = [
    `# ${file}`,
    `# ${title}`,
    "#",
    "# Herkunft (provenance):",
    ...provenance.map((line) => `#   ${line}`),
    "#",
    "# Format: candump -l (SocketCAN-Log) —",
    '#   "(<epoch-sekunden>.<mikrosekunden>) <interface> <can-id>#<daten als hex>"',
    "#   Zeilen mit '#' in Spalte 1 sind Kommentare, Leerzeilen werden übersprungen.",
    "#   11-bit-Identifier (CAN 2.0A), MTU 8, kein CAN FD, kein Padding.",
    "#   Das Log ist eine Bus-Aufnahme aus Sicht des Testers: 0x7E0 = Tester (tx),",
    "#   0x7E8 = Steuergerät (rx).",
    "#",
    "# Aufbau (structure):",
    ...structure.map((line) => `#   ${line}`),
    "#",
    "# Reproduzieren: npm run build && node scripts/record-trace-fixtures.mjs",
    `# Zeitbasis: virtuelle Uhr, 1 ms Raster, Epoche ${new Date(BASE_EPOCH_MS).toISOString()};`,
    `#   die Response-Pending-Lücke ist die konfigurierte pendingResponseDelayMs (${PENDING_GAP_MS} ms).`,
  ];
  const body = recording.map(toCandump);
  writeFileSync(join(outDir, file), `${header.join("\n")}\n${body.join("\n")}\n`);
  // The span the log itself shows (last frame offset), not the virtual clock —
  // that is the number a reader of the fixture can verify line by line.
  console.log(`${file}: ${body.length} frames, ${recording.at(-1)?.t ?? 0} ms`);
}

async function recordSingleFrame() {
  resetRecording();
  const wire = createWire();
  const ecu = createEcu(wire, {
    name: "engine-gateway",
    timing: { p2Ms: 50, p2StarMs: 5000, s3Ms: 5000 },
    dids: baseDids,
  });
  ecu.server.registerDid({
    did: 0xf186,
    value: () => Uint8Array.of(ecu.server.sessions.sessionType),
  });
  const tester = createTester(wire);

  await tester.client.testerPresent(true);
  await tester.client.diagnosticSessionControl(0x03);
  await tester.client.readDid(0xf186);

  tester.connection.close();
  ecu.connection.close();
  writeTrace(
    "single-frame-uds.log",
    "Single-Frame-UDS: TesterPresent, DiagnosticSessionControl, ReadDataByIdentifier",
    [
      "Aufgenommen mit `scripts/record-trace-fixtures.mjs` aus dem Stack dieses",
      "Repositorys: `UdsServer` (Paket @vdp/protocols-uds) hinter einer",
      "`IsoTpConnection` (@vdp/transport-iso-tp), davor ein `UdsClient` über einer",
      "zweiten Verbindung, verbunden durch einen virtuellen CAN-Draht. Kein reales",
      "Fahrzeug und keine reale Hardware — die Bytes sind echte Wire-Bytes der",
      "Referenzimplementierung, nicht abgetippt (ADR 0005: Simulator statt Auto).",
      "Steuergerät: 'engine-gateway', DIDs 0xF186/0xF187/0xF18C/0xF190, Timing",
      "P2 = 50 ms, P2* = 5000 ms, S3 = 5000 ms.",
    ],
    [
      "Drei Transaktionen, jede Antwort passt in einen Single Frame (SF_DL ≤ 7):",
      "  1. 0x7E0  02 3E 80            TesterPresent, suppressPositiveResponse → keine Antwort",
      "  2. 0x7E0  02 10 03            DiagnosticSessionControl → extendedDiagnosticSession",
      "     0x7E8  06 50 03 00 32 01 F4  positive Antwort mit P2 = 0x0032 (50 ms) und",
      "                                  P2* = 0x01F4 (500 × 10 ms = 5000 ms)",
      "  3. 0x7E0  03 22 F1 86         ReadDataByIdentifier ActiveDiagnosticSession",
      "     0x7E8  04 62 F1 86 03      Antwort: Session 0x03 ist aktiv",
    ],
  );
}

async function recordMultiFrame() {
  resetRecording();
  const wire = createWire();
  const ecu = createEcu(wire, { name: "engine-gateway", dids: baseDids });
  const tester = createTester(wire);

  await tester.client.readDid(0xf190); // VIN, 17 Zeichen → 20 Byte Antwort
  await tester.client.readDid(0xf187); // Ersatzteilnummer, 10 Zeichen → 13 Byte Antwort

  tester.connection.close();
  ecu.connection.close();
  writeTrace(
    "multi-frame-read-data-by-identifier.log",
    "Multi-Frame-ReadDataByIdentifier: VIN (0xF190) und Ersatzteilnummer (0xF187)",
    [
      "Aufgenommen mit `scripts/record-trace-fixtures.mjs` aus dem Stack dieses",
      "Repositorys (UdsServer + zwei IsoTpConnection-Knoten auf einem virtuellen",
      "Draht); kein reales Fahrzeug. Steuergerät 'engine-gateway' mit den DIDs",
      "0xF187 (Spare Part Number, 10 ASCII-Zeichen) und 0xF190 (VIN, 17",
      "ASCII-Zeichen) — beide Antworten sind länger als 7 Byte und müssen daher",
      "segmentiert werden (ISO 15765-2 §9.5/§9.6).",
    ],
    [
      "Transaktion 1 — VIN, 20 Byte Nutzlast (0x14):",
      "  0x7E0  03 22 F1 90              Single Frame, ReadDataByIdentifier 0xF190",
      "  0x7E8  10 14 62 F1 90 31 48 47  First Frame, FF_DL = 0x014 = 20, 6 Datenbytes",
      "  0x7E0  30 00 00                 Flow Control: ContinueToSend, BS = 0, STmin = 0",
      "  0x7E8  21 43 4D 38 32 36 33 33  Consecutive Frame, SN = 1",
      "  0x7E8  22 41 30 30 34 33 35 32  Consecutive Frame, SN = 2 — Nachricht komplett",
      "Transaktion 2 — Ersatzteilnummer, 13 Byte Nutzlast (0x0D):",
      "  0x7E0  03 22 F1 87              Single Frame, ReadDataByIdentifier 0xF187",
      "  0x7E8  10 0D 62 F1 87 30 33 43  First Frame, FF_DL = 13, 6 Datenbytes",
      "  0x7E0  30 00 00                 Flow Control: ContinueToSend, BS = 0, STmin = 0",
      "  0x7E8  21 39 30 36 30 31 36 4B  Consecutive Frame, SN = 1 — Nachricht komplett",
    ],
  );
}

async function recordResponsePending() {
  resetRecording();
  const wire = createWire();
  const ecu = createEcu(wire, {
    name: "engine-gateway",
    dids: baseDids,
    pendingResponseServices: [0x22],
    pendingResponseDelayMs: PENDING_GAP_MS,
  });
  const tester = createTester(wire);

  await tester.client.readDid(0xf18c);

  tester.connection.close();
  ecu.connection.close();
  writeTrace(
    "response-pending.log",
    "Response-Pending-Sequenz: NRC 0x78, dann die echte positive Antwort nach P2*-Wartezeit",
    [
      "Aufgenommen mit `scripts/record-trace-fixtures.mjs` aus dem Stack dieses",
      "Repositorys (UdsServer mit pendingResponseServices = [0x22] und",
      `pendingResponseDelayMs = ${PENDING_GAP_MS} hinter einer IsoTpConnection, davor ein`,
      "UdsClient); kein reales Fahrzeug. Das Steuergerät 'engine-gateway' meldet",
      "für ReadDataByIdentifier erst RequestCorrectlyReceivedResponsePending und",
      "antwortet dann — das ist ISO 14229-1 §9.3.2.2 mit dem P2*-Fenster aus",
      "ISO 14229-2 §7.4: zwei Nachrichten, nicht eine verspätete.",
      "Bewusst kein TesterPresent innerhalb der Pending-Lücke: ein Keep-Alive-Frame",
      "zwischen 0x78 und der echten Antwort gehört in ein eigenes Trace-Beispiel",
      "(die Lücke ist hier die des Steuergeräts, nicht die des Testers).",
    ],
    [
      "  0x7E0  03 22 F1 8C        Single Frame, ReadDataByIdentifier ECU Serial Number",
      "  0x7E8  03 7F 22 78        Negative Response: NRC 0x78 requestCorrectlyReceived-",
      "                            ResponsePending — ab hier läuft P2*Client_max, nicht P2",
      `  0x7E8  07 62 F1 8C 00 11 22 33   (+${PENDING_GAP_MS} ms) Single Frame, die echte Antwort:`,
      "                            62 F1 8C mit 4 Byte Seriennummer",
      "Erwartung an den Client: exakt eine Antworttransaktion, ein Pending-Zähler, und",
      `die finale Antwort innerhalb von P2* (${PENDING_GAP_MS} ms ≪ 5000 ms) — kein Timeout, kein`,
      "zweiter Request auf dem Draht.",
    ],
  );
}

mkdirSync(outDir, { recursive: true });
await recordSingleFrame();
await recordMultiFrame();
await recordResponsePending();
console.log(`recorded 3 traces into ${outDir.replace(`${root}/`, "")}`);
