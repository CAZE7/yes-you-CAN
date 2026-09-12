/**
 * Host adapter catalog (AGENTS 4, 29).
 *
 * AGENTS 4 lists the adapters the platform must be able to use; this module is
 * the place where a *running application* finds out which of them exist on the
 * current machine and how to open one. It is host glue, not protocol logic: the
 * adapters themselves stay free of device paths, baud rates and `stty`.
 *
 * Two rules make it usable rather than decorative:
 *
 * 1. **Probing is side-effect free.** `probe()` may look at device nodes or try
 *    to load an optional binding, but it never opens a bus or writes a byte.
 *    A UI can therefore list adapters without disturbing a vehicle.
 * 2. **Requirements are declared, not discovered.** Missing settings fail with
 *    an actionable message (`--device=/dev/ttyUSB0`) instead of a stack trace
 *    from three layers below.
 *
 * The catalog is open for registration so that the application — which owns the
 * layers above the adapter layer — can add the simulator and the trace replay
 * without the adapter package depending on them (AGENTS 34.2).
 */

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { BITRATES, CanableAdapter } from "@vdp/adapter-canable";
import { Elm327Adapter } from "@vdp/adapter-elm327";
import {
  SocketCanAdapter,
  type SocketCanBinding,
  tryLoadSocketCanBinding,
} from "@vdp/adapter-socketcan";
import {
  AdapterUnsupportedError,
  type Logger,
  TransportError,
  createLogger,
  messageOf,
} from "@vdp/shared";
import type {
  AdapterCapabilities,
  CanBus,
  CanFilter,
  CanFrame,
  FrameListener,
} from "@vdp/transport-can";
import { type SerialByteStream, configureSerialPort, openSerialStream } from "./serial.js";

/**
 * Where an adapter sits physically. The UI groups by this: serial devices need a
 * port, network adapters need a channel, `virtual` means "no hardware involved".
 */
export type AdapterKind = "serial" | "socketcan" | "simulator" | "replay";

export interface AdapterConfig {
  /** Serial device path, e.g. `/dev/ttyUSB0`. */
  device?: string;
  /** CAN channel/interface name, e.g. `can0`. */
  channel?: string;
  /** Classic CAN bitrate key, e.g. `500k` (slcan only; SocketCAN configures bit timing in the kernel). */
  bitrate?: string;
  /** Serial line speed in bit/s. */
  baudRate?: number;
  /** Trace file for the replay adapter. */
  trace?: string;
  /** slcan listen-only mode — useful to observe a bus without influencing it. */
  listenOnly?: boolean;
  /** Apply line settings with `stty` before opening (default false). */
  configurePort?: boolean;
}

export interface AdapterProbe {
  available: boolean;
  /** One line for the UI: why it is (not) usable right now. */
  detail: string;
  /** Concrete next steps when `available` is false. */
  hints?: string[];
}

export interface HostContext {
  logger?: Logger;
  /**
   * Where the optional SocketCAN binding comes from.
   *
   * The native module must not become a hard dependency of the platform, so the
   * catalog asks the host for it instead of importing it. The default is
   * `tryLoadSocketCanBinding()`; a test — or an application that ships its own
   * binding — injects a loader, which is the only way to exercise interface
   * listing and channel creation without a kernel CAN device.
   */
  loadSocketCanBinding?: () => Promise<SocketCanBinding>;
}

/** Binding loader of the SocketCAN entry: the host's loader wins. */
function socketCanBindingOf(context: HostContext): Promise<SocketCanBinding> {
  return context.loadSocketCanBinding ? context.loadSocketCanBinding() : tryLoadSocketCanBinding();
}

export interface AdapterEntry {
  id: string;
  displayName: string;
  kind: AdapterKind;
  /** Transport the engine will report in the session (AGENTS 10). */
  transport: "can" | "can-fd" | "virtual";
  description: string;
  capabilities: AdapterCapabilities;
  /** Which settings are mandatory; drives validation and the UI form. */
  requires: { device?: boolean; channel?: boolean; trace?: boolean };
  /** Applied when the caller leaves a setting out. */
  defaults?: AdapterConfig;
  /**
   * Set when the bus is created by the application rather than by this entry.
   *
   * The simulator and the trace replay live above the adapter layer (ADR 0001),
   * so the host catalog can describe and validate them but must not build them.
   * The value names the owner so the reason is visible in the UI and the logs.
   */
  managedBy?: string;
  supportedBitrates?: readonly string[];
  probe(config: AdapterConfig, context: HostContext): Promise<AdapterProbe>;
  create(config: AdapterConfig, context: HostContext): Promise<CanBus>;
}

