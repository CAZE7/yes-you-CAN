/**
 * Condition waits instead of fixed sleeps (ADR 0019, AGENTS 31).
 *
 * `await new Promise((resolve) => setTimeout(resolve, N))` makes a test slow
 * *and* flaky at the same time: N is too short on a loaded CI worker and
 * wasted time everywhere else, and when it is too short the failure surfaces as
 * a confusing assertion instead of as "the condition never arrived". The
 * helpers here wait for the condition the test actually needs and poll fast, so
 * a test takes exactly as long as the code under test needs — never longer.
 *
 * One kind of wait genuinely needs real time: proving that *nothing more*
 * happens ("no further requests after stop"). Absence has no condition to poll
 * for, so that is {@link settle} — a bounded quiet period which must state its
 * reason and cannot exceed {@link MAX_SETTLE_MS}, so it cannot silently grow
 * back into a sleep.
 *
 * This module is the single audited place where test code waits: the
 * architecture suite forbids raw sleep timers in test files
 * (`tests/architecture/hygiene.test.ts`), which is what keeps the three local
 * `waitFor` copies that used to exist in `apps/web/test` and
 * `tests/integration` from coming back.
 */

import assert from "node:assert/strict";

/** Knobs for {@link waitFor}. */
export interface WaitOptions {
  /** Give up after this long; default 2 000 ms. */
  timeoutMs?: number;
  /** Poll interval; default 1 ms. */
  intervalMs?: number;
  /** What is being waited for — appears in the timeout failure. */
  message?: string;
}

/** Upper bound for {@link settle}: a quiet period, not a sleep. */
export const MAX_SETTLE_MS = 50;

/** Default timeout for {@link waitFor}. */
export const DEFAULT_WAIT_TIMEOUT_MS = 2_000;

/**
 * Let `ms` of real time pass.
 *
 * The polling primitive behind {@link waitFor} and the only sanctioned timer in
 * test code; bespoke wake-up loops (a promise resolved by an event *or* by a
 * deadline) use it for their deadline arm.
 */
export function tick(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wait until `probe` yields a value that `satisfied` accepts, and return it.
 *
 * The probe may be synchronous (`() => samples.length > 1`) or asynchronous
 * (`async () => (await query()).length`); `satisfied` defaults to truthiness,
 * so the boolean form returns `true` and the value form returns the value that
 * ended the wait — no re-query needed after the wait.
 */
export async function waitFor<T>(
  probe: () => T | Promise<T>,
  satisfied: (value: T) => boolean = (value) => Boolean(value),
  options: WaitOptions = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, intervalMs = 1, message = "condition" } = options;
  const deadline = Date.now() + timeoutMs;
  let value = await probe();
  while (!satisfied(value)) {
    assert.ok(Date.now() < deadline, `${message} not met within ${timeoutMs} ms`);
    await tick(intervalMs);
    value = await probe();
  }
  return value;
}

/**
 * Wait until `predicate` holds; the negative counterpart of {@link waitFor}
 * reads better where the condition is phrased as something ending.
 */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  options: WaitOptions = {},
): Promise<void> {
  await waitFor(predicate, (value) => value, options);
}

/**
 * Let real time pass in order to prove that nothing more happens.
 *
 * The reason is mandatory: a quiet period that cannot say which absence it
 * observes is a fixed sleep in disguise. Capped at {@link MAX_SETTLE_MS} —
 * anything longer means a condition exists that should be waited for.
 */
export async function settle(ms: number, reason: string): Promise<void> {
  assert.ok(reason.trim().length > 0, "settle() needs the reason it waits");
  assert.ok(
    Number.isFinite(ms) && ms > 0 && ms <= MAX_SETTLE_MS,
    `settle(${ms}) is outside 1..${MAX_SETTLE_MS} ms — wait for the condition with waitFor() instead`,
  );
  await tick(ms);
}
