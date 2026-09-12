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
 * Attempt to load an optional native binding.
 * Never throws at import time: a missing native module only becomes an error when
 * somebody actually selects the SocketCAN adapter.
 */
export async function tryLoadSocketCanBinding(moduleName = "socketcan"): Promise<SocketCanBinding> {
  try {
    const loaded = (await import(/* @vite-ignore */ moduleName)) as unknown;
    const candidate =
      (loaded as { default?: SocketCanBinding }).default ?? (loaded as SocketCanBinding);
    if (typeof candidate?.open !== "function") {
      throw new AdapterUnsupportedError(
        `module "${moduleName}" does not expose the SocketCAN binding interface`,
      );
    }
    return candidate;
  } catch (error) {
    throw new AdapterUnsupportedError(
      `SocketCAN adapter unavailable: ${messageOf(error)}. Install a SocketCAN binding (e.g. "socketcan") on Linux, or use a different adapter.`,
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