export interface AdapterDescription {
  id: string;
  displayName: string;
  kind: AdapterKind;
  transport: AdapterEntry["transport"];
  description: string;
  capabilities: AdapterCapabilities;
  requires: AdapterEntry["requires"];
  defaults?: AdapterConfig;
  supportedBitrates?: readonly string[];
  /** Present when the application, not the adapter layer, owns the transport. */
  managedBy?: string;
  probe: AdapterProbe;
}

/** Settings a selection must provide for an entry, given its defaults. */
export function missingRequiredSettings(entry: AdapterEntry, config: AdapterConfig): string[] {
  const merged: AdapterConfig = { ...entry.defaults, ...pruneUndefined(config) };
  const missing: string[] = [];
  if (entry.requires.device && !merged.device) missing.push("--device=<serial device>");
  if (entry.requires.channel && !merged.channel) missing.push("--channel=<can interface>");
  if (entry.requires.trace && !merged.trace) missing.push("--trace=<trace file>");
  return missing;
}

export class AdapterCatalog {
  private readonly entries = new Map<string, AdapterEntry>();

  constructor(entries: readonly AdapterEntry[] = []) {
    for (const entry of entries) this.register(entry);
  }

  register(entry: AdapterEntry): void {
    if (this.entries.has(entry.id)) {
      throw new AdapterUnsupportedError(`adapter "${entry.id}" is already registered`, {
        adapterId: entry.id,
      });
    }
    this.entries.set(entry.id, entry);
  }

  get(id: string): AdapterEntry | undefined {
    return this.entries.get(id);
  }

  require(id: string): AdapterEntry {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new AdapterUnsupportedError(
        `unknown adapter "${id}". Available: ${this.ids().join(", ") || "none"}`,
        { adapterId: id, available: this.ids() },
      );
    }
    return entry;
  }

  ids(): string[] {
    return Array.from(this.entries.keys());
  }

  list(): AdapterEntry[] {
    return Array.from(this.entries.values());
  }

  /** Probe every entry — no device is opened, so this is safe on a live vehicle. */
  async describeAll(
    config: AdapterConfig = {},
    context: HostContext = {},
  ): Promise<AdapterDescription[]> {
    const described: AdapterDescription[] = [];
    for (const entry of this.list()) {
      described.push(await this.describe(entry.id, config, context));
    }
    return described;
  }

  async describe(
    id: string,
    config: AdapterConfig = {},
    context: HostContext = {},
  ): Promise<AdapterDescription> {
    const entry = this.require(id);
    const merged: AdapterConfig = { ...entry.defaults, ...pruneUndefined(config) };
    const missing = missingRequiredSettings(entry, config);
    const probe =
      missing.length > 0
        ? {
            available: false,
            detail: `missing ${missing.join(", ")}`,
            hints: [`pass ${missing[0]}`],
          }
        : await probeSafely(entry, merged, context);
    return {
      id: entry.id,
      displayName: entry.displayName,
      kind: entry.kind,
      transport: entry.transport,
      description: entry.description,
      capabilities: entry.capabilities,
      requires: entry.requires,
      ...(entry.defaults ? { defaults: entry.defaults } : {}),
      ...(entry.supportedBitrates ? { supportedBitrates: entry.supportedBitrates } : {}),
      ...(entry.managedBy ? { managedBy: entry.managedBy } : {}),
      probe,
    };
  }
}

/** A probe that throws is an unavailable adapter, never a crashed caller. */
async function probeSafely(
  entry: AdapterEntry,
  config: AdapterConfig,
  context: HostContext,
): Promise<AdapterProbe> {
  try {
    return await entry.probe(config, context);
  } catch (error) {
    return {
      available: false,
      detail: `probe failed: ${messageOf(error)}`,
    };
  }
}

function pruneUndefined(config: AdapterConfig): AdapterConfig {
  const pruned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) pruned[key] = value;
  }
  return pruned as AdapterConfig;
}

/** Default baud rates shipped by the adapter vendors. */
export const ELM327_DEFAULT_BAUD = 38_400;
export const SLCAN_DEFAULT_BAUD = 115_200;

/**
 * Check whether a character device exists and is usable by this process.
 * `character device` is asserted because pointing the tool at a regular file
 * would otherwise fail much later with a confusing protocol error.
 */
async function probeSerialDevice(device: string): Promise<AdapterProbe> {
  try {
    const info = await stat(device);
    if (info.isDirectory()) {
      return {
        available: false,
        detail: `${device} is a directory`,
        hints: ["pass the character device, e.g. --device=/dev/ttyUSB0"],
      };
    }
    // Regular files are allowed deliberately: a trace piped through a FIFO is a
    // valid development setup even though a real adapter is a character device.
    await access(device, constants.R_OK | constants.W_OK);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    const hints =
      code === "ENOENT"
        ? [
            "is the adapter plugged in?",
            "list candidates with: ls -l /dev/ttyUSB* /dev/ttyACM*",
            'on Linux add the user to the "dialout" group',
          ]
        : ['check the device permissions (group "dialout" on Linux)'];
    return {
      available: false,
      detail: `${device} is not usable: ${messageOf(error)}`,
      hints,
    };
  }
  return { available: true, detail: `${device} is present and read/write accessible` };
}

