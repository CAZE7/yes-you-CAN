#!/usr/bin/env node
/**
 * Diagnostic workbench server (AGENTS 16).
 *
 * Plain Node HTTP + Server-Sent Events and a vanilla ESM front end — no build
 * step, no framework, no WebSocket server. Live values are pushed as SSE events;
 * everything else is a normal request/response pair.
 *
 * Security baseline (ADR 0009): binds localhost by default — pass --host or set
 * VDP_HOST to expose it on the network. Every response carries a strict header
 * set, request bodies are size-limited, and the event stream is GET-only.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, type Logger } from '@vdp/shared';
import { buildReport, renderHtml, renderPdf } from '@vdp/reports';
import { DemoBackend } from './backend.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Start the simulated vehicle immediately (default for --demo). */
  demo?: boolean;
  liveIntervalMs?: number;
  /** Directory for persisted sessions; omit to disable persistence. */
  sessionDir?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
};

/** API payloads are small JSON documents; anything larger is a bug or an attack. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Sent with every response — static assets, JSON, SSE and downloads alike.
 * The CSP can be strict because the front end is fully static: external
 * CSS/JS only, no inline handlers, same-origin fetch and EventSource.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

/** Error carrying the HTTP status the request should fail with. */
class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

// Compiled file lives at apps/web/dist/src/server.js, so the public directory is
// two levels up. Overridable for packaged installs.
const PUBLIC_DIR = process.env.VDP_PUBLIC_DIR
  ? process.env.VDP_PUBLIC_DIR
  : fileURLToPath(new URL('../../public/', import.meta.url));

export class WebServer {
  readonly backend: DemoBackend;
  private readonly log: Logger;
  private server?: ReturnType<typeof createServer>;
  private readonly streams = new Set<ServerResponse>();
  private unsubscribe?: () => void;

  constructor(private readonly options: ServerOptions = {}) {
    // Built here rather than as a field initializer: parameter properties are
    // assigned after field initializers run, so `this.options` is not ready yet.
    this.log = createLogger('web', { level: 'INFO' }).child('server');
    this.backend = new DemoBackend({
      liveIntervalMs: this.options.liveIntervalMs,
      ...(this.options.sessionDir ? { sessionDir: this.options.sessionDir } : {}),
    });
    this.unsubscribe = this.backend.subscribe((event) => this.broadcast(event.type, event.payload));
  }

