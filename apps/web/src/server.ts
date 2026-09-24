#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { fileURLToPath } from "node:url";
import {
  type AdapterSelection,
  formatAdapterHelp,
  parseAdapterArgv,
  selectionFromPayload,
  validateSelection,
} from "@vdp/adapter-host";
import { buildReport, renderHtml, renderPdf } from "@vdp/reports";
import {
  AdapterUnsupportedError,
  ConsoleSink,
  createLogger,
  LOG_LEVEL_ORDER,
  type Logger,
  type LogLevel,
  messageOf,
  SafetyViolationError,
  StorageError,
  TransportClosedError,
  UnknownEcuError,
} from "@vdp/shared";
import { createWebAdapterCatalog, SIMULATOR_ADAPTER_ID } from "./adapters.js";
import {
  AUTH_REFUSAL,
  type Authenticator,
  createAuthenticator,
  generateEphemeralToken,
  ORIGIN_REFUSAL,
  validateRequestOrigin,
} from "./auth.js";
import { DemoBackend } from "./backend.js";
import { runDoctorCli } from "./doctor-cli.js";
import { RateLimiter } from "./rate-limit.js";
import {
  HttpError,
  parseBurstCount,
  parseCanId,
  parseDropRate,
  parseVehicleState,
} from "./route-input.js";
import {
  MIME,
  SECURITY_HEADERS,
  sendBytes,
  sendJson,
  sendTextFile,
  serveLibraryFile,
  serveStaticFile,
} from "./static-assets.js";

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Open the selected transport right after listening (default for --demo). */
  demo?: boolean;
  liveIntervalMs?: number;
  /** Directory for persisted sessions; omit to disable persistence. */
  sessionDir?: string;
  /** Adapter selected at startup; defaults to the simulator (AGENTS 29). */
  selection?: AdapterSelection;
  /** Process logger; omit to log to stdout at the level `VDP_LOG_LEVEL` names. */
  logger?: Logger;
  /**
   * API token. When set, every `/api/` route needs `Authorization: Bearer` or the
   * cookie the `?token=` exchange sets; when absent the API stays open, as it was
   * before (see `auth.ts`). From `--token=` or `VDP_API_TOKEN`.
   */
  token?: string;
  /** Automatically generate an ephemeral token if none provided and exposed. */
  ephemeralToken?: boolean;
  /** Opt-out of authentication when binding to 0.0.0.0. */
  insecureNoAuth?: boolean;
  /**
   * TLS certificate and key. When both are set, the server listens with HTTPS
   * instead of HTTP (CY-05). From `--cert=`/`--key=` or `VDP_TLS_CERT`/`VDP_TLS_KEY`.
   */
  certPath?: string;
  keyPath?: string;
  /** Rate limit options (for tests). */
  rateLimit?: { maxRequests?: number; windowMs?: number; maxStreams?: number };
}

/** The levels `VDP_LOG_LEVEL` may name, derived from the one order the logger has. */
const LOG_LEVELS = Object.keys(LOG_LEVEL_ORDER) as LogLevel[];

/**
 * The workbench process's logger: structured lines on stdout.
 *
 * `createLogger` collects records in memory and writes to the sinks it is handed —
 * with no sink, `log.warn` is a thought nobody has. Measured before this existed: a
 * session in which five modules stopped answering produced no output at all, while
 * the answers kept claiming an empty fault memory (ADR 0049).
 *
 * Attached at the process entry and not in {@link WebServer}'s constructor, because
 * stdout is the *process's* interface — the same argument the CLIs make. A class an
 * embedder or a test constructs stays quiet unless it is handed a logger that says
 * otherwise. The level comes from `VDP_LOG_LEVEL` (`TRACE`…`ERROR`); anything else,
 * or nothing, is `INFO`.
 */
export function createServerLogger(
  envLevel: string | undefined = process.env.VDP_LOG_LEVEL,
): Logger {
  const wanted = envLevel?.toUpperCase();
  const level = LOG_LEVELS.find((candidate) => candidate === wanted) ?? "INFO";
  return createLogger("web", { level }, [new ConsoleSink()]);
}

/** API payloads are small JSON documents; anything larger is a bug or an attack. */
const MAX_BODY_BYTES = 1_000_000;

