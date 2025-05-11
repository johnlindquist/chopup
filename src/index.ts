#!/usr/bin/env node

import { program, Command } from "commander";
import path from "node:path";
import { spawn } from "node:child_process";
import chokidar from "chokidar"; // Import chokidar
import fs from "node:fs/promises"; // For file system operations
import fsSync from "node:fs"; // For sync unlink
import net from "node:net"; // For IPC
import treeKill from "tree-kill";
import os from "node:os";
import type { Command as CommanderCommand } from "commander"; // Use 'import type'

let effectiveArgv = process.argv;
if (effectiveArgv.length > 2 && effectiveArgv[2] === "--") {
    effectiveArgv = [
        effectiveArgv[0],
        effectiveArgv[1],
        ...effectiveArgv.slice(3),
    ];
}

// Placeholder for actual logic
interface LogBufferEntry {
    timestamp: number;
    type: "stdout" | "stderr";
    line: string;
}
// const logBuffer: LogBufferEntry[] = []; // This global one seems unused if logic is in Chopup class
// let lastChopTime = Date.now(); // Appears unused globally, Chopup class has its own
// let ipcServer: net.Server | null = null; // Appears unused globally, Chopup class has its own
// let childProcess: ReturnType<typeof spawn> | null = null; // Appears unused globally, Chopup class has its own

// Logging helpers for observability
function log(...args: unknown[]) {
    console.log(...args);
}
function logWarn(...args: unknown[]) {
    console.warn(...args);
}
function logError(...args: unknown[]) {
    console.error(...args);
}

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

const INPUT_SENT = "CHOPUP_INPUT_SENT";
const INPUT_SEND_ERROR = "CHOPUP_INPUT_SEND_ERROR";
const INPUT_SEND_ERROR_NO_CHILD = "CHOPUP_INPUT_SEND_ERROR_NO_CHILD";
const INPUT_SEND_ERROR_NO_SERVER = "CHOPUP_INPUT_SEND_ERROR_NO_SERVER"; // Defined
const INPUT_SEND_ERROR_BACKPRESSURE = "CHOPUP_INPUT_SEND_ERROR_BACKPRESSURE";

class Chopup {
    private command: string;
    private args: string[];
    private logDir: string;
    private socketPath: string;
    private ipcServer!: net.Server; // Definite assignment assertion
    private childProcess: ReturnType<typeof spawn> | null = null;
    private logBuffer: LogBufferEntry[] = [];
    private lastChopTime: number = Date.now();
    private activeConnections = new Set<net.Socket>();
    private exitInProgress = false;
    private cleanupInitiated = false; // To prevent multiple cleanup runs

    constructor(
        command: string,
        args: string[],
        logDir: string,
        socketPath?: string,
    ) {
        this.command = command;
        this.args = args;
        this.logDir = path.resolve(logDir);
        // Ensure logDir exists
        if (!fsSync.existsSync(this.logDir)) {
            fsSync.mkdirSync(this.logDir, { recursive: true });
        }
        this.socketPath =
            socketPath || path.join(this.logDir, `chopup-${process.pid}.sock`);
        // Log initial state
        // this.log(`Chopup instance created. PID: ${process.pid}, Command: ${command}, Args: ${args.join(' ')}, LogDir: ${this.logDir}, SocketPath: ${this.socketPath}`);
    }

    // Centralized logging for the wrapper
    private log(message: string): void {
        // Optional: Add timestamp or other context
        const logMessage = `[chopup_wrapper ${new Date().toISOString()}] ${message}\n`;
        // For now, logs to internal buffer and potentially a debug file if needed later
        // To avoid polluting stdout/stderr meant for the wrapped process or IPC.
        // If direct console logging is needed for wrapper's own operations:
        // console.log(logMessage); // Or console.error for errors
    }

    private error(message: string): void {
        const errorMessage = `[chopup_wrapper ERROR ${new Date().toISOString()}] ${message}\n`;
        // console.error(errorMessage);
    }

