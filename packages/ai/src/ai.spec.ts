import assert from "node:assert/strict";
import { createLogger } from "@vdp/shared";
import { test } from "vitest";
import {
  AnalysisError,
  type AnalysisInput,
  AnalysisService,
  HeuristicAnalysisProvider,
  HttpAnalysisProvider,
  type HttpClient,
  redactVin,
} from "./index.js";

const logger = createLogger("ai", { level: "ERROR" });

function sampleInput(overrides: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    vehicle: { brand: "Honda", model: "Accord", modelYear: 2003, vin: "1HGCM82633A004352" },
    mileageKm: 187_450,
    signals: [
      {
        signal: "engine.rpm",
        name: "Engine speed",
        unit: "rpm",
        samples: 40,
        min: 780,
        max: 4200,
        average: 900,
        delta: 3420,
        outOfRangeCount: 0,
      },
      {
        signal: "engine.coolant_temperature",
        name: "Coolant temperature",
        unit: "°C",
        samples: 40,
        min: 88,
        max: 92,
        average: 90,
        delta: 4,
        outOfRangeCount: 2,
      },
      {
        signal: "engine.fuel_trim_long_term",
        name: "Long term fuel trim",
        unit: "%",
        samples: 2,
        min: -8,
        max: 12,
        average: 2,
        delta: 20,
        outOfRangeCount: 0,
      },
    ],
    dtcs: [
      {
        code: "P0420",
        severity: "major",
        ecu: "Engine",
        description: "Catalyst system efficiency below threshold",
      },
    ],
    anomalies: [{ signal: "engine.rpm", reason: "delta 3420 far above median" }],
    notes: ["Rough idle when cold."],
    ...overrides,
  };
}

test("the heuristic provider reports DTCs, ranges and spreads with evidence", async () => {
  const provider = new HeuristicAnalysisProvider();
  const result = await provider.analyze(sampleInput());
  assert.equal(result.source, "heuristic");
  assert.equal(result.provider, "heuristic");
  assert.ok(
    result.findings.some((finding) => finding.id === "dtc-P0420" && finding.severity === "major"),
  );
  assert.ok(result.findings.some((finding) => finding.id === "range-engine.coolant_temperature"));
  assert.ok(result.findings.some((finding) => finding.id === "spread-engine.rpm"));
  assert.ok(
    result.findings.some((finding) => finding.id === "low-samples-engine.fuel_trim_long_term"),
  );
  assert.ok(result.recommendations.some((entry) => entry.startsWith("P0420")));
  assert.ok(result.confidence > 0 && result.confidence <= 1);
  assert.ok(result.warnings?.length);
});

test("a clean recording yields a single informational finding", async () => {
  const provider = new HeuristicAnalysisProvider();
  const result = await provider.analyze(
    sampleInput({
      dtcs: [],
      anomalies: [],
      signals: [
        {
          signal: "engine.rpm",
          name: "Engine speed",
          unit: "rpm",
          samples: 50,
          min: 780,
          max: 820,
          average: 800,
          delta: 40,
          outOfRangeCount: 0,
        },
      ],
    }),
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.id, "no-findings");
  assert.ok(result.recommendations.some((entry) => entry.includes("No action required")));
});

test("the heuristic provider never sends data off-box", () => {
  const provider = new HeuristicAnalysisProvider();
  assert.equal(provider.sendsDataOffBox, false);
});

test("the VIN is redacted before it reaches an HTTP provider", async () => {
  let sentBody = "";
  const httpClient: HttpClient = {
    async fetch(_url, init) {
      sentBody = init.body;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ summary: "ok", findings: [], recommendations: [], confidence: 0.7 }),
      };
    },
  };
  const provider = new HttpAnalysisProvider({
    endpoint: "https://gateway.example/analyze",
    model: "test-model",
    httpClient,
    logger,
  });
  const result = await provider.analyze(sampleInput());
  assert.ok(!sentBody.includes("1HGCM82633A004352"), "VIN must not leave the box by default");
  assert.ok(sentBody.includes("[redacted]"));
  assert.equal(result.source, "model");
  assert.equal(result.model, "test-model");
  assert.equal(result.confidence, 0.7);
  assert.equal(provider.sendsDataOffBox, true);
});