export class WebServer {
  readonly backend: DemoBackend;
  private readonly log: Logger;
  readonly auth: Authenticator;
  readonly ephemeralToken?: string;
  private server?: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>;
  private readonly streams = new Set<ServerResponse>();
  private readonly rateLimiter: RateLimiter;
  private unsubscribe?: () => void;

  constructor(private readonly options: ServerOptions = {}) {
    // Built here rather than as a field initializer: parameter properties are
    // assigned after field initializers run, so `this.options` is not ready yet.
    // No sink here on purpose: see {@link createServerLogger}. The process entry
    // hands its own logger in; a WebServer built by an embedder stays silent.
    const root = this.options.logger ?? createLogger("web", { level: "INFO" });
    let token = this.options.token ?? process.env.VDP_API_TOKEN;
    if (!token && this.options.ephemeralToken === true) {
      token = generateEphemeralToken();
      this.ephemeralToken = token;
    }
    this.auth = createAuthenticator(token);
    this.rateLimiter = new RateLimiter(this.options.rateLimit);
    this.log = root.child("server");
    this.backend = new DemoBackend({
      logger: root,
      ...(this.options.liveIntervalMs === undefined
        ? {}
        : { liveIntervalMs: this.options.liveIntervalMs }),
      ...(this.options.sessionDir ? { sessionDir: this.options.sessionDir } : {}),
      ...(this.options.selection ? { selection: this.options.selection } : {}),
    });
    this.unsubscribe = this.backend.subscribe((event) => this.broadcast(event.type, event.payload));
  }

  /** Start listening; resolves once the port is bound. */
  async listen(): Promise<{ port: number; url: string }> {
    // Localhost by default (ADR 0009): a diagnostic UI without authentication
    // must not appear on the network by accident. VDP_HOST/--host opts out.
    const host = this.options.host ?? process.env.VDP_HOST ?? "127.0.0.1";
    if (host === "0.0.0.0" || host === "::") {
      // The warning names the actual state instead of a fixed sentence: with a token
      // set, "has no authentication" would be false, and a warning that lies is
      // worse than none (ADR 0049).
      this.log.warn(
        this.auth.enabled
          ? "listening on all interfaces — every /api request needs the API token"
          : "listening on all interfaces with NO API token — whoever reaches this port can " +
              "read the vehicle and trigger a write; set --token=… or VDP_API_TOKEN",
        { host, authenticated: this.auth.enabled },
      );
    }
    const certPath = this.options.certPath ?? process.env.VDP_TLS_CERT;
    const keyPath = this.options.keyPath ?? process.env.VDP_TLS_KEY;
    const useTls = Boolean(certPath && keyPath);
    let tlsOptions: { cert: string; key: string } | undefined;
    if (useTls) {
      try {
        tlsOptions = {
          cert: readFileSync(certPath as string, "utf8"),
          key: readFileSync(keyPath as string, "utf8"),
        };
        this.log.info("TLS enabled", { certPath });
      } catch (error) {
        throw new HttpError(400, `failed to read TLS cert/key: ${messageOf(error)}`);
      }
    }

    const handler = (request: IncomingMessage, response: ServerResponse) => {
      this.handle(request, response).catch((error) => {
        const status = statusFor(error);
        if (status >= 500) {
          this.log.error("request failed", { url: request.url, error: messageOf(error) });
        }
        if (!response.headersSent) sendJson(response, status, { error: messageOf(error) });
        else response.end();
      });
    };

    this.server =
      useTls && tlsOptions ? createHttpsServer(tlsOptions, handler) : createHttpServer(handler);

    await new Promise<void>((resolve) => {
      this.server?.listen(this.options.port ?? 8080, host, resolve);
    });
    const address = this.server?.address();
    const port =
      typeof address === "object" && address ? address.port : (this.options.port ?? 8080);
    if (this.options.demo) {
      await this.backend.start();
    }
    this.log.info("web server listening", {
      port,
      host,
      demo: this.options.demo === true,
      tls: useTls,
    });
    const scheme = useTls ? "https" : "http";
    return { port, url: `${scheme}://${host === "0.0.0.0" ? "localhost" : host}:${port}` };
  }