    // For IPC messages or critical wrapper status that needs to be on console
    private logToConsole(
        message: string,
        stream: "stdout" | "stderr" = "stdout",
    ): void {
        if (!process.stdout.writable && !process.stderr.writable) {
            // Both streams are closed, nowhere to log this critical message.
            // This can happen during late-stage shutdown.
            // console.log(`[logToConsole SKIPPED] ${message}`); // Log to internal if absolutely necessary
            return;
        }
        const formattedMessage = `[chopup_wrapper] ${message.endsWith("\\n") ? message : `${message}\\n`}`; // Use template literal
        if (stream === "stdout" && process.stdout.writable) {
            process.stdout.write(formattedMessage);
        } else if (process.stderr.writable) {
            // Fallback to stderr if stdout not writable or stream is stderr
            process.stderr.write(formattedMessage);
        } else {
            // If primary stream (stdout) was specified but not writable, and stderr is also not writable.
            // This case is covered by the initial check, but as a safeguard.
        }
    }

    private initializeSignalHandlers(): void {
        process.on("SIGINT", async () => {
            this.log("Received SIGINT. Starting graceful shutdown...");
            await this.doCleanup(null, "SIGINT");
            process.exit(130); // Standard exit code for SIGINT
        });

        process.on("SIGTERM", async () => {
            this.log("Received SIGTERM. Starting graceful shutdown...");
            await this.doCleanup(null, "SIGTERM");
            process.exit(143); // Standard exit code for SIGTERM
        });

        process.on("exit", (code) => {
            this.log(
                `Wrapper process exiting with code ${code}. Performing final sync cleanup.`,
            );
            this.attemptSocketUnlinkOnExit(); // Synchronous only
            this.log("Process.exit handler finished.");
        });
    }

    private setupIpcServer(): void {
        // Ensure old socket is removed if it exists
        if (fsSync.existsSync(this.socketPath)) {
            this.log(`Removing existing socket file: ${this.socketPath}`);
            fsSync.unlinkSync(this.socketPath);
        }

        this.ipcServer = net.createServer((socket) => {
            this.log("IPC client connected");
            this.activeConnections.add(socket);

            socket.on("data", async (data) => {
                try {
                    const message = data.toString();
                    this.log(`IPC data received: ${message}`);
                    const parsedData = JSON.parse(message);

                    if (parsedData.command === "request-logs") {
                        this.log("IPC command: request-logs");
                        this.chopLog(); // Assuming chopLog is a method of Chopup
                        if (!socket.destroyed) socket.write("LOGS_CHOPPED");
                    } else if (parsedData.command === "send-input") {
                        this.log(`IPC command: send-input, input: "${parsedData.input}"`);
                        if (
                            this.childProcess?.stdin &&
                            !this.childProcess.stdin.destroyed
                        ) {
                            // Optional chaining
                            this.childProcess.stdin.write(parsedData.input, (err) => {
                                if (err) {
                                    this.error(
                                        `Error writing to child process stdin: ${err.message}`,
                                    );
                                    if (!socket.destroyed) {
                                        try {
                                            socket.write(INPUT_SEND_ERROR, () => {
                                                if (!socket.destroyed) socket.end(); // Server ends on error after write
                                            });
                                        } catch (e: unknown) {
                                            // any to unknown
                                            const writeError = e as Error; // Type assertion
                                            this.error(
                                                `IPC write error (INPUT_SEND_ERROR): ${writeError.message}`,
                                            );
                                            if (!socket.destroyed) socket.end(); // Also end if immediate catch
                                        }
                                    }
                                } else {
                                    this.log(
                                        `Successfully wrote to child process stdin: "${parsedData.input}"`,
                                    );
                                    this.logToConsole(INPUT_SENT, "stdout");
                                    if (!socket.destroyed) {
                                        try {
                                            socket.write(INPUT_SENT); // Server does NOT end socket here.
                                            this.log(
                                                "[IPC_SERVER] Successfully sent INPUT_SENT to client. Client will flush, end socket, then exit.",
                                            );
                                        } catch (e: unknown) {
                                            // any to unknown
                                            const writeError = e as Error; // Type assertion
                                            this.error(
                                                `IPC write error (INPUT_SENT): ${writeError.message}`,
                                            );
                                            if (!socket.destroyed) socket.end(); // End if write fails
                                        }
                                    }
                                }
                            });
                        } else {
                            this.log(
                                "No child process or stdin not available for send-input.",
                            );
                            if (!socket.destroyed) {
                                try {
                                    socket.write(INPUT_SEND_ERROR_NO_CHILD, () => {
                                        if (!socket.destroyed) socket.end(); // Server ends on error after write
                                    });
                                } catch (e: unknown) {
                                    // any to unknown
                                    const writeError = e as Error; // Type assertion
                                    this.error(
                                        `IPC write error (INPUT_SEND_ERROR_NO_CHILD): ${writeError.message}`,
                                    );
                                    if (!socket.destroyed) socket.end(); // Also end if immediate catch
                                }
                            }
                        }
                    } else {
                        this.log("Unknown IPC command");
                        if (!socket.destroyed) socket.write("UNKNOWN_COMMAND");
                    }
                } catch (e: unknown) {
                    // any to unknown
                    const parseError = e as Error; // Type assertion
                    this.error(`Error processing IPC data: ${parseError.message}`);
                    if (!socket.destroyed) {
                        try {
                            socket.write("ERROR_PROCESSING_COMMAND");
                            socket.end();
                        } catch (se: unknown) {
                            const sendError = se as Error;
                            this.error(sendError.message);
                        } // any to unknown
                    }
                }
            });

            socket.on("error", (err) => {
                this.error(`IPC socket error: ${err.message}`);
                this.activeConnections.delete(socket);
            });

            socket.on("close", () => {
                this.log("IPC client disconnected");
                this.activeConnections.delete(socket);
            });
        });

        this.ipcServer.on("error", (err) => {
            this.error(`IPC server error: ${err.message}`);
            // Potentially try to recover or shut down gracefully
            this.doCleanup(1, null).then(() => process.exit(1));
        });

        this.ipcServer.listen(this.socketPath, () => {
            this.log(`IPC server listening on ${this.socketPath}`);
            // Add a small delay to ensure the socket file is created before announcing it
            setTimeout(() => {
                this.logToConsole(`CHOPUP_SOCKET_PATH=${this.socketPath}`); // For discovery by clients
                // Print plain socket path for test detection
                process.stdout.write(`CHOPUP_SOCKET_PATH=${this.socketPath}\n`);
            }, 50); // 50ms delay
        });
    }

