/**
 * A real consumer of the domain event bus (target architecture §10).
 *
 * The event catalogue exists so observers — UI, session recorder, telemetry,
 * audit — can follow diagnostics without the diagnostic code knowing them. This
 * recorder is the first such observer wired by default: it subscribes to every
 * diagnostic event and keeps an immutable, timestamped trail that reports,
 * replay and safety audits can reconstruct a session from (§24 correlation ids).
 */

import {
  type Clock,
  DIAGNOSTIC_EVENT_NAMES,
  type DiagnosticEventMap,
  type DiagnosticEventName,
  type EventBus,
  type Unsubscribe,
  systemClock,
} from "@vdp/domain";

/** One observed event. Payloads carry the correlation ids (§24/§25). */
export interface AuditEntry {
  /** When the event was observed (from the injected clock, for determinism). */
  at: number;
  event: DiagnosticEventName;
  payload: DiagnosticEventMap[DiagnosticEventName];
  /** Lifted from the payload when present, so filtering is O(1) by session/ECU. */
  sessionId?: string;
  ecuId?: string;
}

export class EventAuditRecorder {
  private readonly entries: AuditEntry[] = [];
  private readonly subscriptions: Unsubscribe[] = [];
  private readonly now: () => number;

  constructor(events: EventBus, clock?: Clock) {
    this.now = clock ? () => clock.now() : () => systemClock.now();
    for (const name of DIAGNOSTIC_EVENT_NAMES) {
      this.subscriptions.push(
        events.subscribe(name, (payload) => {
          this.record(name, payload);
        }),
      );
    }
  }

  private record(
    event: DiagnosticEventName,
    payload: DiagnosticEventMap[DiagnosticEventName],
  ): void {
    const entry: AuditEntry = { at: this.now(), event, payload };
    // Correlation ids live on most payloads; read them structurally without
    // coupling the recorder to each payload shape.
    const fields = payload as unknown as Record<string, unknown>;
    if (typeof fields.sessionId === "string") entry.sessionId = fields.sessionId;
    if (typeof fields.ecuId === "string") entry.ecuId = fields.ecuId;
    this.entries.push(entry);
  }

  /** Full trail in arrival order. */
  get all(): readonly AuditEntry[] {
    return this.entries;
  }

  /** Trail of one session — the correlation id from §24. */
  forSession(sessionId: string): readonly AuditEntry[] {
    return this.entries.filter((entry) => entry.sessionId === sessionId);
  }

  /** Trail of one ECU. */
  forEcu(ecuId: string): readonly AuditEntry[] {
    return this.entries.filter((entry) => entry.ecuId === ecuId);
  }

  /** Only one event kind, e.g. for safety audits of every `action-executed`. */
  forEvent(event: DiagnosticEventName): readonly AuditEntry[] {
    return this.entries.filter((entry) => entry.event === event);
  }

  /** Stop observing. The captured trail is kept. */
  dispose(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions.length = 0;
  }
}
