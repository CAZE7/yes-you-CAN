/**
 * The replay adapter entry of the harvest CLI (backlog E27.2, ADR 0005).
 *
 * A harvest is a *conversation* with a vehicle, and a conversation that was
 * recorded can be held again: the trace of a previous session stands in for
 * the car, so the adapter branch of this CLI is testable — and runnable —
 * without hardware. That is ADR 0005 (simulator and replay instead of a
 * vehicle) applied to the harvest, which until now only had the simulator arm.
 *
 * Why this entry lives here and not in `@vdp/adapter-host`: registering
 * entries from *above* the adapter layer is the sanctioned pattern (AGENTS
 * 34.2, the catalog's own header). The workbench registers its own replay
 * entry too, but a different one — the app resolves stored sessions through
 * its repository, this CLI has none and takes a file (or inline JSON), the
 * same two spellings the workbench's replay source accepts. The vocabulary
 * (trace reference → `ReplayTransport`) stays `@vdp/transport-can`'s; nothing
 * here re-parses a recording.
 */

import { readFileSync } from "node:fs";
import type { AdapterConfig, AdapterEntry, AdapterProbe } from "@vdp/adapter-host";
import { AdapterUnsupportedError, type Logger, messageOf } from "@vdp/shared";
import {
  type AdapterCapabilities,
  type ReplayRecording,
  ReplayTransport,
  recordingFromSessionJson,
} from "@vdp/transport-can";

/** The replay entry reuses the transport's own capabilities — it carries what was recorded. */
const REPLAY_CAPABILITIES: AdapterCapabilities = {
  can: true,
  canFd: true,
  doip: false,
  isoTpOffload: false,
  channels: 1,
};

/**
 * The recording text for a trace reference.
 *
 * A reference that starts with `{` is inline JSON (so a test — or a script —
 * can pass a recording without a file); everything else is a path. The same
 * order the workbench's replay source uses, for the same reason: the common
 * case is a file, the self-describing case needs no file.
 */
export function recordingTextOf(reference: string): string {
  if (reference.trimStart().startsWith("{")) return reference;
  try {
    return readFileSync(reference, "utf8");
  } catch (error) {
    throw new AdapterUnsupportedError(
      `the recording cannot be read: ${messageOf(error)} — pass a session export (--trace=<file>, format "vdp.session")`,
      { reference },
    );
  }
}

/** Parse a trace reference into a recording, refusing what it cannot prove. */
export function recordingOf(reference: string): ReplayRecording {
  const recording = recordingFromSessionJson(recordingTextOf(reference));
  if (recording.frames.length === 0) {
    throw new AdapterUnsupportedError(
      "the recording contains no frames — a session saved without a raw trace cannot stand in for a vehicle",
      { reference },
    );
  }
  return recording;
}

/**
 * The replay entry for the harvest catalog: `--adapter replay --trace <file>`.
 *
 * `probe` answers from the trace reference alone (no file is opened — probing
 * stays side-effect free, ADR 0016); `create` loads the recording and hands
 * back an open `ReplayTransport`.
 */
export function replayAdapterEntry(): AdapterEntry {
  const probeOf = (config: AdapterConfig): AdapterProbe =>
    config.trace
      ? { available: true, detail: `recording: ${config.trace}` }
      : {
          available: false,
          detail: "replay needs a recording",
          hints: ['pass a session export: --trace=<file> (format "vdp.session")'],
        };
  return {
    id: "replay",
    displayName: "Trace-Replay (aufgezeichnete Sitzung)",
    kind: "replay",
    transport: "can",
    description:
      "Spielt den Roh-Trace einer aufgezeichneten Sitzung als Fahrzeug ab (ADR 0005): dieselbe Ernte, dasselbe Protokoll, kein Adapter.",
    capabilities: REPLAY_CAPABILITIES,
    requires: {},
    probe: async (config) => probeOf(config),
    create: async (config: AdapterConfig, context: { logger?: Logger }) => {
      const reference = config.trace;
      if (!reference) {
        throw new AdapterUnsupportedError(
          'replay needs a recording: pass a session export (--trace=<file>, format "vdp.session")',
        );
      }
      let recording: ReplayRecording;
      try {
        recording = recordingOf(reference);
      } catch (error) {
        throw new AdapterUnsupportedError(`the recording cannot be used: ${messageOf(error)}`, {
          reference,
        });
      }
      const transport = new ReplayTransport(recording, {
        ...(context.logger ? { logger: context.logger } : {}),
      });
      await transport.open();
      return transport;
    },
  };
}