    private chopLog(isFinalChop = false): void {
        if (this.logBuffer.length === 0 && !isFinalChop) {
            // this.log('No new logs to chop.');
            return;
        }

        const chopTime = Date.now();
        const logFileName = `log-${this.lastChopTime}-${chopTime}.log`;
        const logFilePath = path.join(this.logDir, logFileName);

        // Create a string from the log buffer
        // NOTE: This simple concatenation might be problematic for very large buffers.
        // Consider streaming or more efficient aggregation if performance issues arise.
        const logContent = this.logBuffer
            .map(
                (entry) =>
                    `[${new Date(entry.timestamp).toISOString()}] [${entry.type}] ${entry.line}`,
            )
            .join("");

        try {
            fsSync.writeFileSync(logFilePath, logContent);
            this.log(`Logs chopped to ${logFilePath}`);
        } catch (e: unknown) {
            // any to unknown
            const writeError = e as Error; // Type assertion
            this.error(
                `Failed to write chopped log to ${logFilePath}: ${writeError.message}`,
            );
        }

        // Clear the buffer and update the last chop time
        this.logBuffer = [];
        this.lastChopTime = chopTime;
    }

    private recordOutput(data: Buffer | string, type: "stdout" | "stderr"): void {
        const dataStr = data.toString();
        // Echo to wrapper's console if not suppressed (this IS the child process output)
        if (type === "stdout") {
            process.stdout.write(dataStr);
        } else {
            process.stderr.write(dataStr);
        }
        // Buffer for chopping
        this.logBuffer.push({ timestamp: Date.now(), type, line: dataStr });
    }

