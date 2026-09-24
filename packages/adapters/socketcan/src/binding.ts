/**
 * SocketCAN binding abstraction.
 *
 * Linux SocketCAN needs a native module, which must not become a hard dependency
 * of the whole platform. The adapter therefore talks to this interface; the host
 * supplies an implementation (node-socketcan, a N-API addon, or a fake in tests).
 */

import { AdapterUnsupportedError, messageOf } from "@vdp/shared";

export interface SocketCanFrameData {
  id: number;
  extended: boolean;
  data: Uint8Array;
}

export interface SocketCanBinding {
  readonly name: string;
  open(iface: string): Promise<SocketCanChannel>;
  /** List available CAN interfaces (best effort). */
  listInterfaces?(): Promise<string[]>;
}

export interface SocketCanChannel {
  send(frame: SocketCanFrameData): Promise<void>;
  onData(listener: (frame: SocketCanFrameData) => void): () => void;
  close(): Promise<void>;
  setBitrate?(bitrate: number): Promise<void>;
  setUp?(up: boolean): Promise<void>;
}

/**
 * The two shapes a SocketCAN module may have: this repository's
 * {@link SocketCanBinding.open}, or the npm `socketcan` module's
 * `createChannel` — that module is the one the "install it" hints name, so
 * loading must accept what installing actually delivers.
 */
interface NpmSocketCanMessage {
  id: number;
  ext?: boolean;
  rtr?: boolean;
  data: Uint8Array;
}

interface NpmSocketCanChannel {
  start(): void;
  stop(): void;
  addListener(event: "onMessage", listener: (message: NpmSocketCanMessage) => void): void;
  removeListener?(event: "onMessage", listener: (message: NpmSocketCanMessage) => void): void;
  send(frame: { id: number; ext?: boolean; rtr?: boolean; data: Uint8Array }): void;
}

interface NpmSocketCanModule {
  createChannel(iface: string, ...args: unknown[]): NpmSocketCanChannel;
}

/** The npm `socketcan` module exposes `createChannel`; our binding contract exposes `open()`. */
function hasCreateChannel(candidate: unknown): boolean {
  return typeof (candidate as NpmSocketCanModule | undefined)?.createChannel === "function";
}

/**
 * Wrap the npm `socketcan` module into this repository's SocketCanBinding
 * contract. Duck-typed on purpose: the module stays an optional native
 * dependency (ADR 0002), so its types are described, not imported.
 */
export function wrapNpmSocketCanModule(
  module: NpmSocketCanModule,
  name = "socketcan",
): SocketCanBinding {
  return {
    name,
    async open(iface: string): Promise<SocketCanChannel> {
      const channel = module.createChannel(iface, false);
      channel.start();
      const listeners = new Map<
        (frame: SocketCanFrameData) => void,
        (message: NpmSocketCanMessage) => void
      >();
      return {
        async send(frame: SocketCanFrameData): Promise<void> {
          // The native addon copies from its Buffer; any byte array carries
          // the same eight octets, and our adapter never mutates after send.
          channel.send({
            id: frame.id,
            ext: frame.extended,
            data: frame.data,
          });
        },
        onData(listener: (frame: SocketCanFrameData) => void): () => void {
          const wrapped = (message: NpmSocketCanMessage): void => {
            if (message.rtr) return; // no payload to attribute (same rule as slcan remote frames)
            listener({
              id: message.id,
              extended: message.ext ?? message.id > 0x7ff,
              data: new Uint8Array(message.data),
            });
          };
          listeners.set(listener, wrapped);
          channel.addListener("onMessage", wrapped);
          return () => {
            const existing = listeners.get(listener);
            listeners.delete(listener);
            if (existing) channel.removeListener?.("onMessage", existing);
          };
        },
        async close(): Promise<void> {
          for (const [, wrapped] of listeners) channel.removeListener?.("onMessage", wrapped);
          listeners.clear();
          channel.stop();
        },
      };
    },
  };
}

/**
 * Attempt to load an optional native binding.
 * Never throws at import time: a missing native module only becomes an error when
 * somebody actually selects the SocketCAN adapter.
 *
 * Two module shapes are accepted, because both exist in the wild and the
 * install hints name the second: this repository's `open()` contract and the
 * npm `socketcan` module's `createChannel`. Failing to accept the documented
 * one used to make the hint itself the trap (the module installed fine and
 * the loader still said "does not expose the binding interface").
 */
export async function tryLoadSocketCanBinding(
  moduleName = "socketcan",
  importModule?: (name: string) => Promise<unknown>,
): Promise<SocketCanBinding> {
  const load = importModule ?? ((name: string) => import(/* @vite-ignore */ name) as unknown);
  try {
    const loaded = (await load(moduleName)) as unknown;
    const candidate =
      (loaded as { default?: SocketCanBinding }).default ?? (loaded as SocketCanBinding);
    if (typeof candidate?.open === "function") {
      return candidate;
    }
    if (hasCreateChannel(candidate) || hasCreateChannel(loaded)) {
      return wrapNpmSocketCanModule(
        (hasCreateChannel(candidate) ? candidate : loaded) as NpmSocketCanModule,
        `${moduleName} (npm)`,
      );
    }
    throw new AdapterUnsupportedError(
      `module "${moduleName}" exposes neither the SocketCanBinding.open() contract nor the npm socketcan createChannel() shape`,
    );
  } catch (error) {
    throw new AdapterUnsupportedError(
      `SocketCAN adapter unavailable: ${messageOf(error)}. Install a SocketCAN binding (e.g. "socketcan") on Linux and make sure the interface exists and is up (ip -details link show can0), or use a serial adapter instead.`,
      { moduleName },
    );
  }
}

/** In-memory binding for tests and for the simulator bridge. */
export class FakeSocketCanBinding implements SocketCanBinding {
  readonly name = "fake-socketcan";
  readonly sent: SocketCanFrameData[] = [];
  readonly opened: string[] = [];
  closed = false;
  bitrate: number | null = null;
  private listeners: Array<(frame: SocketCanFrameData) => void> = [];
  private isOpen = false;

  async open(iface: string): Promise<SocketCanChannel> {
    this.opened.push(iface);
    this.isOpen = true;
    this.closed = false;
    const self = this;
    return {
      async send(frame) {
        if (!self.isOpen) throw new Error("channel closed");
        self.sent.push(frame);
      },
      onData(listener) {
        self.listeners.push(listener);
        return () => {
          self.listeners = self.listeners.filter((l) => l !== listener);
        };
      },
      async close() {
        self.isOpen = false;
        self.closed = true;
        self.listeners = [];
      },
      async setBitrate(bitrate) {
        self.bitrate = bitrate;
      },
    };
  }

  async listInterfaces(): Promise<string[]> {
    return ["can0", "vcan0"];
  }

  /** Inject a frame as if the kernel had received it. */
  emit(frame: SocketCanFrameData): void {
    for (const listener of this.listeners) listener(frame);
  }

  get isChannelOpen(): boolean {
    return this.isOpen;
  }
}
