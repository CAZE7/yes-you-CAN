/**
 * Flaky-test and failure reporter (testing standards: "CI rules").
 *
 * `retry` is allowed in CI, but a test that passes only after a retry is a
 * flaky-test warning — never silently swallowed. In GitHub Actions each flaky
 * test is emitted as a `::warning` annotation on the PR; everywhere else it is
 * printed to stderr and summarized.
 *
 * Failing tests are emitted as `::error` annotations: the job's raw log is a
 * results blob the credentials this repository is worked with cannot fetch
 * (the same reason `coverage-gate.test.ts` speaks in `::notice` lines), and a
 * red run whose only readable line is "Process completed with exit code 1"
 * hides exactly the one thing a red run exists to say.
 *
 * Implemented against the raw task tree (`module.task`) rather than the
 * `TestModule` helpers, which keeps it stable across Vitest internals.
 */

import { appendFileSync } from "node:fs";

/** Minimal shape of a Vitest task in the reported tree. */
export interface TaskLike {
  type: string;
  name: string;
  result?: {
    state?: string;
    retryCount?: number;
    duration?: number;
    errors?: ReadonlyArray<{ message?: string; stack?: string }> | undefined;
  };
  /** The child tasks — this is the property the runner actually fills (measured:
   * `tests`/`suites` stay undefined at `onTestRunEnd`, so the previous walk saw
   * exactly one task per module and reported nothing, ever). */
  tasks?: TaskLike[] | undefined;
}

export interface FlakyRecord {
  test: string;
  file: string;
  retries: number;
  durationMs: number;
}

export interface FailureRecord {
  test: string;
  file: string;
  /** First attempt plus retries — how often this test was actually run. */
  attempts: number;
  /** The first error's message, first lines only, single-line. */
  message: string;
}