    private async performFinalCleanup(
        exitCode: number | null,
        signal: NodeJS.Signals | null,
    ): Promise<void> {
        this.log(
            `performFinalCleanup called. Exit code: ${exitCode}, Signal: ${signal}`,
        );
        this.chopLog(true); // Perform a final log chop

        // Close all active IPC connections
        this.log(
            `Closing ${this.activeConnections.size} active IPC connections...`,
        );
        for (const ipcClientSocket of this.activeConnections) {
            if (!ipcClientSocket.destroyed) {
                ipcClientSocket.end();
                ipcClientSocket.destroy(); // Ensure it's destroyed
            }
        }
        this.activeConnections.clear();
        this.log("Active IPC connections closed.");

        // Close IPC server
        if (this.ipcServer) {
            this.log("Closing IPC server...");
            await new Promise<void>((resolve, reject) => {
                this.ipcServer.close((err) => {
                    if (err) {
                        this.error(`Error closing IPC server: ${err.message}`);
                        // Don't reject, cleanup should continue
                    }
                    this.log("IPC server closed.");
                    resolve();
                });
            });
        }
        // Unlink socket file (moved to attemptSocketUnlinkOnExit for process.on('exit'))
        // this.attemptSocketUnlink();

        // Terminate child process tree
        if (this.childProcess?.pid && !this.childProcess.killed) {
            // Optional chaining
            this.log(
                `Terminating child process tree for PID: ${this.childProcess.pid}...`,
            );
            const childPid = this.childProcess.pid;
            await new Promise<void>((resolve, reject) => {
                let treeKillTimeout: NodeJS.Timeout | null = null;
                const killCallback = (err?: Error) => {
                    if (treeKillTimeout) clearTimeout(treeKillTimeout);
                    if (err) {
                        this.error(`tree-kill error for PID ${childPid}: ${err.message}`);
                    }
                    this.log(`Child process tree for PID ${childPid} terminated.`);
                    resolve();
                };

                treeKillTimeout = setTimeout(() => {
                    this.error(
                        `tree-kill for PID ${childPid} timed out after 2 seconds. Proceeding with cleanup.`,
                    );
                    killCallback(); // Call with no error to resolve the promise and continue cleanup
                }, 2000); // 2-second timeout for treeKill

                treeKill(childPid, "SIGKILL", killCallback);
            });
        } else {
            this.log("No active child process to terminate or already killed.");
        }
        this.log("performFinalCleanup finished.");
    }

    private attemptSocketUnlink(): void {
        if (this.socketPath && fsSync.existsSync(this.socketPath)) {
            try {
                this.log(
                    `[DEBUG] Socket file '${this.socketPath}' exists. Unlinking...`,
                );
                fsSync.unlinkSync(this.socketPath);
                this.log(
                    `[DEBUG] Socket file '${this.socketPath}' unlinked successfully.`,
                );
            } catch (e: unknown) {
                // any to unknown
                const unlinkError = e as Error; // Type assertion
                this.error(
                    `Error unlinking socket file ${this.socketPath}: ${unlinkError.message}`,
                );
            }
        } else if (this.socketPath) {
            this.log(
                `[DEBUG] Socket file '${this.socketPath}' does not exist or path is null. No unlink needed.`,
            );
        }
    }

    // This is the synchronous, last-ditch effort for process.on('exit')
    private attemptSocketUnlinkOnExit(): void {
        this.log(
            `[DEBUG] attemptSocketUnlinkOnExit: Received sockPath='${this.socketPath}' cleanupInitiated=${this.cleanupInitiated}`,
        );
        if (this.socketPath && fsSync.existsSync(this.socketPath)) {
            this.log(
                `[DEBUG] Socket file '${this.socketPath}' exists. Attempting synchronous unlink.`,
            );
            // Adding a small delay as requested, though its effectiveness in sync 'exit' is debatable.
            // For very fast server close, OS might not have released handle.
            const start = Date.now();
            while (Date.now() - start < 150) {
                /* busy wait for 150ms */
            }
            this.log("[DEBUG] Post-delay in attemptSocketUnlinkOnExit.");
            try {
                fsSync.unlinkSync(this.socketPath);
                this.log(
                    `[DEBUG] Socket file '${this.socketPath}' unlinked successfully on exit.`,
                );
            } catch (e: unknown) {
                // any to unknown
                const unlinkError = e as Error; // Type assertion
                // Log to console if possible, as this is a last chance
                const errorMsg = `[DEBUG] Error unlinking socket file ${this.socketPath} on exit: ${unlinkError.message}`;
                if (process.stderr.writable)
                    process.stderr.write(`${errorMsg}\\n`); // Template literal
                else if (process.stdout.writable)
                    process.stdout.write(`${errorMsg}\\n`); // Template literal
                // else console.log(errorMsg); // Fallback if streams are gone
            }
        } else if (this.socketPath) {
            // console.log(`[DEBUG] Socket file '${this.socketPath}' does not exist on exit. No unlink needed.`);
        }
    }

