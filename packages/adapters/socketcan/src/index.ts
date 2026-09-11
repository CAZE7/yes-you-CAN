export * from "./adapter.js";
export * from "./binding.js";
import type { CanAdapterFactory } from "@vdp/transport-can";
import { SocketCanAdapter, type SocketCanOptions } from "./adapter.js";
import type { SocketCanBinding } from "./binding.js";

export function createSocketCanFactory(
  binding: SocketCanBinding,
  defaults: Partial<SocketCanOptions> = {},
): CanAdapterFactory {
  return {
    id: "socketcan",
    displayName: "SocketCAN (Linux)",
    create: (options) =>
      new SocketCanAdapter({ binding, ...defaults, ...(options as Partial<SocketCanOptions>) }),
    isAvailable: () => process.platform === "linux",
  };
}
