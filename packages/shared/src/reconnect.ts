/**
 * The reconnect policy vocabulary — one rule for every link that may come back.
 *
 * The rule was written for the serial adapters (backlog E34: "a lost link is
 * tried again, but bounded and named") and DoIP needs exactly the same rule for
 * its TCP connection: bounded attempts, a named delay between them, no silent
 * loop. Two links with the same policy is not two policies — it is one policy
 * with two call sites, so it lives here, in the foundation layer both may import
 * (AGENTS 34.2: one vocabulary, several call sites).
 *
 * What stays out of this module: *when* an attempt happens and *what* a revival
 * is. A serial revival reopens a tty and re-runs AT commands, a DoIP revival
 * opens a socket and activates routing — those are the links' business and live
 * with the links.
 */

import { AdapterUnsupportedError } from "./errors.js";

/**
 * Bounded reconnect policy of one link.
 *
 * `attempts: 0` disables the supervisor entirely, which is the documented "the
 * final state of today" — no retry, just the honest state and the reason.
 */
export interface ReconnectPolicy {
  /** Reconnect attempts per link loss. Finite by contract. */
  attempts: number;
  /** Wait before each attempt — the operator's window to replug the device. */
  delayMs: number;
}

/** One attempt after two seconds: enough to notice a replug, small enough to stay honest. */
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = { attempts: 1, delayMs: 2000 };

/** The policy is bounded by contract; this is the bound (a loop in config is still a loop). */
export const MAX_RECONNECT_ATTEMPTS = 10;

/** Likewise the delay: an hour of "reconnecting" is a dead bus wearing a heartbeat. */
export const MAX_RECONNECT_DELAY_MS = 60_000;

/**
 * Resolve the policy from configuration values, refusing unbounded input.
 *
 * Fail-closed on anything that is not a whole number in range: `1.5` attempts or
 * a `NaN` delay is a broken configuration, not a default to be guessed.
 */
export function reconnectPolicyOf(config: {
  reconnectAttempts?: number;
  reconnectDelayMs?: number;
}): ReconnectPolicy {
  const attempts = config.reconnectAttempts ?? DEFAULT_RECONNECT_POLICY.attempts;
  const delayMs = config.reconnectDelayMs ?? DEFAULT_RECONNECT_POLICY.delayMs;
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > MAX_RECONNECT_ATTEMPTS) {
    throw new AdapterUnsupportedError(
      `reconnectAttempts must be an integer between 0 and ${MAX_RECONNECT_ATTEMPTS}, got ${String(config.reconnectAttempts)}`,
    );
  }
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_RECONNECT_DELAY_MS) {
    throw new AdapterUnsupportedError(
      `reconnectDelayMs must be an integer between 0 and ${MAX_RECONNECT_DELAY_MS}, got ${String(config.reconnectDelayMs)}`,
    );
  }
  return { attempts, delayMs };
}