    private async doCleanup(
        exitCode: number | null = null,
        signal: NodeJS.Signals | null = null,
    ): Promise<void> {
        if (this.exitInProgress) {
            return;
        }
        this.exitInProgress = true;
        await this.performFinalCleanup(exitCode, signal);
    }

    public async run(): Promise<void> {
        this.logToConsole(
            `Starting wrapper for command: ${this.command} ${this.args.join(" ")}`,
        );
        this.logToConsole(`Log directory: ${this.logDir}`);
        this.logToConsole(`IPC socket path: ${this.socketPath}`);

        this.initializeSignalHandlers();
        this.setupIpcServer();

        this.childProcess = spawn(this.command, this.args, {
            stdio: ["pipe", "pipe", "pipe"], // stdin, stdout, stderr
        });

        this.logToConsole(`CHOPUP_CHILD_PID=${this.childProcess.pid}`);

        this.childProcess.stdout?.on("data", (data) => {
            this.recordOutput(data, "stdout");
        });

        this.childProcess.stderr?.on("data", (data) => {
            this.recordOutput(data, "stderr");
        });

        this.childProcess.on("error", (err) => {
            this.error(`Child process error: ${err.message}`);
            // this.doCleanup(1, null).then(() => process.exit(1)); // Ensure cleanup on child error
        });

        this.childProcess.on("close", async (code, signal) => {
            this.log(
                `Child process closed. Code: ${code}, Signal: ${signal}. Exit in progress: ${this.exitInProgress}`,
            );
            // If cleanup hasn't been initiated by a signal, do it now.
            if (!this.exitInProgress) {
                await this.doCleanup(code, signal);
            }
            process.exit(code ?? 1);
        });

        // Add process exit handler for guaranteed socket unlink
        process.on('exit', () => {
            if (this.socketPath && fsSync.existsSync(this.socketPath)) {
                try {
                    fsSync.unlinkSync(this.socketPath);
                    console.log(`[CHOPUP_WRAPPER] Synchronously unlinked socket file on exit: ${this.socketPath}`);
                } catch (e) {
                    console.error(`[CHOPUP_WRAPPER] Failed to unlink socket file on exit: ${this.socketPath}`, e);
                }
            } else {
                console.log(`[CHOPUP_WRAPPER] No socket file to unlink on exit: ${this.socketPath}`);
            }
        });
    }
}

// Helper function to extract command and args
// function extractCommandAndArgs(program: Command, args: string[]): { commandToExecute: string, argsForCommand: string[] } {
//     let commandToExecute: string;
//     let argsForCommand: string[];

//     if (program.opts().passthrough && program.opts().passthrough.length > 0) {
//         [commandToExecute, ...argsForCommand] = program.opts().passthrough;
//     } else if (args.length > 0) {
//         [commandToExecute, ...argsForCommand] = args;
//     } else {
//         console.error("Error: No command provided to run.");
//         process.exit(1);
//     }
//     return { commandToExecute, argsForCommand };
// }

