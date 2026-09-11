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

import { type Logger, createLogger } from "@vdp/shared";
import {
  AnalysisError,
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
      return normalise(JSON.parse(text) as Partial<AnalysisResult>, this.options.model);
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

function normalise(result: Partial<AnalysisResult>, model: string | undefined): AnalysisResult {
  return {
    provider: result.provider ?? "http",
    ...(model ? { model } : {}),
    summary: result.summary ?? "",
    findings: result.findings ?? [],
    recommendations: result.recommendations ?? [],
    confidence: clamp(result.confidence ?? 0.3),
    source: "model",
    generatedAt: result.generatedAt ?? new Date().toISOString(),
    ...(result.warnings ? { warnings: result.warnings } : {}),
  };
}

function clamp(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "invalid endpoint";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
