#!/usr/bin/env node

import { program } from "commander";
import path from "node:path";
import { spawn } from "node:child_process";
import chokidar from "chokidar"; // Import chokidar
import fs from "node:fs/promises"; // For file system operations
import fsSync from "node:fs"; // For sync unlink
import net from "node:net"; // For IPC
import treeKill from "tree-kill";
import os from "node:os";

console.log("[DEBUG] process.argv:", process.argv);

let effectiveArgv = process.argv;
if (effectiveArgv.length > 2 && effectiveArgv[2] === "--") {
    console.log(
        '[DEBUG] Slicing initial "--" from process.argv for commander parsing.',
    );
    effectiveArgv = [
        effectiveArgv[0],
        effectiveArgv[1],
        ...effectiveArgv.slice(3),
    ];
}
console.log("[DEBUG] effectiveArgv for commander:", effectiveArgv);

// Placeholder for actual logic
interface LogBufferEntry {
    timestamp: number;
    type: "stdout" | "stderr";
    line: string;
}
const logBuffer: LogBufferEntry[] = [];
let lastChopTime = Date.now();
let ipcServer: net.Server | null = null;
let childProcess: ReturnType<typeof spawn> | null = null; // Keep a reference to childProcess

// Logging helpers for observability
function log(...args: unknown[]) { console.log(...args); }
function logWarn(...args: unknown[]) { console.warn(...args); }
function logError(...args: unknown[]) { console.error(...args); }

function sanitizeForFolder(name: string): string {
    return name
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40);
}

function getIpcSocketPath(pid: number): string {
    // Use a temp dir socket path, cross-platform
    const base = os.tmpdir();
    const sockName = `chopup_${pid}.sock`;
    return path.join(base, sockName);
}

