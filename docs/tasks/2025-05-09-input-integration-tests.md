# Task: Enhance Input Sending Integration Tests

## Commit 1: Chore: Setup test infrastructure for input scenarios ✅ 2a495403a8ddf5b6132fee4d2798346e8dfcc934
**Description:**
Create a new directory `test/integration/input-tests/` to house tests specifically for input sending scenarios. Develop a helper script or set of functions, potentially in a new `test/integration/test-utils/input-helpers.ts` or by extending existing test utilities. This helper will streamline:
1.  Spawning `chopup` to wrap a dummy CLI script. The dummy scripts will be placed in `test/integration/input-tests/fixtures/scripts/`.
2.  Establishing an IPC connection to the `chopup` instance.
3.  Sending input strings using the `send-input` IPC mechanism.
4.  Capturing output from the dummy CLI to verify input reception.
5.  Ensuring robust cleanup using `tree-kill` for all processes and temporary files (IPC sockets, dummy script outputs).

**Verification:**
Create a basic "smoke" test within `test/integration/input-tests/smoke.test.ts`. This test will:
1.  Use the new helper to run `chopup` with a simple dummy script (e.g., `node test/integration/input-tests/fixtures/scripts/echo-input.js` which just echoes its stdin to stdout or a temp file).
2.  Send a predefined string (e.g., "hello-smoke") via the `send-input` command.
3.  Verify that the dummy script receives and correctly outputs "hello-smoke".
4.  Confirm that `chopup` and the dummy script processes are terminated cleanly by `tree-kill`.
5.  Check that the IPC socket path (e.g., from `chopup`'s startup message) is valid and used for communication.

---

## Commit 2: Feat: Add integration test for single character input (e.g., Y/N prompt)
**Description:**
1.  Create a dummy Node.js CLI script: `test/integration/input-tests/fixtures/scripts/yes-no-prompt.js`. This script will:
    *   Print a prompt like "Confirm? (y/n): ".
    *   Wait for a single character input from stdin ('y', 'Y', 'n', or 'N').
    *   Print a confirmation message based on the input (e.g., "Confirmed: yes" or "Confirmed: no").
    *   Exit.
2.  Create a new Vitest integration test file: `test/integration/input-tests/single-char.test.ts`.
3.  This test will use the helper from Commit 1 to wrap `yes-no-prompt.js` with `chopup`.
4.  The test will send "y\n" (simulating 'y' then Enter, as stdin is often line-buffered) using the `send-input` command (`chopup send-input --socket <socket-path> --input "y\n"`).
5.  Verify that the `yes-no-prompt.js` script outputs "Confirmed: yes".

**Verification:**
1.  Run `pnpm test test/integration/input-tests/single-char.test.ts`.
2.  Inspect `chopup` logs to ensure the input "y\n" was logged as sent.
3.  Verify the output from `yes-no-prompt.js` (captured by the test helper) matches "Confirmed: yes".
4.  Ensure all processes (`chopup`, `yes-no-prompt.js`) terminate cleanly.

---

## Commit 3: Feat: Add integration test for multi-character text input followed by Enter
**Description:**
1.  Create a dummy Node.js CLI script: `test/integration/input-tests/fixtures/scripts/text-entry-prompt.js`. This script will:
    *   Print a prompt like "Enter your name: ".
    *   Read a full line of text from stdin (terminated by a newline).
    *   Print the entered text, e.g., "Name entered: [entered_text]".
    *   Exit.
2.  Create a new Vitest integration test file: `test/integration/input-tests/text-entry.test.ts`.
3.  This test will wrap `text-entry-prompt.js` with `chopup`.
4.  The test will send a string like "John Doe\n" using the `send-input` command.
5.  Verify that `text-entry-prompt.js` outputs "Name entered: John Doe".

**Verification:**
1.  Run `pnpm test test/integration/input-tests/text-entry.test.ts`.
2.  Check `chopup` logs for the "John Doe\n" input.
3.  Verify the output from `text-entry-prompt.js` matches "Name entered: John Doe".
4.  Ensure clean process termination.

---

## Commit 4: Feat: Add integration test for selecting from a list of choices (numeric input)
**Description:**
1.  Create a dummy Node.js CLI script: `test/integration/input-tests/fixtures/scripts/choice-prompt.js`. This script will:
    *   Print a menu: "1. Option A\n2. Option B\n3. Option C\nEnter choice (1-3): ".
    *   Read a single digit from stdin followed by a newline.
    *   Print the selected option, e.g., "Selected: Option B" if "2" was entered.
    *   Handle invalid input gracefully (e.g., print "Invalid choice" and exit, or re-prompt - for simplicity, exit on invalid).
2.  Create a new Vitest integration test file: `test/integration/input-tests/list-choice.test.ts`.
3.  This test will wrap `choice-prompt.js` with `chopup`.
4.  The test will send "2\n" using the `send-input` command.
5.  Verify that `choice-prompt.js` outputs "Selected: Option B".
6.  (Optional) Add a test case for invalid input, e.g., sending "5\n" and verifying an "Invalid choice" message.

**Verification:**
1.  Run `pnpm test test/integration/input-tests/list-choice.test.ts`.
2.  Check `chopup` logs for the "2\n" input.
3.  Verify the output from `choice-prompt.js` matches "Selected: Option B".
4.  Ensure clean process termination. If the optional invalid input test is added, verify its expected outcome.

---

## Commit 5: Chore: Refactor input tests and enhance logging/cleanup
**Description:**
1.  Review all newly created tests in `test/integration/input-tests/`.
2.  Identify and refactor any duplicated code into the `test/integration/test-utils/input-helpers.ts` (or equivalent). This includes common patterns for setting up dummy scripts, spawning `chopup`, sending input, and verifying output.
3.  Enhance logging within the dummy CLI scripts (`test/integration/input-tests/fixtures/scripts/*.js`) to clearly indicate when input is received and what it is.
4.  Improve logging within the Vitest tests for clearer diagnostics upon failure (e.g., log the actual output vs. expected output).
5.  Double-check that all temporary files (dummy scripts if copied/generated per test, IPC sockets, output logs from dummy scripts if any) are rigorously cleaned up after each test run, possibly by enhancing the test helper's teardown logic.
6.  Ensure all tests use `node:` prefixed imports for built-in Node.js modules in the dummy scripts.

**Verification:**
1.  Run all tests in the `test/integration/input-tests/` directory: `pnpm test test/integration/input-tests/`. All tests must pass.
2.  Manually inspect the code for refactoring quality and improved logging.
3.  Temporarily introduce a failure in one of the dummy scripts or tests to observe the diagnostic logging.
4.  Verify that the `tmp/` directory (specifically `tmp/input-scenario-scripts/` and any test-specific subdirectories) is clean after all tests complete successfully. Check that no orphaned `chopup` or dummy script processes remain. 