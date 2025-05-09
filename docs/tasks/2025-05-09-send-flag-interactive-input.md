# Task: Add --send flag for interactive input to child process

## Commit 1: test: Add integration test for --send flag ✅ d12c72e92aac09a22784cf674f1b42422bd7d961
**Description:**
Create a new integration test in `test/integration/` that launches a process requiring user input (e.g., a script that prompts for yes/no), runs the CLI tool to wrap it, and verifies that sending input via the new `--send` flag allows the process to proceed. Reference the CLI entry point (likely `src/index.ts`).

**Verification:**
Run `pnpm test` and confirm the new test in `test/integration/` passes, verifying that the process receives the sent input and completes as expected.

---

## Commit 2: feat: Add --send flag to CLI ✅ eb51aa0b0adaf90ee5aadeb3311ab4c6decdd0da
**Description:**
Update the CLI implementation (likely in `src/index.ts`) to accept a `--send <input>` flag. Implement logic to forward the provided input string to the stdin of the running child process. Ensure this works for both new and existing processes.

**Verification:**
Run the CLI with a process that waits for input, use the `--send` flag, and confirm the input is received by the child process. Check logs for confirmation.

---

## Commit 3: feat: Log all --send input events ✅ c16272f47d7589288cd25deedae61ea8f9480d0b
**Description:**
Add logging (in `src/index.ts` or relevant logger module) for every time input is sent to the child process via `--send`. Log the input, timestamp, and process PID for observability.

**Verification:**
Run the CLI with `--send`, check the log output for the correct log entry with input, timestamp, and PID.

---

## Commit 4: fix: Robust error handling for --send flag ✅ 6b797d2beec70ab9d36376ab030e7f2345f5ed8f
**Description:**
Add error handling for cases where the process is not running, stdin is closed, or input cannot be sent. Ensure user-friendly error messages and log all failures.

**Verification:**
Attempt to use `--send` when no process is running or after process exit. Confirm error messages are shown and errors are logged.

---

## Commit 5: docs: Document --send flag in README ✅ dda403201cee3d5cde1e2bbde34003fa9b306b19
**Description:**
Update `README.md` to describe the new `--send` flag, usage examples, and caveats. Reference the integration test and log output for clarity.

**Verification:**
Check `README.md` for a new section on `--send`, including example commands and expected behavior.

---

<!-- TODO: No docs/ or NOTES.md found. If project documentation is added, update this plan with file/function/command specifics. --> 