  async close(): Promise<void> {
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    this.unsubscribe?.();
    await this.backend.stop();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private broadcast(event: string, payload: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const stream of this.streams) {
      stream.write(frame);
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    // Rate limiting (CY-04) — before auth, so even unauthenticated hammering is limited.
    const ip = RateLimiter.clientIp(request);
    if (path.startsWith("/api/")) {
      const result = this.rateLimiter.checkApi(ip);
      if (!result.allowed) {
        response.writeHead(429, {
          ...SECURITY_HEADERS,
          "retry-after": String(Math.ceil((result.retryAfterMs ?? 1000) / 1000)),
        });
        response.end(JSON.stringify({ error: "too many requests — slow down" }));
        return;
      }
    }

    // Origin and Host validation (CY-02 CSRF & DNS rebinding protection)
    const originCheck = validateRequestOrigin(request, { allowedHost: this.options.host });
    if (!originCheck.ok) {
      return sendJson(
        response,
        403,
        ORIGIN_REFUSAL(originCheck.reason ?? "origin validation failed"),
      );
    }

    // The one-time exchange: the operator opens the workbench with the token in the
    // URL and gets a cookie back. Putting the token in the served HTML instead would
    // not be a token — whoever can reach the server could read it back.
    const queryToken = url.searchParams.get("token");
    if (queryToken !== null) {
      const cookie = this.auth.cookieFor(queryToken);
      if (cookie === undefined) throw new HttpError(401, "the token in the URL does not match");
      response.writeHead(302, { ...SECURITY_HEADERS, "set-cookie": cookie, location: path });
      response.end();
      return;
    }
    if (this.auth.enabled && !this.auth.isAuthorized(request))
      return sendJson(response, 401, AUTH_REFUSAL);
    if (path === "/api/stream") {
      if (request.method !== "GET") throw new HttpError(405, "the event stream is GET only");
      return this.streamEvents(request, response);
    }
    if (path.startsWith("/api/")) return this.api(request, response, path);
    if (request.method !== "GET") throw new HttpError(405, "method not allowed");
    if (path.startsWith("/lib/")) return serveLibraryFile(response, path.slice("/lib/".length));
    return serveStaticFile(response, path);
  }

  /** SSE endpoint: pushes decoded samples, raw trace entries and DTC updates. */
  private streamEvents(request: IncomingMessage, response: ServerResponse): void {
    const ip = RateLimiter.clientIp(request);
    const streamCheck = this.rateLimiter.tryOpenStream(ip);
    if (!streamCheck.allowed) {
      response.writeHead(429, SECURITY_HEADERS);
      response.end(JSON.stringify({ error: "too many streams — close one first" }));
      return;
    }

    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write("retry: 2000\n\n");
    this.streams.add(response);
    // Send the current state immediately so a reconnecting client is in sync.
    response.write(`event: state\ndata: ${JSON.stringify(this.backend.state())}\n\n`);
    const keepAlive = setInterval(() => response.write(": ping\n\n"), 15_000);
    response.on("close", () => {
      clearInterval(keepAlive);
      this.streams.delete(response);
      this.rateLimiter.closeStream(ip);
    });
  }

  private async api(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const method = request.method ?? "GET";

    if (path === "/api/state" && method === "GET")
      return sendJson(response, 200, this.backend.state());
    // Complete recording for the graph view: the live stream only carries the
    // newest samples, the graphs also have to show what happened before the
    // browser was opened (AGENTS 16 "Zeitraum auswählen").
    if (path === "/api/history" && method === "GET")
      return sendJson(response, 200, this.backend.history());

    if (path === "/api/start" && method === "POST")
      return sendJson(response, 200, await this.backend.start());

    // Adapter management (AGENTS 4, 29). Listing probes the host but never opens
    // a bus, so it is safe while a vehicle is connected.
    if (path === "/api/adapters" && method === "GET") {
      return sendJson(response, 200, {
        selected: this.backend.adapterSelection,
        mode: this.backend.currentMode,
        adapters: await this.backend.listAdapters(),
      });
    }
    if (path === "/api/adapter/select" && method === "POST") {
      const body = await this.readBody<Record<string, unknown>>(request);
      const selection = selectionFromPayload(body);
      const result = await this.backend.selectAdapter(selection);
      return sendJson(response, 200, {
        adapter: result.description,
        reconnectRequired: result.reconnectRequired,
        connected: this.backend.state().connected,
      });
    }
    if (path === "/api/identify" && method === "POST")
      return sendJson(response, 200, { ecus: await this.backend.identify() });

    // Which vehicle is connected (AGENTS 11). A query, never a write: the answer
    // is a ranked list of hypotheses with the evidence behind each of them, and
    // "nothing matches the installed definitions" is a valid answer.
    if (path === "/api/vehicle/resolve" && method === "POST")
      return sendJson(response, 200, { resolution: await this.backend.resolveVehicle() });
    if (path === "/api/vehicle/resolve" && method !== "POST")
      throw new HttpError(405, "resolving a vehicle is POST only");
    // Both halves of the scan (ADR 0049): `dtcs` is what was read, `unread` which
    // modules did not answer. A 200 with an empty `dtcs` and a non-empty `unread`
    // is the honest shape of "I could not ask anybody" — not an error, and not
    // "the car has no faults".
    if (path === "/api/dtc/scan" && method === "POST")
      return sendJson(response, 200, await this.backend.scanDtcs());

    // Fault details and the only write path so far (AGENTS 20, 25, 26).
    if (path === "/api/dtc/snapshot" && method === "POST") {
      const body = await this.readBody<{ rxId?: string; code?: string; recordNumber?: number }>(
        request,
      );
      const rxId = parseCanId(body.rxId);
      if (!body.code) throw new HttpError(400, "a DTC code is required");
      return sendJson(response, 200, {
        snapshot: await this.backend.readFreezeFrame(rxId, body.code, body.recordNumber ?? 0xff),
      });
    }
    if (path === "/api/dtc/clear/precheck" && method === "POST") {
      const body = await this.readBody<{ rxId?: string; vehicleState?: Record<string, unknown> }>(
        request,
      );
      const rxId = parseCanId(body.rxId);
      return sendJson(response, 200, {
        precheck: await this.backend.precheckDtcClear(rxId, parseVehicleState(body.vehicleState)),
      });
    }
    if (path === "/api/dtc/clear" && method === "POST") {
      const body = await this.readBody<{
        rxId?: string;
        confirmed?: boolean;
        vehicleState?: Record<string, unknown>;
      }>(request);
      const rxId = parseCanId(body.rxId);
      const result = await this.backend.clearDtcs(rxId, {
        confirmed: body.confirmed === true,
        vehicleState: parseVehicleState(body.vehicleState),
      });
      return sendJson(response, 200, { result });
    }

    // Guided Diagnosis (Task 6)
    if (path === "/api/guided-diagnosis" && (method === "GET" || method === "POST")) {
      const state = await this.backend.guidedDiagnosis();
      return sendJson(response, 200, { state });
    }
    if (path === "/api/guided-diagnosis/step" && method === "POST") {
      const body = await this.readBody<{ signalId?: string; value?: number }>(request);
      const state = await this.backend.guidedDiagnosis(
        body.signalId && body.value !== undefined
          ? { signalId: body.signalId, value: body.value }
          : undefined,
      );
      return sendJson(response, 200, { state });
    }

    // ECU Coding & Adaptation (Task 8)
    if (path === "/api/coding/precheck" && method === "POST") {
      const body = await this.readBody<{
        rxId?: string;
        did?: number;
        data?: string;
        vehicleState?: Record<string, unknown>;
      }>(request);
      const rxId = parseCanId(body.rxId);
      const did = body.did ?? 0x0100;
      const data = body.data ?? "";
      const precheck = await this.backend.precheckCoding(
        rxId,
        did,
        data,
        parseVehicleState(body.vehicleState),
      );
      return sendJson(response, 200, { precheck });
    }
    if (path === "/api/coding/write" && method === "POST") {
      const body = await this.readBody<{
        rxId?: string;
        did?: number;
        data?: string;
        confirmed?: boolean;
        vehicleState?: Record<string, unknown>;
      }>(request);
      const rxId = parseCanId(body.rxId);
      const did = body.did ?? 0x0100;
      const data = body.data ?? "";
      const result = await this.backend.writeCoding(
        rxId,
        did,
        data,
        body.confirmed === true,
        parseVehicleState(body.vehicleState),
      );
      return sendJson(response, 200, { result });
    }
    if (path === "/api/adaptation/precheck" && method === "POST") {
      const body = await this.readBody<{
        rxId?: string;
        did?: number;
        value?: number;
        vehicleState?: Record<string, unknown>;
      }>(request);
      const rxId = parseCanId(body.rxId);
      const did = body.did ?? 0x0100;
      const value = body.value ?? 0;
      const precheck = await this.backend.precheckAdaptation(
        rxId,
        did,
        value,
        parseVehicleState(body.vehicleState),
      );
      return sendJson(response, 200, { precheck });
    }
    if (path === "/api/adaptation/write" && method === "POST") {
      const body = await this.readBody<{
        rxId?: string;
        did?: number;
        value?: number;
        confirmed?: boolean;
        vehicleState?: Record<string, unknown>;
      }>(request);
      const rxId = parseCanId(body.rxId);
      const did = body.did ?? 0x0100;
      const value = body.value ?? 0;
      const result = await this.backend.writeAdaptation(
        rxId,
        did,
        value,
        body.confirmed === true,
        parseVehicleState(body.vehicleState),
      );
      return sendJson(response, 200, { result });
    }

    // Signal Analysis & Anomaly Detection (Task 5)
    if (path.startsWith("/api/analysis/signal") && method === "GET") {
      const url = new URL(request.url ?? "/", "http://localhost");
      const signalId = url.searchParams.get("signalId") ?? "engine.speed";
      const analysis = this.backend.analyzeSignal(signalId);
      return sendJson(response, 200, { analysis });
    }

    // Chaos Lab Controls (Task 4)
    if (path === "/api/chaos/inject" && method === "POST") {
      // Ids and counts are the operator's input like every other address in this API:
      // both spellings through one grammar, and a burst count that is not a positive
      // integer is a refusal with a sentence instead of an armed rule of `NaN` frames.
      const body = await this.readBody<{
        dropBurst?: number;
        dropBurstCanId?: number | string;
        dropRate?: number;
        corruptSequenceCanId?: number | string;
      }>(request);
      const dropBurstCanId =
        body.dropBurstCanId === undefined ? undefined : parseCanId(body.dropBurstCanId);
      const corruptSequenceCanId =
        body.corruptSequenceCanId === undefined ? undefined : parseCanId(body.corruptSequenceCanId);
      this.backend.injectChaos({
        ...(body.dropBurst === undefined ? {} : { dropBurst: parseBurstCount(body.dropBurst) }),
        ...(dropBurstCanId === undefined ? {} : { dropBurstCanId }),
        ...(body.dropRate === undefined ? {} : { dropRate: parseDropRate(body.dropRate) }),
        ...(corruptSequenceCanId === undefined ? {} : { corruptSequenceCanId }),
      });
      return sendJson(response, 200, { status: this.backend.chaosStatus() });
    }
    if (path === "/api/chaos/reset" && method === "POST") {
      this.backend.resetChaos();
      return sendJson(response, 200, { status: this.backend.chaosStatus() });
    }
    if (path === "/api/chaos/status" && method === "GET") {
      return sendJson(response, 200, { status: this.backend.chaosStatus() });
    }

    // Scenario engine (AGENTS 32): the catalog, and one run on the virtual vehicle.
    if (path === "/api/simulator/scenarios" && method === "GET") {
      // The catalog view *is* the response body: `scenarios`, `options`, `note` — the
      // projection runs in `backend.ts`, so the route stays a route (ADR 0014).
      return sendJson(response, 200, this.backend.scenarios());
    }
    if (path === "/api/simulator/scenario" && method === "POST") {
      const body = await this.readBody<{ id?: string }>(request);
      const id = typeof body.id === "string" ? body.id : "";
      if (id.trim().length === 0) {
        return sendJson(response, 400, { error: "a scenario run needs an id" });
      }
      const result = await this.backend.runScenario(id);
      if (!result.ok) return sendJson(response, 409, { error: result.error });
      return sendJson(response, 200, { run: result.run, panel: result.panel });
    }

    if (path === "/api/live/start" && method === "POST") {
      const body = await this.readBody<{ signalIds?: string[] }>(request);
      await this.backend.startLive(body.signalIds);
      return sendJson(response, 200, { live: true });
    }
    if (path === "/api/live/stop" && method === "POST") {
      this.backend.stopLive();
      return sendJson(response, 200, { live: false });
    }
    if (path === "/api/marker" && method === "POST") {
      const body = await this.readBody<{ label?: string }>(request);
      this.backend.addMarker(body.label ?? "marker");
      return sendJson(response, 200, { ok: true });
    }
    if (path === "/api/analyze" && method === "POST")
      return sendJson(response, 200, await this.backend.analyze());

    // Session persistence (AGENTS 10, 17, 29)
    if (path === "/api/session/save" && method === "POST")
      return sendJson(response, 200, await this.backend.saveSession());
    if (path === "/api/sessions" && method === "GET")
      return sendJson(response, 200, { sessions: await this.backend.listSessions() });
    if (path.startsWith("/api/session/") && path.endsWith("/package") && method === "GET") {
      const id = path.slice("/api/session/".length, -"/package".length);
      const bytes = await this.backend.sessionPackage(id);
      return sendBytes(response, `session-${id}.zip`, "application/zip", bytes);
    }

    if (path === "/api/export/measurements.csv")
      return sendTextFile(
        response,
        "measurements.csv",
        "text/csv; charset=utf-8",
        this.backend.exportCsv(),
      );
    if (path === "/api/export/trace.csv")
      return sendTextFile(
        response,
        "raw-trace.csv",
        "text/csv; charset=utf-8",
        this.backend.exportTraceCsv(),
      );
    if (path === "/api/export/session.json")
      return sendTextFile(
        response,
        "session.json",
        "application/json; charset=utf-8",
        this.backend.exportJson(),
      );

    if (path === "/api/export/report.html" || path === "/api/export/report.pdf") {
      const state = this.backend.state();
      const document = buildReport({
        session: this.backend.sessionData(),
        // `hint` is the documented next step from the definition package; dropping
        // it here is what made every recommendation fall back to the generic line
        // while the fault list next to it carried the advice (ADR 0026).
        dtcs: state.dtcs.map((dtc) => ({
          code: dtc.code,
          description: dtc.description,
          severity: dtc.severity,
          ecu: dtc.ecu,
          ...(dtc.hint !== undefined ? { hint: dtc.hint } : {}),
        })),
        statistics: state.statistics,
        anomalies: state.anomalies,
      });
      if (path.endsWith(".pdf")) {
        const bytes = renderPdf(document);
        return sendBytes(response, "diagnostic-report.pdf", "application/pdf", bytes);
      }
      return sendTextFile(
        response,
        "diagnostic-report.html",
        MIME[".html"] ?? "text/html",
        renderHtml(document),
      );
    }

    sendJson(response, 404, { error: `no route ${method} ${path}` });
  }

  /**
   * Reads and parses a JSON request body, with a size ceiling.
   *
   * The ceiling is checked while the body streams in, not after: a body that is
   * never going to be acceptable must not be buffered first.
   */
  private async readBody<T>(request: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      total += (chunk as Buffer).length;
      if (total > MAX_BODY_BYTES)
        throw new HttpError(413, `request body exceeds the ${MAX_BODY_BYTES} byte limit`);
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {} as T;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch {
      throw new HttpError(400, "request body is not valid JSON");
    }
  }
}

/**
 * Map a domain error to an HTTP status.
 *
 * A rejected adapter selection or a refused write is the caller's problem (4xx),
 * not a server fault: reporting it as 500 would hide a fixable configuration
 * mistake behind "internal error" and make the UI show the wrong advice.
 */
function statusFor(error: unknown): number {
  if (error instanceof HttpError) return error.statusCode;
  if (error instanceof AdapterUnsupportedError) return 400;
  if (error instanceof SafetyViolationError) return 403;
  if (error instanceof StorageError) return 404;
  // A wrong address is the operator's to fix, not the server's to explain: 409 says
  // "this is not the state this session is in" (E23), where 500 said "something broke".
  if (error instanceof UnknownEcuError) return 409;
  // Same class as the unknown address above: the operator asked a connection that is not
  // open for something (chaos on a bus that does not run yet) — 409, not a server defect.
  if (error instanceof TransportClosedError) return 409;
  return 500;
}

/**
 * Server CLI.
 *
 * Two kinds of flags: workbench settings (port, host, sessions, interval) and
 * adapter settings (`--adapter`, `--device`, …). The adapter flags are parsed by
 * the adapter layer itself, so the option names and their validation cannot
 * drift apart from what the adapters actually accept.
 */
function parseArgs(argv: readonly string[]): ServerOptions {
  const options: ServerOptions = {};
  for (const arg of argv) {
    if (arg === "--demo") options.demo = true;
    else if (arg === "--no-autostart") options.demo = false;
    else if (arg.startsWith("--port=")) options.port = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith("--host=")) options.host = arg.slice(7);
    else if (arg.startsWith("--interval="))
      options.liveIntervalMs = Number.parseInt(arg.slice(11), 10);
    else if (arg.startsWith("--sessions=")) options.sessionDir = arg.slice(11);
    else if (arg.startsWith("--token=")) options.token = arg.slice(8);
    else if (arg === "--generate-token") options.ephemeralToken = true;
    else if (arg === "--insecure" || arg === "--no-auth") options.insecureNoAuth = true;
    else if (arg.startsWith("--cert=")) options.certPath = arg.slice(7);
    else if (arg.startsWith("--key=")) options.keyPath = arg.slice(6);
  }
  const parsed = parseAdapterArgv(argv, SIMULATOR_ADAPTER_ID);
  if (parsed.errors.length > 0) throw new HttpError(400, parsed.errors.join("; "));
  options.selection = parsed.selection;
  // Naming an adapter means "use it": auto-start only stays on for the
  // simulator, which needs no hardware and no confirmation.
  if (parsed.selection.id === SIMULATOR_ADAPTER_ID && options.demo === undefined)
    options.demo = true;
  return options;
}

