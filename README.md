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

---

## Usage (Global CLI)

`chopup` now uses explicit subcommands: `run` (default), `request-logs`, and `send-input`.

### 1. Wrap a Process (using the `run` command)

This is the default command if no other subcommand is specified.

```sh
chopup run [--log-dir <log-dir>] [--log-prefix <prefix>] -- <command-to-wrap> [args...]
# OR (since run is default):
chopup [--log-dir <log-dir>] [--log-prefix <prefix>] -- <command-to-wrap> [args...]
```

**Example:**

```sh
chopup run -- node my-interactive-app.js
# Or simply:
chopup -- node my-interactive-app.js
```

- `--log-dir <path>`: Directory to store chopped log files (optional, defaults to a sanitized folder in the system temp dir, e.g., `/tmp/chopup_<project>_<cmd>`).
- `--log-prefix <prefix>`: Prefix for log file names (e.g., `myapp-`). Defaults to empty (timestamp only).
- `--`: Separator before the command to wrap.
- `<command-to-wrap> [args...]`: The command and arguments to run (e.g., `node my-app.js`).

**What happens:**
- The wrapped process runs.
- All stdout/stderr is captured by `chopup`.
- On startup, `chopup` logs its own PID and the IPC socket path to its stdout:
  ```
  [CHOPUP] PID: 12345
  [CHOPUP] IPC socket: /tmp/chopup_12345.sock 
  ```
  (Note: The actual socket path might be different, check the output.)
- Log chopping and input sending only occur when requested via IPC using other `chopup` commands (see below).

---

### 2. Trigger Log Chopping via IPC (from another shell)

Use the `request-logs` command:

```sh
chopup request-logs --socket <socket-path>
```

**Example:**

```sh
chopup request-logs --socket /tmp/chopup_12345.sock
```

- `--socket <socket-path>`: The IPC socket path of the running `chopup run` instance (from its startup log output).

**What happens:**
- The tool connects to the running `chopup run` instance via its IPC socket.
- It requests an immediate log chop.
- The path to the new log file is printed if logs were chopped, or a message if no new logs.

---

### 3. Sending Input to the Wrapped Process via IPC (from another shell)

Use the `send-input` command:

```sh
chopup send-input --socket <socket-path> --input "<string-to-send>"
```

**Example:**

Imagine `my-interactive-app.js` (from step 1) prompts "Are you sure? (y/n): ".

```sh
chopup send-input --socket /tmp/chopup_12345.sock --input "y\n"
```

- `--socket <socket-path>`: The IPC socket path of the running `chopup run` instance.
- `--input "<string-to-send>"`: The string to send to the wrapped process's stdin. 
  - **Important**: If your wrapped process expects a newline to process the input (common for CLI prompts), make sure to include `\n` in your input string, e.g., `"y\n"` or `"some text then enter\n"`.

**What happens:**
- Connects to the `chopup run` instance via IPC.
- Sends the specified string to the stdin of the process `chopup` is wrapping.
- The `send-input` command will print a confirmation (e.g., `INPUT_SENT`) or an error message.

---

## Example Workflow

1.  **Start `chopup run` in one shell with an interactive script:**
    ```sh
    # interactive-script.js might be something like:
    # process.stdout.write('Enter your name: ');
    # process.stdin.once('data', (data) => { console.log(`Hello, ${data.toString().trim()}!`); process.exit(); });

    chopup run -- node interactive-script.js
    ```
    - Note the IPC socket path printed (e.g., `/tmp/chopup_12345.sock`).

2.  **From another shell, send input to the script:**
    ```sh
    chopup send-input --socket /tmp/chopup_12345.sock --input "Alice\n"
    ```

3.  **Observe `interactive-script.js` in the first shell receiving the input and completing.**

4.  **From another shell, trigger a log chop:**
    ```sh
    chopup request-logs --socket /tmp/chopup_12345.sock
    ```

5.  **Check the log directory for segmented log files.**

---

## Local Development Usage (Alternative)

If you have `chopup` cloned locally:

**Run/Wrap a process:**
```sh
pnpm start -- run [--log-dir <log-dir>] [--log-prefix <prefix>] -- <command-to-wrap> [args...]
# Or (since run is default):
pnpm start -- [--log-dir <log-dir>] [--log-prefix <prefix>] -- <command-to-wrap> [args...]
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
  - Ensure you are using the correct IPC socket path from the running `chopup run` instance's output.
  - Verify the `chopup run` instance is still running.
  - Ensure the wrapped application is actually waiting for stdin if you are using `send-input`.
- **Log files not appearing:** Check permissions on the log directory and that the `chopup run` process has not exited before logs could be written.
- **Process cleanup:** All child processes are killed on exit. If not, use `tree-kill` or manually clean up.

---

## Development

- Format: `pnpm format`
- Lint: `pnpm lint`
- Test: `pnpm test`
- Build: `pnpm build` (creates `dist/index.js`)

---

## License
ISC 