/**
 * Rate limiting for the workbench API (ISO 21434 CY-04).
 *
 * Before this existed: `grep -c "rate.?limit\|request.setTimeout" server.ts` → **0**.
 * A single client could open unlimited SSE streams or hammer the API with polling,
 * and the only thing that limited it was the TCP stack.
 *
 * This is intentionally simple: an in-memory fixed window per IP (reset lazily
 * on the next request from that IP — see the class below), no external store,
 * no distributed state. A diagnostic tool on a bench does not need a
 * Redis-backed token bucket; it needs a guard that says "slow down" before the
 * event loop is saturated, and that guard must be testable without a network.
 *
 * Two buckets:
 * - API: 100 requests per 60s per IP (generous for a UI that polls history)
 * - SSE: 10 concurrent streams per IP (a browser opens 1, a second tab 2)
 *
 * When the limit is hit: 429 with a sentence, not a silent drop (ADR 0018).
 */

export interface RateLimitOptions {
  /** Max requests per window (default 100). */
  maxRequests?: number;
  /** Window in ms (default 60_000). */
  windowMs?: number;
  /** Max concurrent SSE streams per IP (default 10). */
  maxStreams?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** When not allowed, how many ms until the window resets. */
  retryAfterMs?: number;
  /** Current count in this window (for headers, if we ever add them). */
  current?: number;
}

/** One IP's state in the current window. */
interface WindowState {
  count: number;
  windowStart: number;
}

/**
 * In-memory rate limiter.
 *
 * No timers, no cleanup interval — windows reset lazily on the next request from
 * that IP. The map is bounded by the number of distinct IPs that ever talked to
 * the server, which on a bench is 1 and on a workshop network is small.
 */
export class RateLimiter {
  private readonly windows = new Map<string, WindowState>();
  private readonly streams = new Map<string, number>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxStreams: number;

  constructor(options: RateLimitOptions = {}) {
    this.maxRequests = options.maxRequests ?? 100;
    this.windowMs = options.windowMs ?? 60_000;
    this.maxStreams = options.maxStreams ?? 10;
  }

  /** Extract client IP from request (socket, not X-Forwarded-For — no proxy). */
  static clientIp(request: {
    socket?: { remoteAddress?: string | undefined } | undefined;
  }): string {
    return request.socket?.remoteAddress ?? "unknown";
  }

  /** Check if an API request is allowed. */
  checkApi(ip: string, now = Date.now()): RateLimitResult {
    const state = this.windows.get(ip);
    if (state === undefined || now - state.windowStart >= this.windowMs) {
      // New window
      this.windows.set(ip, { count: 1, windowStart: now });
      return { allowed: true, current: 1 };
    }
    if (state.count >= this.maxRequests) {
      return {
        allowed: false,
        retryAfterMs: this.windowMs - (now - state.windowStart),
        current: state.count,
      };
    }
    state.count++;
    return { allowed: true, current: state.count };
  }

  /** Try to open an SSE stream. */
  tryOpenStream(ip: string): RateLimitResult {
    const current = this.streams.get(ip) ?? 0;
    if (current >= this.maxStreams) {
      return { allowed: false, current };
    }
    this.streams.set(ip, current + 1);
    return { allowed: true, current: current + 1 };
  }

  /** Close an SSE stream (called on response close). */
  closeStream(ip: string): void {
    const current = this.streams.get(ip) ?? 0;
    if (current <= 1) {
      this.streams.delete(ip);
    } else {
      this.streams.set(ip, current - 1);
    }
  }

  /** For tests: clear all state. */
  clear(): void {
    this.windows.clear();
    this.streams.clear();
  }

  /** For tests: how many IPs are tracked. */
  get size(): number {
    return this.windows.size;
  }
}

/** Shared limiter for the server (one per process). */
export const defaultLimiter = new RateLimiter();
