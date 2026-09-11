/**
 * Transport binding for UDS.
 *
 * ISO 14229-2 defines session services transport-independently, so the UDS layer
 * talks to this three-method interface only. `IsoTpConnection` satisfies it
 * structurally (ISO 15765-2); a DoIP transport (ISO 13400) will do the same
 * without a single change in the diagnostic core (AGENTS 2, 5, 36).
 */

export interface UdsLink {
  /** Send a request and await the matching response. */
  request(payload: Uint8Array, timeoutMs?: number): Promise<Uint8Array>;
  /** Send without expecting a response (functional addressing, suppress-positive-response). */
  sendOnly(payload: Uint8Array): Promise<void>;
  /** Await the next message that is not a response to a pending request (NRC 0x78 flow). */
  receive(timeoutMs?: number): Promise<Uint8Array | null>;
}

/** Structural check helper — keeps the compiler honest when new transports are added. */
export function isUdsLink(candidate: unknown): candidate is UdsLink {
  const value = candidate as Partial<UdsLink> | null;
  return (
    typeof value?.request === "function" &&
    typeof value?.sendOnly === "function" &&
    typeof value?.receive === "function"
  );
}