/** Settings that were given but cannot be used, e.g. a typo in the adapter id. */
function validateStartupSelection(options: ServerOptions): string[] {
  const catalog = createWebAdapterCatalog();
  const validation = validateSelection(
    catalog,
    options.selection ?? { id: SIMULATOR_ADAPTER_ID, config: {} },
  );
  return validation.ok ? [] : validation.errors;
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const log = createServerLogger();
  const catalog = createWebAdapterCatalog();

  if (argv.includes("--list-adapters")) {
    const selection = parseAdapterArgv(argv, SIMULATOR_ADAPTER_ID).selection;
    const described = await catalog.describeAll(selection.config);
    process.stdout.write(`${formatAdapterHelp(catalog)}\n\nAvailability on this host:\n`);
    for (const entry of described) {
      process.stdout.write(
        `  ${entry.id.padEnd(10)} ${entry.probe.available ? "ready  " : "unusable"} ${entry.probe.detail}\n`,
      );
      for (const hint of entry.probe.hints ?? []) process.stdout.write(`             → ${hint}\n`);
    }
    process.exit(0);
  }

  if (argv.includes("--doctor")) {
    // Pre-flight check for the hardware day (owned by doctor-cli.ts):
    // exit 0 ready · 2 usage · 3 adapter needs attention — the same codes the
    // harvest CLI uses, so an automation can branch on one scheme.
    process.exit(await runDoctorCli(argv, { catalog, logger: log }));
  }

  let options: ServerOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n\n${formatAdapterHelp(catalog)}\n`);
    process.exit(2);
  }

  const problems = validateStartupSelection(options);
  if (problems.length > 0) {
    process.stderr.write(
      `invalid adapter settings:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n\n${formatAdapterHelp(catalog)}\n`,
    );
    process.exit(2);
  }

  // Sessions land in a local, gitignored directory unless told otherwise.
  const server = new WebServer({ sessionDir: "sessions-local", logger: log, ...options });
  const { url } = await server.listen();
  if (server.ephemeralToken) {
    process.stdout.write(`ephemeral API token: ${server.ephemeralToken}\n`);
    process.stdout.write(`open URL with token:  ${url}/?token=${server.ephemeralToken}\n`);
  }
  const selection = server.backend.adapterSelection;
  process.stdout.write(`yes-you-CAN workbench listening on ${url}\n`);
  process.stdout.write(
    `adapter: ${selection.id} (mode ${server.backend.currentMode})${selection.config.device ? ` · ${selection.config.device}` : ""}\n`,
  );
  if (server.backend.currentMode === "simulator") {
    process.stdout.write(
      "kein Fahrzeug nötig — Hardware mit --list-adapters prüfen und mit --adapter=<id> --device=<pfad> verbinden\n",
    );
  }
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    await server
      .close()
      .catch((error: unknown) => log.warn("shutdown failed", { error: messageOf(error) }));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
