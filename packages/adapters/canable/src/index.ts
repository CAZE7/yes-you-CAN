export * from "./adapter.js";
export * from "./slcan.js";
import type { ByteStream } from "@vdp/adapter-elm327";
import type { CanAdapterFactory } from "@vdp/transport-can";
import { CanableAdapter, type CanableOptions } from "./adapter.js";

export function createCanableFactory(
  stream: ByteStream,
  defaults: Partial<CanableOptions> = {},
): CanAdapterFactory {
  return {
    id: "canable",
    displayName: "CANable / CANtact (slcan)",
    create: (options) =>
      new CanableAdapter({ stream, ...defaults, ...(options as Partial<CanableOptions>) }),
    isAvailable: () => stream.isOpen(),
  };
}
