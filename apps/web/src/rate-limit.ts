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
  /**
   * Max distinct IPs tracked at once (default 10_000). Without a cap the window
   * map is bounded only by the number of source addresses that ever talked to
   * the server — with a rotating source (an attacker, a large NAT) that grows
   * forever. When the cap is hit, expired windows are swept and the oldest
   * entries evicted, so the memory stays bounded no matter who hammers the
   * port; the evicted IPs simply start a fresh window on their next request.
   */
  maxTrackedIps?: number;
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
 * that IP. The window map is hard-capped by `maxTrackedIps` (expired entries are
 * swept, then the oldest tracked IPs evicted when the cap is hit), so a rotating
 * source address cannot grow it without bound — on a bench the map holds 1 IP,
 * on a workshop network a handful, under attack still at most the cap.
 */
export class RateLimiter {
  private readonly windows = new Map<string, WindowState>();
  private readonly streams = new Map<string, number>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxStreams: number;
  private readonly maxTrackedIps: number;

  constructor(options: RateLimitOptions = {}) {
    this.maxRequests = options.maxRequests ?? 100;
    this.windowMs = options.windowMs ?? 60_000;
    this.maxStreams = options.maxStreams ?? 10;
    this.maxTrackedIps = options.maxTrackedIps ?? 10_000;
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
      // New window. If the map is at its cap, make room first so a rotating
      // source address cannot grow it without bound: expired windows go first,
      // then the oldest tracked IPs (the evicted IP starts a fresh window).
      if (this.windows.size >= this.maxTrackedIps && state === undefined) {
        this.evictUntilFitting(now);
      }
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

  /**
   * Bring the window map under its cap: expired windows first, then the oldest
   * tracked IPs (the map keeps first-seen order, and a window reset does not
   * refresh it). Eviction degrades the limit for those IPs — they simply start
   * a fresh window on their next request — instead of letting the map, and
   * with it the process, grow without bound.
   */
  private evictUntilFitting(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.windowStart >= this.windowMs) this.windows.delete(key);
    }
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxTrackedIps) break;
      this.windows.delete(key);
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
