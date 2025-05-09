# chopup

A CLI tool to wrap long-running processes and chop output into segments on IPC request.

---

## Installation (Recommended: Global)

Install globally with pnpm:

```sh
pnpm add -g chopup
```

---

## Features
- Wraps and runs any user-specified command (no subcommand required)
- Monitors a specified file or directory for changes (add, change, unlink)
- Captures stdout and stderr from the wrapped process
- Segments/chops logs into new files in a specified log directory on file change or IPC request
- Graceful shutdown and bulletproof process tree cleanup
- IPC server for on-demand log chopping via meta file

---

## Usage (Global CLI)

### 1. Wrap a Process (IPC-only log chopping)

```sh
chopup [--log-dir <log-dir>] [--log-prefix <prefix>] -- <command-to-wrap> [args...]
```

**Example:**

```sh
chopup -- node my-app.js
```

- `--log-dir <path>`: Directory to store chopped log files (optional, defaults to a sanitized folder in the system temp dir)
- `--log-prefix <prefix>`: Prefix for log file names (default: `log_`)
- `--`: Separator before the command to wrap
- `<command-to-wrap> [args...]`: The command and arguments to run (e.g., `node my-app.js`)

**What happens:**
- The wrapped process runs as normal.
- All stdout/stderr is captured.
- On startup, chopup logs its PID and IPC socket path to stdout:
  ```
  [CHOPUP] PID: 12345
  [CHOPUP] IPC socket: /tmp/chopup_12345.sock
  ```
- Log chopping only occurs when requested via IPC (see below).
- If `--log-dir` is not set, logs are written to a temp directory like `/tmp/chopup_<project>_<cmd>`.

---

### 2. Trigger Log Chopping via IPC (from another shell)

To request a log chop, run chopup with only the `--pid <pid>` flag (no command):

```sh
chopup --pid <pid>
```

**Example:**

```sh
chopup --pid 12345
```

- `--pid <pid>`: PID of the running chopup instance (see its startup log output)

**What happens:**
- The tool connects to the running chopup instance via its IPC socket.
- It requests an immediate log chop.
- The path to the new log file is printed if logs were chopped, or a message if no new logs.

---

## Example Workflow

1. **Start chopup in one shell:**
    ```sh
    chopup -- node my-app.js
    ```
    - Note the PID printed in the output (e.g., `12345`).
2. **Let the process run and produce output.**
3. **From another shell, trigger a log chop on demand:**
    ```sh
    chopup --pid 12345
    ```
4. **Check the log directory (default: system temp dir) for new segmented log files.**

---

## Local Development Usage (Alternative)

If you want to use chopup locally (not installed globally):

```sh
pnpm start -- [--log-dir <log-dir>] [--log-prefix <prefix>] -- <command-to-wrap> [args...]
```

Or for IPC requests:

```sh
pnpm start -- --pid <pid>
```

---

## Troubleshooting

- **No logs are chopped:** You must send an IPC request to chop logs.
- **IPC not working:** Make sure you use the correct PID from the running chopup instance's output.
- **Log files not appearing:** Check permissions on the log directory and that the process has not exited.
- **Process cleanup:** All child processes are killed on exit. If not, use `tree-kill` or manually clean up.

---

## Development

- Format: `pnpm format`
- Lint: `pnpm lint`
- Test: `pnpm test`
- Integration tests: `pnpm test:integration`

---

## License
ISC 