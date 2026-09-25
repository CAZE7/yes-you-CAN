/**
 * Authentication for the workbench API (ISO 21434 direction; `docs/standards/`,
 * Gefährdung CY-01/CY-02).
 *
 * Measured before this existed: **37** routes under `/api/`, and
 * `grep -c "authoriz\|bearer\|token" apps/web/src/server.ts` → **0**. Anyone who
 * could reach the port could read the vehicle and trigger a write — the
 * `WritePort` permit decides *when* a write is allowed, not *who* asks.
 *
 * The shape follows the one a local diagnostic tool already has to solve: the
 * operator opens the page once with the token in the URL (`/?token=…`, the Jupyter
 * pattern), the server exchanges it for an `httpOnly` cookie, and every API call
 * afterwards carries the cookie or an `Authorization: Bearer` header. A token in
 * the HTML would not be a token — anyone who can reach the server could read it
 * back.
 *
 * Two rules this file holds that are easy to lose:
 *
 * - **The comparison is constant-time.** A `===` on a secret leaks its length and
 *   its first differing byte through timing; hashing both sides to a fixed width
 *   first is what makes `timingSafeEqual` applicable at all.
 * - **No token configured means unchanged behaviour, said out loud.** The server
 *   stays usable on a bench with no network, and the operator hears it in the log
 *   instead of finding out later. Silence would be the defect this module exists
 *   to remove (ADR 0049).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Name of the cookie the token exchange sets. */
export const AUTH_COOKIE = "vdp_session";

/** Generate a 32-hex-character ephemeral token for non-interactive / headless start. */
export function generateEphemeralToken(): string {
  return randomBytes(16).toString("hex");
}

/** Cookie attributes: never readable by script, never sent cross-site. */
const COOKIE_ATTRIBUTES = "HttpOnly; SameSite=Strict; Path=/";

/** Fixed-width digest so `timingSafeEqual` has equal-length inputs. */
function digest(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** Constant-time equality of two secrets of possibly different length. */
export function secretsEqual(a: string, b: string): boolean {
  const left = digest(a);
  const right = digest(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Read one cookie out of a `Cookie:` header without a parser dependency. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name)
      return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

/** The decision the routes need: let the request through, or answer 401. */
export interface Authenticator {
  /** False when no token was configured — the API stays open, as before. */
  readonly enabled: boolean;
  /** True when the request carries the token, by header or by cookie. */
  isAuthorized(request: IncomingMessage): boolean;
  /** The `?token=` exchange: the cookie to set when the value matches. */
  cookieFor(token: string | null): string | undefined;
  /** The `Set-Cookie` value that clears the session again. */
  readonly clearCookie: string;
}

/**
 * Build the authenticator for a server.
 *
 * `token` comes from `--token=` or `VDP_API_TOKEN`. Without it the returned
 * authenticator reports `enabled: false` and authorises everything — the bench
 * case, where a network does not exist.
 */
export function createAuthenticator(token: string | undefined): Authenticator {
  if (token === undefined || token.length === 0) {
    return {
      enabled: false,
      isAuthorized: () => true,
      cookieFor: () => undefined,
      clearCookie: `${AUTH_COOKIE}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`,
    };
  }
  const expected = digest(token);
  const matches = (candidate: string | undefined): boolean => {
    if (candidate === undefined || candidate.length === 0) return false;
    const given = digest(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  return {
    enabled: true,
    isAuthorized(request: IncomingMessage): boolean {
      const header = request.headers.authorization;
      if (header?.toLowerCase().startsWith("bearer ")) {
        return matches(header.slice("bearer ".length).trim());
      }
      return matches(cookieValue(request.headers.cookie, AUTH_COOKIE));
    },
    cookieFor(candidate: string | null): string | undefined {
      if (candidate === null || !matches(candidate)) return undefined;
      // Not `Max-Age`: the session ends with the browser, so a token left in a URL
      // does not survive as a standing credential in a profile.
      return `${AUTH_COOKIE}=${encodeURIComponent(candidate)}; ${COOKIE_ATTRIBUTES}`;
    },
    clearCookie: `${AUTH_COOKIE}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`,
  };
}

/**
 * The refusal: a status and a sentence that says what to do.
 *
 * 401 and not 403 — the request is not authenticated, it is not forbidden for an
 * authenticated caller. The body follows the house rule that a refusal is data
 * (ADR 0018): a status plus a sentence, never a stack trace and never silence.
 */
export const AUTH_REFUSAL = {
  error:
    "not authenticated — pass the token as `Authorization: Bearer <token>` or open the workbench once with ?token=<token>",
};

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface OriginValidationResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Validate Host and Origin headers to protect against DNS rebinding and
 * cross-site request forgery (CSRF) on mutating routes (ISO 21434 / CY-02).
 *
 * `trustedHosts` is an *explicit* list of the hostnames a browser uses to reach
 * this server (the sandbox preview host, a named bind host). It is deliberately
 * exact-match: a wildcard such as `*.e2b.app` would also trust every *other*
 * sandbox's host, which is not the server this request was meant for.
 */
export function validateRequestOrigin(
  request: IncomingMessage,
  options: { trustedHosts?: readonly string[] | undefined } = {},
): OriginValidationResult {
  const method = (request.method ?? "GET").toUpperCase();
  const hostHeader = request.headers.host;
  const trustedHosts = (options.trustedHosts ?? []).map((host) => host.toLowerCase());
  const isTrustedHost = (hostName: string): boolean => trustedHosts.includes(hostName);

  // 1. Host header validation against DNS rebinding
  if (hostHeader) {
    const hostName = hostHeader.split(":")[0]?.toLowerCase() ?? "";
    const isLocalhost =
      hostName === "localhost" ||
      hostName === "127.0.0.1" ||
      hostName === "::1" ||
      hostName === "[::1]";
    const isPrivateIp =
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostName) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostName) ||
      /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostName);

    if (!isLocalhost && !isPrivateIp && !isTrustedHost(hostName)) {
      return {
        ok: false,
        reason: `untrusted Host header "${hostHeader}" — potential DNS rebinding attack`,
      };
    }
  }

  // 2. For mutating requests, validate Origin and Sec-Fetch-Site
  if (MUTATING_METHODS.has(method)) {
    const originHeader = request.headers.origin;
    if (originHeader) {
      let originUrl: URL;
      try {
        originUrl = new URL(originHeader);
      } catch {
        return { ok: false, reason: `malformed Origin header "${originHeader}"` };
      }
      const originHost = originUrl.host.toLowerCase();
      const host = (hostHeader ?? "").toLowerCase();

      if (host && originHost !== host) {
        const originHostname = originUrl.hostname.toLowerCase();
        const hostHostname = host.split(":")[0]?.toLowerCase() ?? "";
        const bothLocal =
          (originHostname === "localhost" || originHostname === "127.0.0.1") &&
          (hostHostname === "localhost" || hostHostname === "127.0.0.1");

        if (!bothLocal && !isTrustedHost(originHostname)) {
          return {
            ok: false,
            reason: `cross-origin mutating request refused: origin "${originHeader}" does not match host "${hostHeader}"`,
          };
        }
      }
    }

    const secFetchSite = request.headers["sec-fetch-site"];
    if (secFetchSite === "cross-site") {
      return { ok: false, reason: "cross-site mutating request refused via Sec-Fetch-Site" };
    }
  }

  return { ok: true };
}

export const ORIGIN_REFUSAL = (reason: string) => ({
  error: `forbidden — ${reason}`,
});