// This is the main action for the 'run' command or default passthrough
async function mainAction(
    this: CommanderCommand,
    commandToRunArgs: string[],
    cmdOptionsObj: Record<string, unknown>,
) {
    // 'this' is the Command instance, thanks to .action(mainAction)
    // cmdOptionsObj will be the first arg if no commandToRunArgs, or the second if there are.
    // For passthrough, commandToRunArgs is empty.
    // For `chopup run cmd --arg1`, commandToRunArgs is ['cmd', '--arg1']

    // console.log("[DEBUG] mainAction called.");
    // console.log("[DEBUG] this (Command instance):", this);
    // console.log("[DEBUG] commandToRunArgs:", commandToRunArgs);
    // console.log("[DEBUG] cmdOptionsObj:", cmdOptionsObj); // This might be the command if not passthrough

    let commandToExecute: string;
    let argsForCommand: string[];
    const options = this.opts(); // Get options from the Command instance

    // console.log("[DEBUG] Parsed options (this.opts()):", options);

    if (options.passthrough && options.passthrough.length > 0) {
        // This case handles `chopup --log-dir /tmp/foo -- pnpm dev`
        // console.log("[DEBUG] Using passthrough arguments:", options.passthrough);
        [commandToExecute, ...argsForCommand] = options.passthrough;
    } else if (commandToRunArgs && commandToRunArgs.length > 0) {
        // This case handles `chopup run pnpm dev --log-dir /tmp/foo`
        // where commandToRunArgs = ['pnpm', 'dev']
        // console.log("[DEBUG] Using commandToRunArgs:", commandToRunArgs);
        [commandToExecute, ...argsForCommand] = commandToRunArgs;
    } else {
        // This case handles `chopup --log-dir /tmp/foo` (no command after options)
        // This should have been caught by requiredOption or .command arugment checks
        // but if it somehow gets here, it's an error.
        console.error(
            "[ERROR] No command provided to run. Please specify a command after 'run' or use '--' for passthrough.",
        );
        this.help(); // Show help, which will exit
        return; // Keep linter happy, though help() exits.
    }

    // console.log("[DEBUG] Determined commandToExecute:", commandToExecute);
    // console.log("[DEBUG] Determined argsForCommand:", argsForCommand);

    if (!commandToExecute) {
        console.error(
            "[ERROR] Failed to determine the command to execute. Check your arguments.",
        );
        this.help();
        return;
    }

    const logDir = options.logDir || path.join(process.cwd(), "chopup-logs");
    const socketPath = options.socketPath; // Can be undefined, Chopup constructor handles default

    // console.log(`[DEBUG] Log directory for Chopup: ${logDir}`);
    // console.log(`[DEBUG] Socket path for Chopup: ${socketPath || 'Default (handled by Chopup)'}`);

    const wrapper = new Chopup(
        commandToExecute,
        argsForCommand,
        logDir,
        socketPath,
    );
    try {
        await wrapper.run();
    } catch (error: unknown) {
        const runError = error as Error & { stack?: string }; // Type assertion
        console.error(`[ERROR] Unhandled error in Chopup run: ${runError.message}`);
        console.error(runError.stack);
        process.exit(1);
    }
}

program
    .name("chopup")
    .description(
        "Wraps a long-running process, monitors files, and segments logs.",
    )
    .version("1.0.0")
    .enablePositionalOptions();

program
    .command("run", { isDefault: true })
    .description(
        "Run the specified command and wrap it. This is the default command if no other is specified. Arguments after '--' are also treated as the command to run (passthrough).",
    )
    .option(
        "-l, --log-dir <dir>",
        "Directory to store logs.",
        path.join(process.cwd(), "chopup-logs"),
    )
    .option(
        "-p, --log-prefix <prefix>",
        "Prefix for log file names (used by some tests, e.g., passthrough_test_)",
    )
    .option("-s, --socket-path <path>", "Specify a custom IPC socket path.")
    .passThroughOptions(true)
    .argument(
        "[command_to_run_arg_array...]",
        "The command and its arguments to run (e.g., 'node my-script.js arg1'). Not used if -- is present.",
    )
    .action(mainAction); // Pass mainAction directly

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

