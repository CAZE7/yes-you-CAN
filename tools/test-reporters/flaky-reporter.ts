/**
 * Flaky-test reporter (testing standards: "CI rules").
 *
 * `retry` is allowed in CI, but a test that passes only after a retry is a
 * flaky-test warning — never silently swallowed. In GitHub Actions each flaky
 * test is emitted as a `::warning` annotation on the PR; everywhere else it is
 * printed to stderr and summarized.
 *
 * Implemented against the raw task tree (`module.task`) rather than the
 * `TestModule` helpers, which keeps it stable across Vitest internals.
 */

/** Minimal shape of a Vitest task in the reported tree. */
export interface TaskLike {
  type: string;
  name: string;
  result?: { state?: string; retryCount?: number; duration?: number } | undefined;
  suites?: TaskLike[] | undefined;
  tests?: TaskLike[] | undefined;
}

export interface FlakyRecord {
  test: string;
  file: string;
  retries: number;
  durationMs: number;
}

const PARENTS = new WeakMap<TaskLike, TaskLike | undefined>();

/** A test is flaky when it passed although it needed retries to do so. */
export function isFlakyTask(task: TaskLike): boolean {
  return task.result?.state === "pass" && (task.result.retryCount ?? 0) > 0;
}

function* walkTasks(task: TaskLike): Generator<{ task: TaskLike; parent: TaskLike | undefined }> {
  for (const child of [...(task.tests ?? []), ...(task.suites ?? [])]) {
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

  onTestRunEnd(testModules: ReadonlyArray<ModuleLike>): void {
    for (const module of testModules) {
      const file = module.task;
      if (!file) continue;
      for (const { task } of walkTasks(file)) {
        if (task.type !== "test" || !isFlakyTask(task)) continue;
        this.flaky.push({
          test: testNameOf(task),
          file: module.relativeModuleId ?? module.moduleId ?? "unknown",
          retries: task.result?.retryCount ?? 0,
          durationMs: Math.round(task.result?.duration ?? 0),
        });
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
