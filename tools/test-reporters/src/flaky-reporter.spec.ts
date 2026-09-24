import assert from "node:assert/strict";
import { describe, test } from "vitest";
import FlakyReporter, {
  escapeAnnotation,
  failureMessageOf,
  isFlakyTask,
  type TaskLike,
  testNameOf,
} from "../flaky-reporter.js";

describe("FlakyReporter unit tests", () => {
  test("escapeAnnotation escapes %, CR, and LF", () => {
    assert.equal(escapeAnnotation("hello%world\r\ntest"), "hello%25world%0D%0Atest");
    assert.equal(escapeAnnotation("plain text"), "plain text");
  });

  test("isFlakyTask returns true only when task passed with retryCount > 0", () => {
    assert.equal(
      isFlakyTask({ type: "test", name: "t1", result: { state: "pass", retryCount: 1 } }),
      true,
    );
    assert.equal(
      isFlakyTask({ type: "test", name: "t2", result: { state: "pass", retryCount: 0 } }),
      false,
    );
    assert.equal(
      isFlakyTask({ type: "test", name: "t3", result: { state: "fail", retryCount: 2 } }),
      false,
    );
    assert.equal(isFlakyTask({ type: "test", name: "t4" }), false);
  });

  test("failureMessageOf extracts message or stack and honors maxChars limit", () => {
    const task: TaskLike = {
      type: "test",
      name: "failing test",
      result: {
        state: "fail",
        errors: [{ message: "AssertionError: expected true to be false" }],
      },
    };
    assert.equal(failureMessageOf(task), "AssertionError: expected true to be false");

    const longTask: TaskLike = {
      type: "test",
      name: "long error",
      result: {
        state: "fail",
        errors: [{ message: "A".repeat(50) }],
      },
    };
    assert.equal(failureMessageOf(longTask, 20), `${"A".repeat(20)}…`);

    const noErrorTask: TaskLike = {
      type: "test",
      name: "silent failure",
      result: { state: "fail" },
    };
    assert.equal(failureMessageOf(noErrorTask), "no error message recorded");
  });

  test("testNameOf builds parent > child hierarchy correctly", () => {
    const fileTask: TaskLike = { type: "file", name: "file.spec.ts" };
    const suiteTask: TaskLike = { type: "suite", name: "Parent Suite" };
    const child: TaskLike = { type: "test", name: "Child Test" };
    fileTask.tasks = [suiteTask];
    suiteTask.tasks = [child];

    const reporter = new FlakyReporter();
    reporter.onTestRunEnd([{ task: fileTask, relativeModuleId: "test.spec.ts" }]);
    assert.equal(testNameOf(child), "Parent Suite > Child Test");
  });

  test("onTestRunEnd collects flaky tests and failures across modules", () => {
    const originalGitHub = process.env.GITHUB_ACTIONS;
    try {
      delete process.env.GITHUB_ACTIONS;

      const flakyTask: TaskLike = {
        type: "test",
        name: "eventually passes",
        result: { state: "pass", retryCount: 2, duration: 120 },
      };
      const failingTask: TaskLike = {
        type: "test",
        name: "always fails",
        result: {
          state: "fail",
          retryCount: 1,
          errors: [{ message: "Boom!" }],
        },
      };
      const rootTask: TaskLike = {
        type: "suite",
        name: "Root",
        tasks: [flakyTask, failingTask],
      };

      const reporter = new FlakyReporter();
      reporter.onTestRunEnd([
        { task: rootTask, relativeModuleId: "suite.spec.ts" },
        { task: undefined }, // empty module handling
        { task: { type: "suite", name: "Empty", tasks: [] }, relativeModuleId: undefined },
      ]);

      // Verify reporter runs with GITHUB_ACTIONS formatting as well
      process.env.GITHUB_ACTIONS = "true";

      // Long error message to test annotation slicing (> 900 chars)
      const longFailingTask: TaskLike = {
        type: "test",
        name: "long error test",
        result: {
          state: "fail",
          retryCount: 0,
          errors: [{ message: "X".repeat(2000) }],
        },
      };

      // Exceed MAX_ANNOTATED_FAILURES (30) to test cap prefix
      const manyTasks: TaskLike[] = Array.from({ length: 35 }, (_, i) => ({
        type: "test",
        name: `fail_${i}`,
        result: { state: "fail", errors: [{ message: `err ${i}` }] },
      }));

      const bigRoot: TaskLike = {
        type: "suite",
        name: "BigRoot",
        tasks: [flakyTask, longFailingTask, ...manyTasks],
      };

      reporter.onTestRunEnd([{ task: bigRoot, moduleId: "big.spec.ts" }]);
    } finally {
      if (originalGitHub !== undefined) {
        process.env.GITHUB_ACTIONS = originalGitHub;
      } else {
        delete process.env.GITHUB_ACTIONS;
      }
    }
  });
});