/** Annotations are single lines; GitHub escapes these three in workflow commands. */
export function escapeAnnotation(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/** Enough of the error to know which assertion broke, in one annotation line. */
export function failureMessageOf(task: TaskLike, maxChars = 8000): string {
  const first = task.result?.errors?.[0];
  const lines = (first?.message ?? first?.stack ?? "no error message recorded")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(0, 40);
  let message = lines.join(" | ");
  if (message.length > maxChars) message = `${message.slice(0, maxChars)}…`;
  return message;
}

const PARENTS = new WeakMap<TaskLike, TaskLike | undefined>();

/** A test is flaky when it passed although it needed retries to do so. */
export function isFlakyTask(task: TaskLike): boolean {
  return task.result?.state === "pass" && (task.result.retryCount ?? 0) > 0;
}

function* walkTasks(task: TaskLike): Generator<{ task: TaskLike; parent: TaskLike | undefined }> {
  for (const child of task.tasks ?? []) {
    PARENTS.set(child, task);
    yield { task: child, parent: task };
    yield* walkTasks(child);
  }
}

/** Human-readable name without the file task itself. */
export function testNameOf(task: TaskLike): string {
  const parts: string[] = [task.name];
  for (
    let parent = PARENTS.get(task);
    parent && PARENTS.get(parent) !== undefined;
    parent = PARENTS.get(parent)
  ) {
    parts.unshift(parent.name);
  }
  return parts.join(" > ");
}

interface ModuleLike {
  task?: TaskLike | undefined;
  relativeModuleId?: string | undefined;
  moduleId?: string | undefined;
}

export default class FlakyReporter {
  private readonly flaky: FlakyRecord[] = [];
  private readonly failures: FailureRecord[] = [];

  /** GitHub caps error annotations per step; report the rest as a count. */
  private static readonly MAX_ANNOTATED_FAILURES = 30;

  onTestRunEnd(testModules: ReadonlyArray<ModuleLike>): void {
    for (const module of testModules) {
      const file = module.task;
      if (!file) continue;
      for (const { task } of walkTasks(file)) {
        if (task.type === "test" && isFlakyTask(task)) {
          this.flaky.push({
            test: testNameOf(task),
            file: module.relativeModuleId ?? module.moduleId ?? "unknown",
            retries: task.result?.retryCount ?? 0,
            durationMs: Math.round(task.result?.duration ?? 0),
          });
        }
        if (task.result?.state === "fail") {
          this.failures.push({
            test: task.type === "test" ? testNameOf(task) : `${task.name} (suite/hook)`,
            file: module.relativeModuleId ?? module.moduleId ?? "unknown",
            attempts: 1 + (task.result?.retryCount ?? 0),
            message: failureMessageOf(task),
          });
        }
      }
    }

    for (const [index, record] of this.failures.entries()) {
      const prefix =
        index >= FlakyReporter.MAX_ANNOTATED_FAILURES ? "[beyond the annotation cap] " : "";
      if (index >= FlakyReporter.MAX_ANNOTATED_FAILURES) continue;
      const message =
        `FAILING TEST: "${record.test}" (${record.file}), ${record.attempts} ` +
        `attempt${record.attempts === 1 ? "" : "s"} — ${record.message}`;
      if (process.env.GITHUB_ACTIONS) {
        // One annotation carries ~1024 characters — a GHC error does not fit in one,
        // and the raw log blob is unreachable with the credentials this repository is
        // worked with. So the message travels in labeled slices.
        const escaped = escapeAnnotation(message);
        for (let slice = 0; slice * 900 < escaped.length; slice++) {
          const part = escaped.slice(slice * 900, (slice + 1) * 900);
          process.stdout.write(
            `::error file=${record.file} title=Test failure (${slice + 1})::${part}\n`,
          );
        }
      } else {
        process.stderr.write(`[fail] ${prefix}${message}\n`);
      }
    }

    if (this.failures.length > 0 && process.env.GITHUB_ACTIONS) {
      const summary = `${this.failures.length} failing test${this.failures.length === 1 ? "" : "s"}`;
      process.stdout.write(`::error title=Test failures::${escapeAnnotation(summary)}\n`);
      // Annotations truncate at ~1024 characters — the step summary does not, and
      // the check-runs API reads it back whole (`output.summary`). A red run must
      // carry its full evidence somewhere reachable, or the log blob is the only
      // witness and it is the one channel this repository cannot read.
      const summaryPath = process.env.GITHUB_STEP_SUMMARY;
      if (summaryPath !== undefined) {
        const body = this.failures
          .map(
            (record) =>
              `### FAILING TEST: \`${record.test}\`\n\n` +
              `file: \`${record.file}\` — ${record.attempts} attempt(s)\n\n` +
              "```\n" +
              `${record.message}\n` +
              "```\n",
          )
          .join("\n");
        try {
          appendFileSync(summaryPath, `# Test failures\n\n${body}\n`);
        } catch {
          // A summary that cannot be written leaves the annotations — never a crash
          // inside the reporter while the suite is already red.
        }
      }
    }

    if (this.flaky.length === 0) return;

    for (const record of this.flaky) {
      const message =
        `FLAKY TEST: "${record.test}" (${record.file}) passed after ${record.retries} ` +
        `retr${record.retries === 1 ? "y" : "ies"} (${record.durationMs} ms). ` +
        "Fix the test or the code under test — retries only mask nondeterminism.";
      if (process.env.GITHUB_ACTIONS) {
        process.stdout.write(
          `::warning file=${record.file}::${message.replaceAll("::", "%3A%3A")}\n`,
        );
      } else {
        process.stderr.write(`[flaky] ${message}\n`);
      }
    }

    const summary = `${this.flaky.length} flaky test${this.flaky.length === 1 ? "" : "s"} detected (passed on retry)`;
    if (process.env.GITHUB_ACTIONS) {
      process.stdout.write(`::notice title=Flaky tests::${summary}\n`);
    } else {
      process.stderr.write(`[flaky] ${summary}\n`);
    }
  }
}
