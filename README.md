# chopup

A CLI tool to wrap long-running processes, chop output into segments, and send input to the wrapped process via IPC.

---

## Installation (Recommended: Global)

Install globally with pnpm:

```sh
pnpm add -g chopup
```

Or, to use directly with npx:

```sh
npx chopup run -- <command-to-wrap> [args...]
```

---

## Features
- Wraps and runs any user-specified command using the `run` subcommand (default).
- Captures stdout and stderr from the wrapped process.
- Segments/chops logs into new files in a specified log directory on IPC request.
- Allows sending input strings to the stdin of the wrapped process via IPC.
- Graceful shutdown and bulletproof process tree cleanup.
- IPC server for on-demand log chopping and input sending.
- (EXPERIMENTAL) File/dir watching to trigger log chopping.
- (EXPERIMENTAL) Send initial input to the wrapped process on startup.

---

## Usage (Global CLI)

`chopup` uses explicit subcommands: `run` (default), `request-logs`, and `send-input`.

### 1. Wrap a Process (using the `run` command)

This is the default command if no other subcommand is specified.

```sh
chopup run [--log-dir <log-dir>] [--socket-path <path>] [--initial-chop] [--watch-file <file-or-dir>] [--send <input>] [--verbose] -- <command-to-wrap> [args...]
# OR (since run is default):
chopup [--log-dir <log-dir>] [--socket-path <path>] [--initial-chop] [--watch-file <file-or-dir>] [--send <input>] [--verbose] -- <command-to-wrap> [args...]
```

**Example:**

```sh
chopup run -- node my-interactive-app.js
# Or simply:
chopup -- node my-interactive-app.js
```

- `--log-dir <path>`: Directory to store chopped log files (optional, defaults to `$CHOPUP_LOG_DIR` or `<system_temp_dir>/chopup/logs`).
- `--socket-path <path>`: Path for the IPC socket file (optional, defaults to `<log-dir>/chopup-<pid>.sock`).
- `--initial-chop`: Perform an initial log chop immediately on startup (optional).
- `--watch-file <file-or-dir>`: (EXPERIMENTAL) Watch a file or directory for changes to trigger log chopping (optional).
- `--send <input>`: (EXPERIMENTAL) Send an initial input string to the wrapped process after startup (optional).
- `--verbose`: Enable verbose logging (optional).
- `--`: Separator before the command to wrap.
- `<command-to-wrap> [args...]`: The command and arguments to run (e.g., `node my-app.js`).

**What happens:**
- The wrapped process runs.
- All stdout/stderr is captured by `chopup`.
- On startup, `chopup` prints the IPC socket path to stdout:
  ```
  CHOPUP_SOCKET_PATH=<path-to-socket>
  CHOPUP_PROCESS_READY
  ```
  (Note: The actual socket path is shown in this output. Use it for IPC commands.)
- Log chopping and input sending only occur when requested via IPC using other `chopup` commands (see below).

---

### 2. Trigger Log Chopping via IPC (from another shell)

Use the `request-logs` command:

```sh
chopup request-logs --socket <socket-path>
```

**Example:**

```sh
chopup request-logs --socket /tmp/chopup/logs/chopup-12345.sock
```

- `--socket <socket-path>`: The IPC socket path of the running `chopup run` instance (from its startup log output).

**What happens:**
- The tool connects to the running `chopup run` instance via its IPC socket.
- It requests an immediate log chop.
- The string `LOGS_CHOPPED` is printed if logs were chopped, or a message if no new logs.
- On error, prints `CHOPUP_REQUEST_LOGS_ERROR_NO_SERVER` or `CHOPUP_REQUEST_LOGS_ERROR_UNKNOWN` to stderr.

---

### 3. Sending Input to the Wrapped Process via IPC (from another shell)

Use the `send-input` command:

```sh
chopup send-input --socket <socket-path> --input "<string-to-send>"
```

