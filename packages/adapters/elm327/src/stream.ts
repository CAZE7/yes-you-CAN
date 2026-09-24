/**
 * Byte stream abstraction for serial adapters.
 *
 * The adapter never talks to a serial port directly: the platform (Node, browser
 * WebSerial, desktop) provides a ByteStream. That keeps the protocol logic
 * testable without hardware (AGENTS 31/32) and portable across apps (AGENTS 28).
 */

import { TransportError } from "@vdp/shared";

export interface ByteStream {
  write(data: string): Promise<void>;
  /** Subscribe to incoming chunks; returns an unsubscribe function. */
  onData(listener: (chunk: string) => void): () => void;
  /**
   * Optional: subscribe to the stream's own death — an unplugged cable, a
   * dropped Bluetooth link, a read loop that hit an unrecoverable error.
   *
   * Optional because not every host implements it (a memory stream in a test
   * has nothing to report), but an adapter that does not listen reports itself
   * open against a device that is gone: the UI says `connected: true` until the
   * next request walks into its own timeout, which reads as a silent vehicle
   * rather than a dead link. The host `SerialByteStream` implements it.
   */
  onError?(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
  isOpen(): boolean;
  /** Optional human readable description for the UI adapter panel. */
  describe?(): string;
}

/** In-memory stream used by tests and by the simulator bridge. */
export class MemoryByteStream implements ByteStream {
  private listeners: Array<(chunk: string) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  private opened = false;
  readonly written: string[] = [];
  /** Optional canned responder: called with each written command. */
  responder: ((command: string) => string | null) | null = null;

  async write(data: string): Promise<void> {
    this.written.push(data);
    // Same failure class as the host stream: an adapter must not have to know
    // which ByteStream it drives to interpret "the stream is gone".
    if (!this.opened) throw new TransportError("stream is closed");
    const reply = this.responder?.(data);
    if (reply) this.emit(reply);
  }

  onData(listener: (chunk: string) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.push(listener);
    return () => {
      this.errorListeners = this.errorListeners.filter((l) => l !== listener);
    };
  }

  async close(): Promise<void> {
    this.opened = false;
    this.listeners = [];
    this.errorListeners = [];
  }

  isOpen(): boolean {
    return this.opened;
  }

  open(): void {
    this.opened = true;
  }

  /** Feed data into the adapter as if the device had sent it. */
  emit(chunk: string): void {
    for (const listener of this.listeners) listener(chunk);
  }

  /**
   * Report a stream failure to the adapter as a real one would: the device is
   * gone, and an adapter that keeps saying `isOpen()` is lying about it.
   */
  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }

  describe(): string {
    return "MemoryByteStream";
  }
}
