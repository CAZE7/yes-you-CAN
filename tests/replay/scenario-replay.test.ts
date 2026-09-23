/**
 * Scenario Replay Suite (ADR 0057 Migration 6).
 *
 * Automated proof for every scenario in the library:
 *   Record live run on HighFidelityVehicle
 *     → Pack raw trace into signed v2 manifest (ed25519, content-addressed traceId)
 *     → Verify digest and cryptographic signature
 *     → Replay recorded session through ReplayTransport
 *     → Assert exactly identical DTC output between live run and replay.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DiagnosticEngine,
  SessionLogger,
  signRawTraceManifest,
  traceIdFromManifest,
  verifyRawTraceManifest,
  verifyRawTraceManifestSignature,
} from "@vdp/core";
import { highFidelityPackage } from "@vdp/definitions";
import { createLogger, type Logger } from "@vdp/shared";
import { createRandom, HighFidelityVehicle, parseScenarioFile } from "@vdp/simulators";
import { createNodeManifestSigner, nodeIntegrityPort } from "@vdp/storage";
import { ReplayTransport, recordingFromSessionJson } from "@vdp/transport-can";
import { describe, test } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scenariosDir = join(repoRoot, "scenarios");
const logger: Logger = createLogger("scenario-replay", { level: "ERROR" });

const scenarioFiles = readdirSync(scenariosDir)
  .filter((file) => file.endsWith(".json"))
  .sort();

describe("ADR 0057 scenario replay: live recording → signed v2 manifest → replay verification", () => {
  for (const filename of scenarioFiles) {
    test(`scenario "${filename}" reproduces identical DTCs via signed replay`, async () => {
      const filePath = join(scenariosDir, filename);
      const text = readFileSync(filePath, "utf8");
      const parsed = parseScenarioFile(text);
      assert.ok(parsed.ok, `scenario ${filename} failed to parse`);
      if (!parsed.ok) return;

      const { scenario, determinism } = parsed.file;
      const signer = createNodeManifestSigner({ logger });

      // 1. Live Run on HighFidelityVehicle with both directions captured
      const vehicle = new HighFidelityVehicle({
        logger,
        modelTickMs: 0,
        model: { random: createRandom(determinism.seed) },
        networkOptions: { echoToSender: true },
      });
      await vehicle.start();

      const sessionLogger = new SessionLogger({ integrity: nodeIntegrityPort });
      const unsubscribe = vehicle.testerBus.subscribe((frame) => {
        sessionLogger.recordFrame(frame);
      });

      const liveEngine = new DiagnosticEngine({
        logger,
        bus: vehicle.testerBus,
        definitions: [highFidelityPackage],
      });
      await liveEngine.connect({ windowMs: 150, probeDelayMs: 0 });

      let liveDtcCodes: string[] = [];
      try {
        await vehicle.runScenario(scenario);
        const liveScan = await liveEngine.scanDtcs(0xff);
        liveDtcCodes = liveScan.scanned
          .flatMap((entry) =>
            entry.dtcs.map((dtc) => `${entry.ecu.definitionEcuId ?? entry.ecu.name}:${dtc.code}`),
          )
          .sort();
      } finally {
        unsubscribe();
        await liveEngine.disconnect();
        await vehicle.stop();
      }

      // 2. Cryptographic Attestation (ADR 0057 v2 manifest + signature)
      const unsignedManifest = sessionLogger.rawTraceManifest();
      const signedManifest = signRawTraceManifest(unsignedManifest, signer);

      assert.equal(signedManifest.version, 2);
      assert.ok(signedManifest.signature !== undefined);
      assert.equal(signedManifest.signature.algorithm, "ed25519");
      assert.equal(signedManifest.signature.keyId, signer.keyId);

      // Verify digest & signature
      const rawTrace = sessionLogger.snapshot().trace;
      assert.equal(
        verifyRawTraceManifest(rawTrace, signedManifest, nodeIntegrityPort),
        true,
        "digest verification must pass",
      );
      assert.equal(
        verifyRawTraceManifestSignature(signedManifest, signer),
        true,
        "signature verification must pass",
      );

      const traceId = traceIdFromManifest(signedManifest);
      assert.match(traceId, /^t-[0-9a-f]{16}$/);

      // 3. Replay Transport: Replaying the recorded trace must yield identical DTCs
      const sessionJson = SessionLogger.toJson({
        meta: {
          sessionId: `replay-${filename}`,
          traceId,
          scenario: { id: filename.replace(/\.json$/, ""), seed: determinism.seed },
        },
        samples: [],
        markers: [],
        dtcs: [],
        trace: rawTrace,
        log: sessionLogger.snapshot().log,
        rawTraceManifest: signedManifest,
      });

      const replayRecording = recordingFromSessionJson(sessionJson);
      const replayBus = new ReplayTransport(replayRecording, { logger, immediate: true });
      await replayBus.open();

      const replayEngine = new DiagnosticEngine({
        logger,
        bus: replayBus,
        definitions: [highFidelityPackage],
      });
      await replayEngine.connect({ windowMs: 150, probeDelayMs: 0 });

      try {
        const replayScan = await replayEngine.scanDtcs(0xff);
        const replayDtcCodes = replayScan.scanned
          .flatMap((entry) =>
            entry.dtcs.map((dtc) => `${entry.ecu.definitionEcuId ?? entry.ecu.name}:${dtc.code}`),
          )
          .sort();

        assert.deepEqual(
          replayDtcCodes,
          liveDtcCodes,
          `replay for ${filename} must yield identical DTC codes to live run`,
        );
      } finally {
        await replayEngine.disconnect();
        await replayBus.close();
      }
    });
  }
});