test("the VIN can be sent only with an explicit opt-in", async () => {
  let sentBody = "";
  const httpClient: HttpClient = {
    async fetch(_url, init) {
      sentBody = init.body;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ summary: "ok", findings: [], recommendations: [] }),
      };
    },
  };
  const provider = new HttpAnalysisProvider({
    endpoint: "https://gateway.example/analyze",
    httpClient,
    sendVin: true,
    logger,
  });
  await provider.analyze(sampleInput());
  assert.ok(sentBody.includes("1HGCM82633A004352"));
});

test("the API key is sent as a bearer header and never appears in the body", async () => {
  let authHeader = "";
  const httpClient: HttpClient = {
    async fetch(_url, init) {
      authHeader = init.headers["authorization"] ?? "";
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ summary: "ok", findings: [], recommendations: [] }),
      };
    },
  };
  const provider = new HttpAnalysisProvider({
    endpoint: "https://gateway.example/analyze",
    apiKey: "secret-token",
    httpClient,
    logger,
  });
  await provider.analyze(sampleInput({ dtcs: [], anomalies: [], signals: [] }));
  assert.equal(authHeader, "Bearer secret-token");
});

test("gateway errors surface as AnalysisError with the status code", async () => {
  const httpClient: HttpClient = {
    async fetch() {
      return { ok: false, status: 503, text: async () => "unavailable" };
    },
  };
  const provider = new HttpAnalysisProvider({
    endpoint: "https://gateway.example/analyze",
    httpClient,
    logger,
  });
  await assert.rejects(provider.analyze(sampleInput({ signals: [] })), (error: unknown) => {
    assert.ok(error instanceof AnalysisError);
    assert.match(error.message, /503/);
    return true;
  });
});

test("network failures are wrapped, not leaked raw", async () => {
  const httpClient: HttpClient = {
    async fetch() {
      throw new Error("connect ECONNREFUSED");
    },
  };
  const provider = new HttpAnalysisProvider({
    endpoint: "https://gateway.example/analyze",
    httpClient,
    logger,
  });
  await assert.rejects(provider.analyze(sampleInput({ signals: [] })), /analysis request failed/);
});

test("malformed gateway JSON is reported as a failure", async () => {
  const httpClient: HttpClient = {
    async fetch() {
      return { ok: true, status: 200, text: async () => "not json" };
    },
  };
  const provider = new HttpAnalysisProvider({
    endpoint: "https://gateway.example/analyze",
    httpClient,
    logger,
  });
  await assert.rejects(provider.analyze(sampleInput({ signals: [] })), AnalysisError);
});

// From here on the real transport: every test above injects an httpClient, so
// the built-in client, the timeout guard and the failure logs never ran (ADR 0022).

/** The default client talks to `globalThis.fetch`; tests stub it and restore it. */
function withFetch(implementation: unknown, run: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = implementation as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = real;
  });
}

/** Only the fields the client actually touches — no DOM lib needed. */
const fakeResponse = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

test("the default HTTP client posts to the endpoint and parses the answer", async () => {
  let seen: { url?: string; method?: string; body?: string; signal?: AbortSignal } = {};
  await withFetch(
    async (url: unknown, init: unknown) => {
      const call = (init ?? {}) as { method?: string; body?: string; signal?: AbortSignal };
      seen = { url: String(url), method: call.method, body: call.body, signal: call.signal };
      return fakeResponse({ summary: "gateway answer", confidence: 0.6 });
    },
    async () => {
      // deliberately no httpClient: the built-in client has to make the trip
      const provider = new HttpAnalysisProvider({
        endpoint: "https://gateway.example/analyze",
        model: "test-model",
        logger,
      });
      const result = await provider.analyze(sampleInput({ signals: [] }));
      assert.equal(result.summary, "gateway answer");
      assert.equal(result.confidence, 0.6);
    },
  );
  assert.equal(seen.url, "https://gateway.example/analyze");
  assert.equal(seen.method, "POST");
  assert.ok(seen.signal instanceof AbortSignal, "the timeout guard has to reach fetch");
  assert.equal((JSON.parse(String(seen.body)) as { model?: string }).model, "test-model");
});