const mainAction = async (
    commandToRun: string[],
    options: { logDir?: string; logPrefix?: string },
) => {
    let { logDir, logPrefix } = options;
    const [originalCommand, ...originalArgs] = commandToRun;
    const command = "pnpm";
    const args = ["exec", originalCommand, ...originalArgs];

    // Default logDir logic
    if (!logDir) {
        const cwd = process.cwd();
        const base = sanitizeForFolder(path.basename(cwd));
        const cmd = sanitizeForFolder(originalCommand);
        logDir = path.join(os.tmpdir(), `chopup_${base}_${cmd}`);
        console.log(`[WRAPPER] No logDir specified. Using default: ${logDir}`);
    }
    const absoluteLogDir = path.resolve(logDir);

    console.log("--- Configuration ---");
    console.log(`Log directory: ${absoluteLogDir}`);
    console.log(`Log prefix: ${logPrefix}`);
    console.log(
        `Effective command to run: ${command} ${args.join(" ")} (original: ${originalCommand} ${originalArgs.join(" ")})`,
    );
    console.log("---------------------\n");

    // 1. Create logDir if it doesn't exist
    try {
        await fs.mkdir(absoluteLogDir, { recursive: true });
    } catch (error) {
        console.error(
            `[WRAPPER_ERROR] Could not create log directory: ${absoluteLogDir}`,
            error,
        );
        process.exit(1);
    }

    // Print PID for user to use in IPC (flush immediately)
    const pid = process.pid;
    const socketPath = getIpcSocketPath(pid);
    process.stdout.write(`[CHOPUP] PID: ${pid}\n`);
    process.stdout.write(`[CHOPUP] IPC socket: ${socketPath}\n`);

    const startTime = Date.now();

    const chopLogs = async (): Promise<string | null> => {
        console.log(
            `\n[WRAPPER] Chop logs request received. Chopping logs since ${new Date(lastChopTime).toISOString()}...`,
        );
        const logsToOutput = logBuffer.filter(
            (entry) => entry.timestamp > lastChopTime,
        );

        if (logsToOutput.length === 0) {
            console.log("[WRAPPER] No new logs to chop.");
            lastChopTime = Date.now();
            return null;
        }

        const outputFileName = `${logPrefix}${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
        const outputFilePath = path.join(absoluteLogDir, outputFileName);

        try {
            const logContent = logsToOutput
                .map(
                    (entry) =>
                        `[${new Date(entry.timestamp).toISOString()}] [${entry.type.toUpperCase()}] ${entry.line}`,
                )
                .join("\n");
            await fs.writeFile(outputFilePath, logContent);
            console.log(`[WRAPPER] Chopped logs saved to: ${outputFilePath}`);
            lastChopTime = Date.now();
            return outputFilePath;
        } catch (err) {
            console.error(
                `[WRAPPER_ERROR] Failed to write chopped log file: ${outputFilePath}`,
                err,
            );
            lastChopTime = Date.now();
            return null;
        }
    };

    // IPC Server Setup (UNIX socket)
    console.log(`[DEBUG] About to start IPC server on socket: ${socketPath}`);
    ipcServer = net.createServer((socket) => {
        console.log('[IPC_SERVER] Client connected.');
        socket.on('data', async (data) => {
            const rawMessage = data.toString();
            log(`IPC: Received raw message: "${rawMessage.replace(/\n/g, '\\n')}" (length: ${rawMessage.length})`);

            // Prioritize exact command matches
            if (rawMessage.trim() === 'REQUEST_LOGS') {
                log('IPC: Matched REQUEST_LOGS');
                const newLogFilePath = await chopLogs();
                if (newLogFilePath) {
                    socket.write(`LOG_CHOPPED:${newLogFilePath}`);
                } else {
                    socket.write('NO_NEW_LOGS');
                }
            } else if (rawMessage.startsWith('SEND_INPUT_REQUEST')) {
                // Accept both 'SEND_INPUT_REQUEST' and 'SEND_INPUT_REQUEST <payload>'
                let inputPayload = '';
                if (rawMessage === 'SEND_INPUT_REQUEST' || rawMessage === 'SEND_INPUT_REQUEST\n') {
                    inputPayload = '';
                } else if (rawMessage.startsWith('SEND_INPUT_REQUEST ')) {
                    inputPayload = rawMessage.substring('SEND_INPUT_REQUEST '.length);
                }
                log(`IPC: Matched SEND_INPUT_REQUEST. Payload: "${inputPayload.replace(/\n/g, '\\n')}"`);
                if (childProcess?.stdin && !childProcess?.stdin?.destroyed) {
                    childProcess.stdin.write(inputPayload, (err) => {
                        if (err) {
                            logError(`IPC: Error writing to child stdin: ${err.message}`);
                            socket.write('INPUT_SEND_ERROR');
                        } else {
                            log('IPC: Input sent successfully');
                            socket.write('INPUT_SENT');
                        }
                    });
                } else {
                    logWarn('IPC: Child process or stdin not available for input for SEND_INPUT_REQUEST.');
                    socket.write('INPUT_SEND_ERROR_NO_CHILD');
                }
            } else {
                logWarn(`IPC: Unknown message: "${rawMessage.replace(/\n/g, '\\n')}"`);
                socket.write('ERROR_UNKNOWN_MESSAGE');
            }
            socket.end();
        });
        socket.on('error', (err) => {
            console.error('[IPC_SERVER] Socket error:', err);
        });
        socket.on('end', () => {
            console.log('[IPC_SERVER] Client disconnected.');
        });
    });

    // Remove stale socket if exists
    try {
        await fs.unlink(socketPath);
    } catch { /* Ignore error if file doesn't exist */ }
    ipcServer.listen(socketPath, () => {
        console.log(`[DEBUG] IPC server is now listening on socket: ${socketPath}`);
        console.log(`[IPC_SERVER] Listening on socket: ${socketPath}`);
    });

    // Restore server error handler
    ipcServer.on('error', (err) => {
        console.error('[IPC_SERVER_ERROR] Server error:', err);
        ipcServer = null; // Allow for potential restart or flag as unusable
        try { fsSync.unlinkSync(socketPath); } catch { /* ignore */ }
    });

    // 3. Spawn the commandToRun
    console.log(`[DEBUG] Spawning child process: ${command} ${args.join(" ")}`);
    const cp = spawn(command, args, {
        // Assign to local, then to module
        stdio: ["pipe", "pipe", "pipe"],
        cwd: process.cwd(),
    });
    childProcess = cp; // Assign to module-level variable

    // 4. Pipe stdout/stderr from child process to logBuffer
    if (childProcess?.stdout) {
        childProcess.stdout.on("data", (data) => {
            const lines = data
                .toString()
                .split("\n")
                .filter((line: string) => line.length > 0);
            for (const line of lines) {
                console.log(`[CHILD_STDOUT] ${line}`);
                logBuffer.push({ timestamp: Date.now(), type: "stdout", line });
            }
        });
    } else {
        console.warn("[WRAPPER_WARN] Child process stdout is not available.");
    }

    if (childProcess?.stderr) {
        childProcess.stderr.on("data", (data) => {
            const lines = data
                .toString()
                .split("\n")
                .filter((line: string) => line.length > 0);
            for (const line of lines) {
                console.error(`[CHILD_STDERR] ${line}`);
                logBuffer.push({ timestamp: Date.now(), type: "stderr", line });
            }
        });
    } else {
        console.warn("[WRAPPER_WARN] Child process stderr is not available.");
    }

    if (childProcess) {
        childProcess.on("error", (error) => {
            console.error(
                `[WRAPPER_ERROR] Failed to start child process: ${error.message}`,
            );
            if (ipcServer) ipcServer.close();
            try {
                fsSync.unlinkSync(socketPath);
            } catch { }
            childProcess = null; // Clear reference
            process.exit(1);
        });
    }

    const cleanupAndExit = (code: number | null) => {
        console.log(`\nChild process exited with code ${code}`);

        const doCleanup = () => {
            try {
                fsSync.unlinkSync(socketPath);
            } catch { }
            console.log("[WRAPPER] Exiting.");
            process.exit(code === null ? 1 : code);
        };

        // If the process exited quickly and there are logs, wait a short grace period for IPC requests
        const runDuration = Date.now() - startTime;
        if (logBuffer.length > 0 && runDuration < 5000) {
            console.log(
                "[DEBUG] Child exited quickly, waiting 2s grace period for IPC requests...",
            );
            setTimeout(() => {
                console.log(
                    "[DEBUG] Grace period over, proceeding with final chopLogs and exit.",
                );
                chopLogs().finally(() => {
                    if (ipcServer) {
                        console.log("[WRAPPER] Closing IPC server...");
                        ipcServer.close(() => {
                            console.log("[IPC_SERVER] Server closed.");
                            childProcess = null; // Clear reference
                            doCleanup();
                        });
                        setTimeout(() => {
                            console.warn(
                                "[IPC_SERVER] Server close timed out. Forcing exit.",
                            );
                            childProcess = null; // Clear reference
                            doCleanup();
                        }, 2000);
                    } else {
                        childProcess = null; // Clear reference
                        doCleanup();
                    }
                });
            }, 2000);
            return;
        }

        console.log(
            "[WRAPPER] Child process closed, performing final immediate chopLogs.",
        );
        chopLogs().finally(() => {
            if (ipcServer) {
                console.log("[WRAPPER] Closing IPC server...");
                ipcServer.close(() => {
                    console.log("[IPC_SERVER] Server closed.");
                    childProcess = null; // Clear reference
                    doCleanup();
                });
                setTimeout(() => {
                    console.warn("[IPC_SERVER] Server close timed out. Forcing exit.");
                    childProcess = null; // Clear reference
                    doCleanup();
                }, 2000);
            } else {
                childProcess = null; // Clear reference
                doCleanup();
            }
        });
        if (childProcess?.pid) {
            treeKill(childProcess.pid, "SIGKILL", (err) => {
                if (err) {
                    console.error("[WRAPPER] Error killing process tree:", err);
                } else {
                    console.log(
                        `[WRAPPER] Killed process tree for PID ${childProcess?.pid}`,
                    );
                }
            });
        } else {
            console.warn(
                "[WRAPPER_WARN] Cannot treeKill: child process or PID not available at that stage.",
            );
        }
    };

    if (childProcess) {
        childProcess.on("close", cleanupAndExit);
    }

    // Graceful shutdown handling
    const gracefulShutdown = (signal: NodeJS.Signals) => {
        console.log(`\n[WRAPPER] Received ${signal}. Terminating child process...`);
        if (ipcServer) {
            console.log("[WRAPPER] Closing IPC server due to signal...");
            ipcServer.close(() =>
                console.log("[IPC_SERVER] Server closed due to signal."),
            );
        }
        if (childProcess?.pid) {
            treeKill(childProcess.pid, "SIGKILL", (err) => {
                if (err) {
                    console.error("[WRAPPER] Error killing process tree:", err);
                } else {
                    console.log(
                        `[WRAPPER] Killed process tree for PID ${childProcess?.pid}`,
                    );
                }
            });
        } else {
            console.warn(
                "[WRAPPER_WARN] Cannot treeKill: child process or PID not available at that stage.",
            );
        }
        // Note: The 'close' event on childProcess will trigger the final chopLogs and exit.
    };

    process.on("SIGINT", gracefulShutdown.bind(null, "SIGINT"));
    process.on("SIGTERM", gracefulShutdown.bind(null, "SIGTERM"));
};

program
    .name("chopup")
    .description(
        "Wraps a long-running process, monitors files, and segments logs.",
    )
    .version("1.0.0"); // Example version

program
    .command("run", { isDefault: true }) // Make this the default command
    .description(
        "Run the command and watch for logs/changes. This is the default behavior if no other command is specified.",
    )
    .option("-d, --log-dir <path>", "Directory to store chopped log files.")
    .option(
        "-p, --log-prefix <prefix>",
        'Prefix for chopped log file names (e.g., "myapp-"). Defaults to empty.',
    )
    // .option('-w, --watch <path>', 'File or directory to watch for changes (triggers log chopping).') // Future
    .argument(
        "<command_to_run...>",
        "The command and its arguments to wrap and monitor.",
    )
    .action(async (commandToRun, options) => {
        // Logic from existing mainAction
        await mainAction(commandToRun, options);
    });

program
    .command("request-logs")
    .description(
        "Requests the currently running chopup instance to chop and save logs.",
    )
    .requiredOption(
        "--socket <path>",
        "IPC socket path of the running chopup instance (from its startup logs).",
    )
    .action(async (options) => {
        const client = net.createConnection({ path: options.socket }, () => {
            console.log("[IPC_CLIENT] Connected to server.");
            client.write("REQUEST_LOGS");
        });
        client.on("data", (data) => {
            const response = data.toString();
            if (response === "NO_NEW_LOGS") {
                console.log("[IPC_CLIENT] Server responded: No new logs to chop.");
            } else if (response.startsWith("ERROR_")) {
                console.error(`[IPC_CLIENT] Server error: ${response}`);
            } else {
                console.log(`[IPC_CLIENT] Logs chopped to: ${response}`);
            }
            client.end();
        });
        client.on("error", (err) => {
            console.error("[IPC_CLIENT_ERROR] Connection error:", err.message);
        });
        client.on("end", () => {
            console.log("[IPC_CLIENT] Disconnected from server.");
        });
    });

program
    .command("send-input")
    .description(
        "Sends an input string to the stdin of the wrapped process via IPC.",
    )
    .requiredOption(
        "--socket <path>",
        "IPC socket path of the running chopup instance.",
    )
    .requiredOption(
        "--input <string>",
        "The string to send to the process stdin.",
    )
    .action(async (options) => {
        const client = net.createConnection({ path: options.socket }, () => {
            console.log("[IPC_CLIENT] Connected to server to send input.");
            // Ensure newline if it's line-based input, though the server adds one too.
            // User might send multi-line, so let server handle final newline for prompt.
            const message = `SEND_INPUT_REQUEST ${options.input}`;
            console.log(`[IPC_CLIENT] Sending: "${message}"`);
            client.write(message);
        });
        client.on("data", (data) => {
            const response = data.toString();
            console.log(`[IPC_CLIENT] Server response: ${response}`);
            client.end();
        });
        client.on("error", (err) => {
            console.error(
                "[IPC_CLIENT_ERROR] Connection error while sending input:",
                err.message,
            );
        });
        client.on("end", () => {
            console.log("[IPC_CLIENT] Disconnected from server after sending input.");
        });
    });

// if (process.argv.length <= 2 || process.argv[2] === '--') { // Heuristic for default command
//     program.parse([process.argv[0], process.argv[1], 'run', ...process.argv.slice(2)], { from: 'user' });
// } else {
//     program.parse(process.argv, { from: 'user' });
// }

// Simplified parsing:
// Commander now handles default command properly if 'run' is marked as default.
// The initial effectiveArgv handling should prepare argv for direct parsing.
program.parse(effectiveArgv);

// treeKill(childProcess.pid); // Example, ensure proper cleanup

// if (!process.argv.slice(2).length) {
//   program.outputHelp();
// }