/** Shared serial open/configure path so both serial adapters behave identically. */
async function openConfiguredStream(
  config: AdapterConfig,
  defaults: { baudRate: number; label: string },
  logger?: Logger,
): Promise<SerialByteStream> {
  const device = config.device;
  if (!device)
    throw new AdapterUnsupportedError("a serial device path is required", {
      adapterId: defaults.label,
    });
  const baudRate = config.baudRate ?? defaults.baudRate;
  const log = (logger ?? createLogger("can", { level: "INFO" })).child("can");
  if (config.configurePort) {
    await configureSerialPort(device, { baudRate }, log);
  }
  return openSerialStream({
    device,
    label: `${defaults.label} ${device} @ ${baudRate}`,
    ...(logger ? { logger } : {}),
  });
}

/**
 * A bus whose `close()` also releases the serial stream the catalog opened.
 *
 * The adapters receive their stream injected and deliberately do not own it, so
 * without this wrapper nothing ever closes it: measured 2026-09-12 on Node 22,
 * one file descriptor stayed open per `create()`/`close()` cycle (24 → 25 → 25),
 * and because `SerialByteStream.runReadLoop` polls `while (!this.closed)`, an
 * adapter that had been opened also left a poll loop running against a device
 * the operator had already disconnected. Reconnecting is an ordinary operation,
 * so both accumulate until the process hits its descriptor limit.
 *
 * Delegating instead of subclassing keeps the adapter contract untouched: the
 * wrapper owns nothing but the lifecycle of the stream it was handed.
 */
function withOwnedStream(bus: CanBus, stream: SerialByteStream): CanBus {
  return {
    info: bus.info,
    capabilities: bus.capabilities,
    open: () => bus.open(),
    isOpen: () => bus.isOpen(),
    send: (frame: CanFrame) => bus.send(frame),
    subscribe: (listener: FrameListener, filters?: readonly CanFilter[]) =>
      bus.subscribe(listener, filters),
    close: async () => {
      try {
        await bus.close();
      } finally {
        // The adapter has dropped its subscription; descriptor and read loop
        // belong to the stream, which only the catalog holds a reference to.
        await stream.close();
      }
    },
  };
}

export const ELM327_BITRATES: readonly string[] = Object.keys(BITRATES);