test("the timeout aborts a gateway that stops answering", async () => {
  await withFetch(
    (_url: unknown, init: unknown) =>
      new Promise((_resolve, reject) => {
        const signal = (init as { signal?: AbortSignal }).signal;
        const guard = setTimeout(() => reject(new Error("no abort signal reached fetch")), 500);
        signal?.addEventListener("abort", () => {
          clearTimeout(guard);
          reject(new Error("aborted by timeout"));
        });
      }),
    async () => {
      const provider = new HttpAnalysisProvider({
        endpoint: "https://gateway.example/analyze",
        timeoutMs: 5,
        logger,
      });
      await assert.rejects(provider.analyze(sampleInput({ signals: [] })), /aborted by timeout/);
    },
  );
});

test("an endpoint that is not a URL is labelled instead of throwing", () => {
  const provider = new HttpAnalysisProvider({ endpoint: "gateway.example/analyze", logger });
  assert.equal(provider.label, "Model gateway (invalid endpoint)");
});

test("a gateway answer full of junk is normalised, not trusted", async () => {
  const httpClient: HttpClient = {
    async fetch() {
      return fakeResponse({
        provider: 42,
        summary: { not: "text" },
        confidence: "high",
        findings: [
          "junk",
          null,
          {
            id: "f1",
            severity: "catastrophic",
            title: "Öldruck",
            detail: 7,
            relatedSignals: "rpm",
          },
        ],
        recommendations: ["check oil pressure", 7, ""],
        generatedAt: "yesterday",
        warnings: "none",
      });
    },
  };
  const provider = new HttpAnalysisProvider({
    endpoint: "https://gateway.example/analyze",
    httpClient,
    logger,
  });
  const result = await provider.analyze(sampleInput({ signals: [] }));

  assert.equal(result.provider, "http", "a number is not a provider name");
  assert.equal(result.summary, "", "an object is not a summary");
  assert.equal(result.confidence, 0, '"high" is not a number, so it means no confidence');
  assert.ok(Number.isFinite(result.confidence), "confidence must never be NaN");
  assert.ok(!Number.isNaN(Date.parse(result.generatedAt)), "generatedAt has to be a point in time");
  assert.deepEqual(result.recommendations, ["check oil pressure"]);
  assert.equal(result.warnings, undefined, "a string is not a list of warnings");
  // Every entry becomes a well-formed finding — the view renders these unguarded.
  assert.deepEqual(
    result.findings.map((finding) => finding.id),
    ["finding-0", "finding-1", "f1"],
  );
  assert.deepEqual(
    result.findings.map((finding) => finding.severity),
    ["info", "info", "info"],
    "invented severities become info",
  );
  for (const finding of result.findings) {
    assert.equal(typeof finding.title, "string");
    assert.equal(typeof finding.detail, "string");
    assert.equal(finding.relatedSignals, undefined, "a string is not a list of signals");
  }
});

test("confidence is clamped into [0, 1] and never becomes NaN", async () => {
  // JSON knows neither NaN nor Infinity — both become null, hence the 0.3
  // default. The string case is the one that proves the clamp hardening.
  const cases: Array<[unknown, number]> = [
    [0.42, 0.42],
    [-3, 0],
    [7, 1],
    ["0.25", 0.25],
    ["high", 0],
    [null, 0.3],
    [Number.NaN, 0.3],
    [Number.POSITIVE_INFINITY, 0.3],
  ];
  for (const [sent, expected] of cases) {
    const httpClient: HttpClient = {
      async fetch() {
        return fakeResponse({ summary: "s", confidence: sent });
      },
    };
    const provider = new HttpAnalysisProvider({
      endpoint: "https://gateway.example/analyze",
      httpClient,
      logger,
    });
    const result = await provider.analyze(sampleInput({ signals: [] }));
    assert.equal(result.confidence, expected, `confidence ${String(sent)} must become ${expected}`);
    assert.ok(Number.isFinite(result.confidence), "confidence must be finite");
  }
});