**Log Suppression Note:**
- When running `send-input`, only the following will be printed to stdout:
  - `CHOPUP_INPUT_SENT` (on success)
  - `CHOPUP_INPUT_SEND_ERROR`, `CHOPUP_INPUT_SEND_ERROR_NO_CHILD`, or `CHOPUP_INPUT_SEND_ERROR_BACKPRESSURE` (on failure)
- All other debug/info logs are suppressed for this command to ensure clean output for integration tests and scripting.
- Connection errors (e.g., invalid socket, exited process) are printed to stderr as `CHOPUP_INPUT_SEND_ERROR_NO_SERVER` or `CHOPUP_SEND_INPUT_ERROR_CONNECTION_FAILED`.

**Example:**

Suppose `my-interactive-app.js` prompts "Are you sure? (y/n): ".

```sh
chopup send-input --socket /tmp/chopup/logs/chopup-12345.sock --input "y\n"
```

- `--socket <socket-path>`: The IPC socket path of the running `chopup run` instance.
- `--input "<string-to-send>"`: The string to send to the wrapped process's stdin. 
  - **Important**: If your wrapped process expects a newline to process the input (common for CLI prompts), make sure to include `\n` in your input string, e.g., `"y\n"` or `"some text then enter\n"`.

**What happens:**
- Connects to the `chopup run` instance via IPC.
- Sends the specified string to the stdin of the process `chopup` is wrapping.
- The `send-input` command will print a confirmation (e.g., `CHOPUP_INPUT_SENT`) or an error message. No other logs will be printed.

---

## Exhaustive Example Workflows

### Basic Interactive Example

1.  **Start `chopup run` in one shell with an interactive script:**
    ```sh
    chopup -- node examples/interactive-script.js
    ```
    - Note the `CHOPUP_SOCKET_PATH=...` printed on startup.

2.  **From another shell, send input to the script:**
    ```sh
    chopup send-input --socket <socket-path> --input "Alice\n"
    ```

3.  **Observe `interactive-script.js` in the first shell receiving the input and printing it.**

4.  **From another shell, trigger a log chop:**
    ```sh
    chopup request-logs --socket <socket-path>
    ```

5.  **Check the log directory for segmented log files.**

### Run with Custom Log Directory

```sh
chopup --log-dir ./my-logs -- node examples/interactive-script.js
```

### Run with Initial Input (EXPERIMENTAL)

```sh
chopup --send "hello world\n" -- node examples/interactive-script.js
```

### Run with File Watching (EXPERIMENTAL)

```sh
chopup --watch-file ./trigger.txt -- node examples/long-running-script.js
# Touch or modify trigger.txt in another shell to trigger a log chop
```

### Run with Specific Socket Path

```sh
chopup --socket-path /tmp/my-custom.sock -- node examples/interactive-script.js
# Use /tmp/my-custom.sock for send-input and request-logs
```

### Run with Verbose Logging

```sh
chopup --verbose -- node examples/interactive-script.js
# See extra [DEBUG] and [DEBUG_SOCKET] logs
```

### Run with Initial Log Chop

```sh
chopup --initial-chop -- node examples/long-running-script.js
```

---

## Local Development Usage (Alternative)

If you have `chopup` cloned locally:

**Run/Wrap a process:**
```sh
pnpm start -- run [--log-dir <log-dir>] [--socket-path <path>] [--initial-chop] [--watch-file <file-or-dir>] [--send <input>] [--verbose] -- <command-to-wrap> [args...]
# Or (since run is default):
pnpm start -- [--log-dir <log-dir>] [--socket-path <path>] [--initial-chop] [--watch-file <file-or-dir>] [--send <input>] [--verbose] -- <command-to-wrap> [args...]
```

**Request Logs via IPC:**
```sh
pnpm start -- request-logs --socket <socket-path>
```

**Send Input via IPC:**
```sh
pnpm start -- send-input --socket <socket-path> --input "<string-to-send>"
```

---

## Troubleshooting

