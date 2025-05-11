# Task: Fix Input Integration Test Failures and Ensure CLI Compatibility

## Commit 1: fix: Suppress all debug logs for send-input except expected output ✅ <SHA1>
**Description:**
Patch `src/index.ts` so that when running the `send-input` command, only `INPUT_SENT`, `INPUT_SEND_ERROR`, or `INPUT_SEND_ERROR_NO_CHILD` are printed to stdout. All other debug or info logs must be suppressed for this command. Patch `console.log` just before the `.action` handler for `send-input` to avoid global suppression. This ensures test output matches the expectations in `test/integration/input-tests/` and `test/integration/spawn-wrapper-send-flag.test.ts`.

**Verification:**
- Run `pnpm test` and confirm all tests in `test/integration/input-tests/` and `test/integration/spawn-wrapper-send-flag.test.ts` pass.
- Manually run `chopup send-input --socket <socket> --input "y"` and confirm only `INPUT_SENT` is printed.

---

## Commit 2: fix: Print connection errors to stderr for send-input failures ✅ <SHA2>
**Description:**
Update the `send-input` command in `src/index.ts` to print connection errors (e.g., invalid socket, exited process) to stderr using `console.error`. Ensure the error message matches the format expected by tests (see `test/integration/input-tests/` and README troubleshooting section). Do not print any other logs for successful input sends.

**Verification:**
- Run tests that simulate invalid socket or exited process scenarios (e.g., kill the wrapped process, then run `send-input`).
- Confirm error messages are printed to stderr and tests pass.

---

## Commit 3: fix: Remove global log suppression for send-input ✅ <SHA3>
**Description:**
Ensure that any global patching of `console.log` or `console.error` for the `send-input` command is removed from the top of `src/index.ts`. The patch should only be applied locally within the `.action` handler for `send-input`. This prevents suppression of logs for other commands and ensures correct output for all CLI subcommands.

**Verification:**
- Run all CLI commands (`run`, `request-logs`, `send-input`) and confirm only `send-input` output is suppressed as expected.
- Run `pnpm test` and confirm all tests pass.

---

## Commit 4: fix: Ensure INPUT_SENT is always printed for successful input
**Description:**
Update the `send-input` command in `src/index.ts` so that `INPUT_SENT` is always printed to stdout when the server responds with `INPUT_SENT`, even if debug log suppression is active. This guarantees test output is correct and matches the expectations in `test/integration/input-tests/`.

**Verification:**
- Run `pnpm test` and confirm all tests in `test/integration/input-tests/` pass.
- Manually verify that `chopup send-input --socket <socket> --input "test"` prints `INPUT_SENT` on success.

---

## Commit 5: chore: Refactor and document log suppression logic
**Description:**
Refactor the log suppression logic for `send-input` in `src/index.ts` to a dedicated helper function or inline comment for maintainability. Update `README.md` to document the log suppression behavior for `send-input` and clarify expected output for integration tests and troubleshooting.

**Verification:**
- Code review to ensure log suppression is isolated and documented.
- Check `README.md` for updated documentation on `send-input` output and troubleshooting.
- Run `pnpm test` to confirm all tests pass after refactor.

--- 