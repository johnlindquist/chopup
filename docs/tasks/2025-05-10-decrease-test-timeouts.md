# Task: Decrease Test Timeouts and Tackle Input Integration Tests Individually

## Commit 1: chore: Decrease all input integration test timeouts to 5s and add excessive logging ✅ c1e6f2d
**Description:**
Reduce all `it(..., <timeout>)` values in `test/integration/input-tests/smoke.test.ts`, `single-char.test.ts`, and `text-entry.test.ts` from 20s to 5s. Add `console.log` statements before/after every async wait, input send, and output check in each test. Update `spawnChopupWithScript` in `test/integration/test-utils/input-helpers.ts` to default to a 5s timeout for socket detection. Ensure all dummy scripts in `fixtures/scripts/` log when they start, receive input, and exit.

**Verification:**
- Run `pnpm test test/integration/input-tests/smoke.test.ts` and confirm all tests fail fast if they hang, and logs show all key events.
- Manually inspect logs for prompt, input, and output events in each test run.

---

## Commit 2: fix: Tackle smoke.test.ts - ensure robust, fast cleanup and socket removal ✅ d196caa
**Description:**
Refactor `smoke.test.ts` to minimize all waits (e.g., reduce `setTimeout`/polling intervals to 100ms, max 1s total). Ensure `chopupInstance.cleanup()` is always awaited and logs before/after cleanup. Add a final check for socket file removal with a 1s poll. If socket is not removed, log error and fail test immediately.

**Verification:**
- Run `pnpm test test/integration/input-tests/smoke.test.ts` and confirm it passes in <5s, logs all cleanup steps, and fails if socket lingers.
- Check for `[SMOKE_TEST]` logs before/after each major step.

---

## Commit 3: fix: Tackle single-char.test.ts - minimize delays and verify all edge cases ✅ f60cef5
**Description:**
Reduce all `setTimeout`/waits in `single-char.test.ts` to 100-200ms. Add logs before/after each input send and output check. Ensure each test case (`y`, `N`, invalid) logs the input, output, and cleanup. Fail immediately if output is not as expected within 1s. Ensure `chopupInstance.cleanup()` is always called and logged.

**Verification:**
- Run `pnpm test test/integration/input-tests/single-char.test.ts` and confirm all cases pass in <5s, with logs for each step.
- Check logs for input, output, and cleanup for each test case.

---

## Commit 4: fix: Tackle text-entry.test.ts - minimize polling and log all events
**Description:**
Reduce all polling intervals and timeouts in `text-entry.test.ts` to 100ms/1s. Add logs before/after each input send, output poll, and cleanup. Ensure all test cases (normal, empty, spaces) log the input, output, and cleanup. Fail immediately if output is not as expected within 1s. Ensure all dummy scripts log when they receive input and write output.

**Verification:**
- Run `pnpm test test/integration/input-tests/text-entry.test.ts` and confirm all cases pass in <5s, with logs for each step.
- Check logs for input, output, and cleanup for each test case.

---

## Commit 5: chore: Refactor input-helpers and scripts for minimal waits and maximum observability
**Description:**
Update `test/integration/test-utils/input-helpers.ts` to use 5s timeouts for all process/socket waits, and 100ms for all polling. Add logs before/after every async wait, process spawn, and cleanup. Update all dummy scripts in `fixtures/scripts/` to log at start, on input, and on exit. Remove any unnecessary waits or delays in scripts and helpers.

**Verification:**
- Run `pnpm test test/integration/input-tests/` and confirm all tests pass in <15s total, with logs for every major event.
- Manually inspect logs for prompt, input, output, and cleanup events in all scripts and helpers.

--- 