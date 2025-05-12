# Task: Fix Integration Test Timeouts

## Commit 1: fix(test): Listen on both stdout and stderr in test helper for readiness signal

**Description:**
The `spawnChopup` helper function in `test/integration/chopup-cli.test.ts` currently only listens to the `stdout` of the spawned `chopup` process to detect the `CHOPUP_SOCKET_PATH=` message, which signals that the chopup instance is ready. However, the `Chopup` class (specifically its `logToConsole` method in `src/chopup.ts`) might write this message to `stderr` under certain conditions (e.g., if `stdout` is not writable or is perceived as such by the child process). This commit will modify `spawnChopup` to listen on both `stdout` and `stderr` for the readiness signal.

Additionally, the `CHOPUP_SUPPRESS_SOCKET_PATH_LOG` environment variable set in `spawnChopup` (line 32) will be removed. This variable is not currently checked or respected by the `Chopup` class's `logToConsole` method (line 119 in `src/chopup.ts`) when printing the socket path, and its presence is confusing given the test explicitly waits for this log line.

**Files to modify:**
- `test/integration/chopup-cli.test.ts`

**Specific changes:**
1. In `spawnChopup` within `test/integration/chopup-cli.test.ts`:
    - Attach a listener to `proc.stderr` similar to the existing `proc.stdout.on('data', ...)` listener.
    - This new listener should also look for the `CHOPUP_SOCKET_PATH=` pattern.
    - If the pattern is matched in either `stdout` or `stderr`, the promise should be resolved. Ensure resolution only happens once.
    - Remove the line `env: { ...process.env, CHOPUP_SUPPRESS_SOCKET_PATH_LOG: 'true' },` (around line 32).

**Verification:**
1. Run the integration tests: `pnpm test test/integration/chopup-cli.test.ts`.
2. All three previously failing tests should now pass:
    - `Chopup CLI Integration Tests > run subcommand (default) > should spawn a command, create a log directory, and start an IPC server`
    - `Chopup CLI Integration Tests > request-logs CLI command > should request logs from a running chopup instance and create a log chop file`
    - `Chopup CLI Integration Tests > send-input CLI command > should send input to the wrapped process via CLI`
3. Confirm that the tests pass reliably and not intermittently.

--- 