- **No logs are chopped:** You must use the `chopup request-logs --socket <path>` command.
- **Input not sent / IPC not working:** 
  - Ensure you are using the correct IPC socket path from the running `chopup run` instance's output (`CHOPUP_SOCKET_PATH=...`).
  - Verify the `chopup run` instance is still running.
  - Ensure the wrapped application is actually waiting for stdin if you are using `send-input`.
  - For `send-input`, only `CHOPUP_INPUT_SENT`, `CHOPUP_INPUT_SEND_ERROR`, `CHOPUP_INPUT_SEND_ERROR_NO_CHILD`, or `CHOPUP_INPUT_SEND_ERROR_BACKPRESSURE` will be printed to stdout. Connection errors will be printed to stderr as `CHOPUP_INPUT_SEND_ERROR_NO_SERVER` or `CHOPUP_SEND_INPUT_ERROR_CONNECTION_FAILED`. All other logs are suppressed for this command.
- **Log files not appearing:** Check permissions on the log directory and that the `chopup run` process has not exited before logs could be written.
- **Process cleanup:** All child processes are killed on exit. If not, use `tree-kill` or manually clean up.
- **Error Codes:**
  - `CHOPUP_INPUT_SEND_ERROR_NO_SERVER`: Could not connect to the IPC socket (wrong path or process exited).
  - `CHOPUP_INPUT_SEND_ERROR`: Failed to send input to the child process.
  - `CHOPUP_INPUT_SEND_ERROR_NO_CHILD`: No child process available to send input.
  - `CHOPUP_INPUT_SEND_ERROR_BACKPRESSURE`: Child process stdin buffer is full.
  - `CHOPUP_REQUEST_LOGS_ERROR_NO_SERVER`: Could not connect to the IPC socket for log chopping.
  - `CHOPUP_REQUEST_LOGS_ERROR_UNKNOWN`: Unknown error during log chopping request.
  - `CHOPUP_SEND_INPUT_ERROR_CONNECTION_FAILED`: General connection failure for send-input.
  - `CHOPUP_SEND_INPUT_ERROR_UNEXPECTED_RESPONSE`: Unexpected response from server.
  - `CHOPUP_SEND_INPUT_ERROR_SERVER_PARSE`: Server could not parse the IPC message.
  - `CHOPUP_SEND_INPUT_ERROR_UNEXPECTED_CLOSE`: IPC connection closed unexpectedly.

---

## Development

- Format: `pnpm format`
- Lint: `pnpm lint`
- Test: `pnpm test`
- Build: `pnpm build` (creates `dist/index.js`)

---

## Verifying Examples

All example scripts referenced above are in the `examples/` directory:
- `examples/interactive-script.js`: Simple script that prints input it receives.
- `examples/long-running-script.js`: Script that logs periodically.

To verify the CLI and README examples:

1. Open two or more terminals in the project root.
2. In one terminal, run a `chopup` example (see above).
3. In another terminal, use `chopup send-input` or `chopup request-logs` as shown.
4. Check the output and log files in the specified log directory.

A helper script `examples/verify-examples.sh` is provided to automate these checks for CI or local verification.

---

## License
ISC 

## CI/CD & Release

![CI](https://github.com/johnlindquist/spawn-wrapper/actions/workflows/ci.yml/badge.svg)
![Release](https://github.com/johnlindquist/spawn-wrapper/actions/workflows/release.yml/badge.svg)

- All PRs and pushes run CI (build, test, cross-platform smoke test).
- Merges to `main` trigger semantic-release:
  - Version bump, changelog, and npm publish (public).
  - Requires `NPM_TOKEN` secret in repo settings.
  - Uses [Conventional Commits](https://www.conventionalcommits.org/) for changelog and versioning.
- Excessive logging is enabled in CI and release for observability.

### Local Release Test

```sh
pnpm run release --dry-run
```

### NPM Publish

- Set `NPM_TOKEN` in GitHub repo secrets for publish to work.
- `publishConfig.access` is set to `public` in package.json. 