test("a failing provider is logged with its id and rethrown unchanged", async () => {
  const capturing = createLogger("ai", { level: "INFO" });
  const httpClient: HttpClient = {
    async fetch() {
      throw new Error("connect ECONNREFUSED");
    },
  };
  const service = new AnalysisService({
    providers: [
      new HttpAnalysisProvider({
        endpoint: "https://gateway.example/analyze",
        httpClient,
        logger: capturing,
      }),
    ],
    logger: capturing,
  });
  await assert.rejects(
    service.analyze({ input: sampleInput({ signals: [] }) }),
    /analysis request failed/,
  );
  const messages = capturing.records.map((record) => `${record.level} ${record.message}`);
  assert.ok(
    messages.includes("INFO analysis started"),
    `expected a log entry, got: ${messages.join(", ")}`,
  );
  assert.ok(
    messages.includes("ERROR analysis failed"),
    `expected a log entry, got: ${messages.join(", ")}`,
  );
  const failure = capturing.records.find((record) => record.message === "analysis failed");
  assert.equal(failure?.fields?.provider, "http");
  assert.match(String(failure?.fields?.error), /ECONNREFUSED/);
  assert.equal(service.history.length, 0, "a failed analysis does not belong in the history");
});

test("a provider works without an injected logger", async () => {
  // Library users may omit the logger; both classes then build their own.
  const httpClient: HttpClient = {
    async fetch() {
      return fakeResponse({ summary: "ok" });
    },
  };
  const provider = new HttpAnalysisProvider({
    endpoint: "https://gateway.example/analyze",
    httpClient,
  });
  assert.equal((await provider.analyze(sampleInput({ signals: [] }))).summary, "ok");
  const service = new AnalysisService({ providers: [provider] });
  const result = await service.analyze({ input: sampleInput({ signals: [] }) });
  assert.equal(result.provider, "http");
  assert.equal(service.history.length, 1);
});

test("a rejection that is not an Error still logs a usable reason", async () => {
  const capturing = createLogger("ai", { level: "INFO" });
  const httpClient: HttpClient = {
    async fetch() {
      // A client may reject with a plain object; the log still has to name it.
      return Promise.reject({ code: "UPSTREAM_500" });
    },
  };
  const service = new AnalysisService({
    providers: [
      new HttpAnalysisProvider({
        endpoint: "https://gateway.example/analyze",
        httpClient,
        logger: capturing,
      }),
    ],
    logger: capturing,
  });
  await assert.rejects(service.analyze({ input: sampleInput({ signals: [] }) }));
  const failure = capturing.records.find((record) => record.message === "analysis failed");
  const reason = String(failure?.fields?.error);
  assert.match(reason, /UPSTREAM_500/, "the reason has to appear in the log");
  assert.ok(
    !reason.includes("[object Object]"),
    "an object has to show its content, not only its type",
  );
});

test("redactVin leaves an input without a VIN untouched", () => {
  const input = sampleInput({ vehicle: { brand: "Honda" } });
  assert.equal(redactVin(input), input);
});

test("the service routes to the chosen provider and records history", async () => {
  const service = new AnalysisService({ providers: [new HeuristicAnalysisProvider()], logger });
  assert.equal(service.defaultProviderId, "heuristic");
  assert.deepEqual(service.listProviders(), [
    { id: "heuristic", label: "Local rule engine", sendsDataOffBox: false },
  ]);
  const result = await service.analyze({ input: sampleInput() });
  assert.equal(result.provider, "heuristic");
  assert.equal(service.history.length, 1);
});

test("unknown providers are rejected with the known ids", async () => {
  const service = new AnalysisService({ providers: [new HeuristicAnalysisProvider()], logger });
  await assert.rejects(
    service.analyze({ input: sampleInput(), providerId: "gpt-9" }),
    /unknown analysis provider/,
  );
});

test("a service without providers fails loudly instead of silently returning nothing", async () => {
  const service = new AnalysisService({ logger });
  await assert.rejects(
    service.analyze({ input: sampleInput() }),
    /no analysis provider registered/,
  );
});
