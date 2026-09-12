/**
 * HTTP analysis provider (AGENTS 22).
 *
 * Forwards the (already redacted) analysis input to a model gateway. The
 * transport is injected so it can be tested without a network and so an
 * installation can pin a specific client, proxy or certificate bundle.
 *
 * Privacy (AGENTS 27): the VIN is removed before the request unless the caller
 * explicitly opted in, and the endpoint is logged so a user can see where data
 * went.
 */

import { type Logger, createLogger, messageOf } from "@vdp/shared";
import {
  AnalysisError,
  type AnalysisFinding,
  type AnalysisInput,
  type AnalysisProvider,
  type AnalysisResult,
} from "./types.js";

export interface HttpClient {
  fetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
  ): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

export interface HttpAnalysisProviderOptions {
  endpoint: string;
  /** Model identifier passed to the gateway. */
  model?: string;
  /** Sent as `Authorization: Bearer <token>`. Kept out of logs. */
  apiKey?: string;
  timeoutMs?: number;
  httpClient?: HttpClient;
  logger?: Logger;
  /**
   * Send the VIN to the model. Off by default — a workshop analysis almost never
   * needs the vehicle's identity, and this is personal data (AGENTS 27).
   */
  sendVin?: boolean;
}

export class HttpAnalysisProvider implements AnalysisProvider {
  readonly id = "http";
  readonly label: string;
  readonly sendsDataOffBox = true;
  private readonly log: Logger;

  constructor(private readonly options: HttpAnalysisProviderOptions) {
    this.label = `Model gateway (${safeHost(options.endpoint)})`;
    this.log = (options.logger ?? createLogger("ai", { level: "INFO" })).child("ai");
  }

  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    const payload = this.options.sendVin ? input : redactVin(input);
    const body = JSON.stringify({
      ...(this.options.model ? { model: this.options.model } : {}),
      input: payload,
      instruction:
        "You are assisting a vehicle diagnostics technician. Answer from the supplied measurements and fault codes only. " +
        "State uncertainty explicitly and never invent measured values.",
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);
    this.log.info("analysis request", {
      endpoint: this.options.endpoint,
      vinIncluded: this.options.sendVin === true,
      signals: payload.signals.length,
      dtcs: payload.dtcs.length,
    });

    try {
      const response = await (this.options.httpClient ?? defaultHttpClient()).fetch(
        this.options.endpoint,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          },
          body,
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new AnalysisError(`analysis gateway returned ${response.status}`, {
          status: response.status,
        });
      }
      const text = await response.text();
      // No cast: a gateway answer is external input (AGENTS 24) and `normalise`
      // checks it field by field.
      return normalise(JSON.parse(text), this.options.model);
    } catch (error) {
      if (error instanceof AnalysisError) throw error;
      throw new AnalysisError(`analysis request failed: ${messageOf(error)}`, {
        endpoint: this.options.endpoint,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Replace the VIN with a placeholder without touching anything else. */
export function redactVin(input: AnalysisInput): AnalysisInput {
  if (!input.vehicle?.vin) return input;
  return { ...input, vehicle: { ...input.vehicle, vin: "[redacted]" } };
}

/** Severities a finding may carry; anything else is downgraded to `info`. */
const SEVERITIES: readonly string[] = ["info", "minor", "major", "critical"];

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A string, number, array or null is not an answer — then: empty object. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A timestamp a printed report can actually show. */
function isTimestamp(value: unknown): value is string {
  return isText(value) && !Number.isNaN(Date.parse(value));
}

/**
 * One finding with safe defaults: a gateway that forgets `detail` or invents a
 * severity must break neither the report nor the view that renders it.
 */
function toFinding(raw: unknown, index: number): AnalysisFinding {
  const record = asRecord(raw);
  const relatedSignals = asArray(record.relatedSignals).filter(isText);
  const relatedDtcs = asArray(record.relatedDtcs).filter(isText);
  return {
    id: isText(record.id) ? record.id : `finding-${index}`,
    severity: SEVERITIES.includes(String(record.severity))
      ? (record.severity as AnalysisFinding["severity"])
      : "info",
    title: isText(record.title) ? record.title : "",
    detail: isText(record.detail) ? record.detail : "",
    ...(Array.isArray(record.relatedSignals) ? { relatedSignals } : {}),
    ...(Array.isArray(record.relatedDtcs) ? { relatedDtcs } : {}),
  };
}

/**
 * Turns a gateway answer into an `AnalysisResult`.
 *
 * The answer used to arrive as a cast straight from `JSON.parse`, so something
 * like `{"findings":"none"}` put a string where the service reads `.length` and
 * the report renders a list. Every field is checked now; an unusable answer
 * degrades to an empty result instead of poisoning the session.
 */
function normalise(answer: unknown, model: string | undefined): AnalysisResult {
  const result = asRecord(answer);
  return {
    provider: isText(result.provider) ? result.provider : "http",
    ...(model ? { model } : {}),
    summary: isText(result.summary) ? result.summary : "",
    findings: asArray(result.findings).map(toFinding),
    recommendations: asArray(result.recommendations).filter(isText),
    confidence: clamp(result.confidence ?? 0.3),
    source: "model",
    generatedAt: isTimestamp(result.generatedAt) ? result.generatedAt : new Date().toISOString(),
    ...(Array.isArray(result.warnings)
      ? { warnings: asArray(result.warnings).filter(isText) }
      : {}),
  };
}

/**
 * Confidence into `[0, 1]`, taken as `unknown` because it comes from outside.
 *
 * `Number.isNaN` does not coerce, so `"confidence": "high"` used to come out as
 * `NaN`: `Math.max(0, "high")` is `NaN`, `JSON.stringify` wrote `null`, and the
 * view showed no confidence at all. Anything that is not a finite number now
 * means "no confidence" — deterministic instead of quietly broken.
 */
function clamp(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "invalid endpoint";
  }
}

function defaultHttpClient(): HttpClient {
  return {
    async fetch(url, init) {
      const response = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
      });
      return { ok: response.ok, status: response.status, text: () => response.text() };
    },
  };
}
