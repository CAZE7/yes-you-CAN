/**
 * Byte stream abstraction for serial adapters.
 *
 * The adapter never talks to a serial port directly: the platform (Node, browser
 * WebSerial, desktop) provides a ByteStream. That keeps the protocol logic
 * testable without hardware (AGENTS 31/32) and portable across apps (AGENTS 28).
 */

export interface ByteStream {
  write(data: string): Promise<void>;
  /** Subscribe to incoming chunks; returns an unsubscribe function. */
  onData(listener: (chunk: string) => void): () => void;
  close(): Promise<void>;
  isOpen(): boolean;
  /** Optional human readable description for the UI adapter panel. */
  describe?(): string;
}

/** In-memory stream used by tests and by the simulator bridge. */
export class MemoryByteStream implements ByteStream {
  private listeners: Array<(chunk: string) => void> = [];
  private opened = false;
  readonly written: string[] = [];
  /** Optional canned responder: called with each written command. */
  responder: ((command: string) => string | null) | null = null;

  async write(data: string): Promise<void> {
    this.written.push(data);
    if (!this.opened) throw new Error('stream is closed');
    const reply = this.responder?.(data);
    if (reply) this.emit(reply);
  }

  onData(listener: (chunk: string) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async close(): Promise<void> {
    this.opened = false;
    this.listeners = [];
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

  describe(): string {
    return 'MemoryByteStream';
  }
}