/** Adapters a plain Node/desktop host can drive without extra dependencies. */
export function createHostAdapterCatalog(): AdapterCatalog {
  return new AdapterCatalog([
    {
      id: "elm327",
      displayName: "ELM327 / OBDLink (serial)",
      kind: "serial",
      transport: "can",
      description:
        'Serial OBD-II interface in raw CAN mode (ATH1/ATCAF0). This is the "normal CAN adapter" the first release targets (AGENTS 29).',
      capabilities: Elm327Adapter.CAPABILITIES,
      requires: { device: true },
      defaults: { baudRate: ELM327_DEFAULT_BAUD, channel: "elm0" },
      probe: async (config) =>
        config.device
          ? probeSerialDevice(config.device)
          : { available: false, detail: "no --device given" },
      create: async (config, context) => {
        const stream = await openConfiguredStream(
          config,
          { baudRate: ELM327_DEFAULT_BAUD, label: "ELM327" },
          context.logger,
        );
        return withOwnedStream(
          new Elm327Adapter({
            stream,
            ...(config.channel ? { channel: config.channel } : {}),
            ...(context.logger ? { logger: context.logger } : {}),
          }),
          stream,
        );
      },
    },
    {
      id: "slcan",
      displayName: "CANable / CANtact / USBtin (slcan)",
      kind: "serial",
      transport: "can",
      description:
        "Lawicel ASCII CAN interface (CANable, CANtact, USBtin) over a serial port. Classic CAN only.",
      capabilities: CanableAdapter.CAPABILITIES,
      requires: { device: true },
      defaults: { baudRate: SLCAN_DEFAULT_BAUD, bitrate: "500k", channel: "slcan0" },
      supportedBitrates: ELM327_BITRATES,
      probe: async (config) => {
        if (!config.device) return { available: false, detail: "no --device given" };
        // Bitrate is validated up front: a typo would otherwise surface as a
        // silent BEL from the adapter while frames never appear.
        const bitrate = config.bitrate ?? "500k";
        if (!(bitrate in BITRATES)) {
          return {
            available: false,
            detail: `unsupported bitrate "${bitrate}"`,
            hints: [`supported: ${ELM327_BITRATES.join(", ")}`],
          };
        }
        return probeSerialDevice(config.device);
      },
      create: async (config, context) => {
        const bitrate = (config.bitrate ?? "500k") as keyof typeof BITRATES;
        if (!(bitrate in BITRATES)) {
          throw new AdapterUnsupportedError(
            `unsupported slcan bitrate "${String(config.bitrate)}"`,
            { supported: ELM327_BITRATES },
          );
        }
        const stream = await openConfiguredStream(
          config,
          { baudRate: SLCAN_DEFAULT_BAUD, label: "slcan" },
          context.logger,
        );
        if (config.listenOnly) {
          // Listen-only is applied before the channel is opened (BITRATES/open
          // below), so the adapter cannot acknowledge a single frame.
          await stream.write("L\r");
        }
        return withOwnedStream(
          new CanableAdapter({
            stream,
            bitrate,
            ...(config.channel ? { channel: config.channel } : {}),
            ...(context.logger ? { logger: context.logger } : {}),
          }),
          stream,
        );
      },
    },
    {
      id: "socketcan",
      displayName: "SocketCAN (Linux)",
      kind: "socketcan",
      transport: "can",
      description:
        "Native Linux CAN interface (can0, vcan0) via a SocketCAN binding. No serial hardware involved.",
      capabilities: SocketCanAdapter.CAPABILITIES,
      requires: { channel: true },
      defaults: { channel: "can0" },
      probe: async (config, context) => {
        let binding: SocketCanBinding;
        try {
          binding = await socketCanBindingOf(context);
        } catch (error) {
          return {
            available: false,
            detail: "no SocketCAN binding installed",
            hints: [
              'install a SocketCAN binding (e.g. "npm i socketcan") or use a serial adapter',
              messageOf(error),
            ],
          };
        }
        if (!config.channel) return { available: false, detail: "no --channel given" };
        try {
          const interfaces = (await binding.listInterfaces?.()) ?? [];
          if (interfaces.length > 0 && !interfaces.includes(config.channel)) {
            return {
              available: false,
              detail: `interface ${config.channel} not found`,
              hints: [`available: ${interfaces.join(", ")}`],
            };
          }
        } catch (error) {
          context.logger?.debug("interface listing failed", { error: String(error) });
        }
        return {
          available: true,
          detail: `binding "${binding.name}" loaded, interface ${config.channel}`,
        };
      },
      create: async (config, context) => {
        if (!config.channel)
          throw new AdapterUnsupportedError(
            "a SocketCAN interface is required (e.g. --channel=can0)",
          );
        const binding = await socketCanBindingOf(context);
        return new SocketCanAdapter({
          binding,
          iface: config.channel,
          ...(context.logger ? { logger: context.logger } : {}),
        });
      },
    },
  ]);
}

/** Device candidates printed by `--list-adapters` / shown in the UI as a hint. */
export const COMMON_SERIAL_DEVICES: readonly string[] = [
  "/dev/ttyUSB0",
  "/dev/ttyUSB1",
  "/dev/ttyACM0",
  "/dev/ttyACM1",
  "/dev/tty.usbserial",
  "/dev/tty.usbmodem",
];

/** Human readable one-liner for logs and the adapter panel. */
export function describeAdapterConfig(entry: AdapterEntry, config: AdapterConfig): string {
  const parts: string[] = [entry.displayName];
  if (config.device) parts.push(config.device);
  if (config.channel) parts.push(`channel ${config.channel}`);
  if (config.baudRate) parts.push(`${config.baudRate} baud`);
  if (config.bitrate) parts.push(config.bitrate);
  if (config.trace) parts.push(config.trace);
  if (config.listenOnly) parts.push("listen-only");
  return parts.join(" · ");
}

/** Guard used by callers that want a hard failure instead of a probe result. */
export async function assertAdapterUsable(
  entry: AdapterEntry,
  config: AdapterConfig,
  context: HostContext = {},
): Promise<AdapterProbe> {
  const missing = missingRequiredSettings(entry, config);
  if (missing.length > 0) {
    throw new AdapterUnsupportedError(`${entry.id} needs ${missing.join(", ")}`, {
      adapterId: entry.id,
      missing,
    });
  }
  const probe = await probeSafely(entry, { ...entry.defaults, ...pruneUndefined(config) }, context);
  if (!probe.available) {
    throw new TransportError(`adapter ${entry.id} is not usable: ${probe.detail}`, {
      adapterId: entry.id,
      detail: probe.detail,
    });
  }
  return probe;
}