  /** Start listening; resolves once the port is bound. */
  async listen(): Promise<{ port: number; url: string }> {
    // Localhost by default (ADR 0009): a diagnostic UI without authentication
    // must not appear on the network by accident. VDP_HOST/--host opts out.
    const host = this.options.host ?? process.env.VDP_HOST ?? '127.0.0.1';
    if (host === '0.0.0.0' || host === '::') {
      this.log.warn('listening on all interfaces — the workbench has no authentication, restrict network access', { host });
    }
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        const status = error instanceof HttpError ? error.statusCode : 500;
        if (status >= 500) {
          this.log.error('request failed', { url: request.url, error: messageOf(error) });
        }
        if (!response.headersSent) this.sendJson(response, status, { error: messageOf(error) });
        else response.end();
      });
    });

    await new Promise<void>((resolve) => {
      this.server?.listen(this.options.port ?? 8080, host, resolve);
    });
    const address = this.server?.address();
    const port = typeof address === 'object' && address ? address.port : (this.options.port ?? 8080);
    if (this.options.demo) {
      await this.backend.start();
    }
    this.log.info('web server listening', { port, host, demo: this.options.demo === true });
    return { port, url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}` };
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
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/api/stream') {
      if (request.method !== 'GET') throw new HttpError(405, 'the event stream is GET only');
      return this.streamEvents(request, response);
    }
    if (path.startsWith('/api/')) return this.api(request, response, path);
    if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
    return this.staticFile(response, path);
  }

  /** SSE endpoint: pushes decoded samples, raw trace entries and DTC updates. */
  private streamEvents(_request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write(`retry: 2000\n\n`);
    this.streams.add(response);
    // Send the current state immediately so a reconnecting client is in sync.
    response.write(`event: state\ndata: ${JSON.stringify(this.backend.state())}\n\n`);
    const keepAlive = setInterval(() => response.write(': ping\n\n'), 15_000);
    response.on('close', () => {
      clearInterval(keepAlive);
      this.streams.delete(response);
    });
  }

  private async api(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const method = request.method ?? 'GET';

    if (path === '/api/state' && method === 'GET') return this.sendJson(response, 200, this.backend.state());

    if (path === '/api/start' && method === 'POST') return this.sendJson(response, 200, await this.backend.start());
    if (path === '/api/identify' && method === 'POST') return this.sendJson(response, 200, { ecus: await this.backend.identify() });
    if (path === '/api/dtc/scan' && method === 'POST') return this.sendJson(response, 200, { dtcs: await this.backend.scanDtcs() });

    if (path === '/api/live/start' && method === 'POST') {
      const body = await this.readBody<{ signalIds?: string[] }>(request);
      await this.backend.startLive(body.signalIds);
      return this.sendJson(response, 200, { live: true });
    }
    if (path === '/api/live/stop' && method === 'POST') {
      this.backend.stopLive();
      return this.sendJson(response, 200, { live: false });
    }
    if (path === '/api/marker' && method === 'POST') {
      const body = await this.readBody<{ label?: string }>(request);
      this.backend.addMarker(body.label ?? 'marker');
      return this.sendJson(response, 200, { ok: true });
    }
    if (path === '/api/analyze' && method === 'POST') return this.sendJson(response, 200, await this.backend.analyze());

    // Session persistence (AGENTS 10, 17, 29)
    if (path === '/api/session/save' && method === 'POST') return this.sendJson(response, 200, await this.backend.saveSession());
    if (path === '/api/sessions' && method === 'GET') return this.sendJson(response, 200, { sessions: await this.backend.listSessions() });
    if (path.startsWith('/api/session/') && path.endsWith('/package') && method === 'GET') {
      const id = path.slice('/api/session/'.length, -'/package'.length);
      const bytes = await this.backend.sessionPackage(id);
      return this.sendBytes(response, `session-${id}.zip`, 'application/zip', bytes);
    }

    if (path === '/api/export/measurements.csv') return this.sendFile(response, 'measurements.csv', 'text/csv; charset=utf-8', this.backend.exportCsv());
    if (path === '/api/export/trace.csv') return this.sendFile(response, 'raw-trace.csv', 'text/csv; charset=utf-8', this.backend.exportTraceCsv());
    if (path === '/api/export/session.json') return this.sendFile(response, 'session.json', 'application/json; charset=utf-8', this.backend.exportJson());

    if (path === '/api/export/report.html' || path === '/api/export/report.pdf') {
      const state = this.backend.state();
      const document = buildReport({
        session: this.backend.sessionData(),
        dtcs: state.dtcs.map((dtc) => ({ code: dtc.code, description: dtc.description, severity: dtc.severity, ecu: dtc.ecu })),
        statistics: state.statistics,
        anomalies: state.anomalies,
      });
      if (path.endsWith('.pdf')) {
        const bytes = renderPdf(document);
        return this.sendBytes(response, 'diagnostic-report.pdf', 'application/pdf', bytes);
      }
      return this.sendFile(response, 'diagnostic-report.html', MIME['.html'] ?? 'text/html', renderHtml(document));
    }

    this.sendJson(response, 404, { error: `no route ${method} ${path}` });
  }

  private async staticFile(response: ServerResponse, path: string): Promise<void> {
    const relative = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    // Reject anything that would escape the public directory.
    const resolved = normalize(join(PUBLIC_DIR, relative));
    if (!resolved.startsWith(normalize(PUBLIC_DIR))) {
      this.sendJson(response, 403, { error: 'forbidden' });
      return;
    }
    try {
      const content = await readFile(resolved);
      response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME[extname(resolved)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      response.end(content);
    } catch {
      this.sendJson(response, 404, { error: `not found: ${path}` });
    }
  }

  private sendJson(response: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': MIME['.json'] ?? 'application/json', 'cache-control': 'no-cache' });
    response.end(body);
  }

  private sendFile(response: ServerResponse, filename: string, contentType: string, content: string): void {
    this.sendBytes(response, filename, contentType, new TextEncoder().encode(content));
  }

  private sendBytes(response: ServerResponse, filename: string, contentType: string, bytes: Uint8Array): void {
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': contentType,
      'content-length': String(bytes.length),
      'content-disposition': `attachment; filename="${filename}"`,
    });
    response.end(bytes);
  }

  private async readBody<T>(request: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      total += (chunk as Buffer).length;
      if (total > MAX_BODY_BYTES) throw new HttpError(413, `request body exceeds the ${MAX_BODY_BYTES} byte limit`);
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {} as T;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
    } catch {
      throw new HttpError(400, 'request body is not valid JSON');
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv: readonly string[]): ServerOptions {
  const options: ServerOptions = {};
  for (const arg of argv) {
    if (arg === '--demo') options.demo = true;
    else if (arg.startsWith('--port=')) options.port = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith('--host=')) options.host = arg.slice(7);
    else if (arg.startsWith('--interval=')) options.liveIntervalMs = Number.parseInt(arg.slice(11), 10);
    else if (arg.startsWith('--sessions=')) options.sessionDir = arg.slice(11);
  }
  return options;
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  // Sessions land in a local, gitignored directory unless told otherwise.
  const server = new WebServer({ demo: true, sessionDir: 'sessions-local', ...options });
  const { url } = await server.listen();
  process.stdout.write(`yes-you-CAN workbench listening on ${url}\n`);
  process.on('SIGINT', () => {
    void server.close().then(() => process.exit(0));
  });
}