// Helper to suppress logs except for allowed send-input responses
function suppressSendInputLogs() {
    // console.error('DEBUG: Suppressing all console output for send-input'); // For debugging the suppressor itself
    const noOp = () => { };
    console.log = noOp;
    console.error = noOp;
    console.warn = noOp;
    // Note: This does not affect process.stdout.write or process.stderr.write directly.
}

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
        suppressSendInputLogs(); // Suppress internal logs from send-input client itself
        const anErrorOccurred = false; // This was 'let', but seems it's never reassigned. Changed to const.

        const connectAndSend = () => {
            const client = net.createConnection(options.socketPath);
            let hasExited = false;
            let anErrorFromServer = false; // Tracks if the error originated from server response or connection issue

            const exitGracefully = (code = 0, fromClose = false) => {
                if (hasExited) return;
                hasExited = true;

                if (!client.destroyed && !fromClose) {
                    // console.log('[send-input-client] exitGracefully: client not destroyed and not fromClose, calling client.end()');
                    client.end(); // This will trigger the 'close' event eventually.
                    // Do not call process.exit here directly; let 'close' handler do it.
                    return; // Important: return to avoid proceeding to process.exit if not fromClose
                }

                // If fromClose is true, or if client was already destroyed when exitGracefully was called initially.
                // console.log(`[send-input-client] exitGracefully: proceeding to process.exit(${code}) (fromClose: ${fromClose}, client.destroyed: ${client.destroyed})`);
                process.exit(code);
            };

            client.on("connect", () => {
                // console.log('[send-input-client] Connected to server');
                const command = { command: "send-input", input: options.input };
                client.write(JSON.stringify(command));
                // console.log('[send-input-client] Sent command to server');
                // Don't end the client stream here; wait for server's response (INPUT_SENT or error)
            });

            client.on("data", (data) => {
                const message = data.toString();
                const isError = message.startsWith("CHOPUP_INPUT_SEND_ERROR");
                const stream = isError ? process.stderr : process.stdout;
                anErrorFromServer = isError; // Set based on server message

                stream.write(`${message}\n`, () => {
                    // After flushing the message, client initiates closing its end.
                    // The 'close' event will handle process.exit.
                    if (!client.destroyed) {
                        // console.log('[send-input-client] data handler: flushed output, calling client.end()');
                        client.end();
                    }
                });
            });

            client.on("end", () => {
                // console.log('[send-input-client] Server closed the connection (client.on(end)). Will be followed by \'close\'.');
                // Client should ensure it also closes if server ends connection.
                // If client.end() hasn't been called, this ensures eventual 'close'.
                // However, typically 'data' or 'error' handlers would call client.end() first.
                if (!client.destroyed) client.end();
            });

            client.on("close", () => {
                // console.log(`[send-input-client] Connection closed (client.on(close)). Error from server: ${anErrorFromServer}`);
                exitGracefully(anErrorFromServer ? 1 : 0, true); // true for fromClose ensures process.exit
            });

            client.on("error", (err: unknown) => {
                // any to unknown
                const connError = err as Error & { code?: string }; // Type assertion
                // console.error(`[send-input-client] Connection error: ${connError.message}. Code: ${connError.code}`);
                anErrorFromServer = true; // Indicate an error occurred for exit code in 'close'
                let msgToSend = INPUT_SEND_ERROR;
                if (connError.code === "ECONNREFUSED" || connError.code === "ENOENT") {
                    msgToSend = INPUT_SEND_ERROR_NO_SERVER;
                }

                // Write the error message to stdout, then client.end() in callback.
                // process.exit will be handled by the 'close' event.
                process.stdout.write(`${msgToSend}\n`, () => {
                    if (!client.destroyed) {
                        // console.log('[send-input-client] error handler: flushed output, calling client.end()');
                        client.end();
                    }
                });
            });

            // Timeout for the whole operation
            setTimeout(() => {
                if (!hasExited) {
                    // console.error('[send-input-client] Operation timed out.');
                    // Output a generic error message as the server might be unresponsive
                    process.stdout.write(`${INPUT_SEND_ERROR_NO_SERVER}\n`, () => {
                        exitGracefully(1);
                    });
                }
            }, 5000); // 5-second timeout for send-input operation
        };

        if (!options.socketPath) {
            process.stdout.write(`${INPUT_SEND_ERROR_NO_SERVER}\n`, () =>
                process.exit(1),
            );
            return;
        }
        connectAndSend();
    });

// Add global --pid support for test compatibility
const globalPidIndex = effectiveArgv.findIndex((arg) => arg === "--pid");
if (globalPidIndex !== -1 && effectiveArgv[globalPidIndex + 1]) {
    const pid = effectiveArgv[globalPidIndex + 1];
    const socketPath = getIpcSocketPath(Number(pid));
    const client = net.createConnection({ path: socketPath }, () => {
        client.write("REQUEST_LOGS");
    });
    client.on("data", (data) => {
        const response = data.toString();
        if (response.startsWith("LOG_CHOPPED:")) {
            const logPath = response.replace("LOG_CHOPPED:", "").trim();
            console.log(`New log file created: ${logPath}`);
        } else if (response === "NO_NEW_LOGS") {
            console.log("No new logs to chop.");
        } else {
            console.error(`Server error: ${response}`);
        }
        client.end();
    });
    client.on("error", (err) => {
        console.error("[IPC_CLIENT_ERROR] Connection error:", err.message);
        process.exit(1);
    });
    client.on("end", () => {
        process.exit(0);
    });
    // Do not run commander if --pid is present
} else {
    program.parse(effectiveArgv);
}

// treeKill(childProcess.pid); // Example, ensure proper cleanup

// if (!process.argv.slice(2).length) {
//   program.outputHelp();
// }

const cleanupCalled = false; // Changed to const
