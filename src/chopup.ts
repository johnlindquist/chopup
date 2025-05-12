import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import net from "node:net";
import treeKill from "tree-kill";
import os from "node:os";

// Correct SpawnFunction signature to match ChildProcess types
export type SpawnFunction = (
    command: string,
    args?: ReadonlyArray<string>,
    options?: SpawnOptions,
) => ChildProcess;

export type NetServerConstructor = {
    createServer: typeof net.createServer; // Use typeof for accuracy
};

// Interface for objects mimicking ChildProcess, used by FakeChildProcess
export interface ChildProcessLike extends NodeJS.EventEmitter {
    stdin: NodeJS.WritableStream | null; // Use specific stream types
    stdout: NodeJS.ReadableStream | null;
    stderr: NodeJS.ReadableStream | null;
    pid?: number;
    connected?: boolean;
    kill: (signal?: NodeJS.Signals | number) => boolean;
    disconnect?: () => void;
}

export interface LogBufferEntry {
    timestamp: number;
    type: "stdout" | "stderr";
    line: string;
}

export const INPUT_SENT = "CHOPUP_INPUT_SENT";
export const INPUT_SEND_ERROR = "CHOPUP_INPUT_SEND_ERROR";
export const INPUT_SEND_ERROR_NO_CHILD = "CHOPUP_INPUT_SEND_ERROR_NO_CHILD";
export const INPUT_SEND_ERROR_BACKPRESSURE = "CHOPUP_INPUT_SEND_ERROR_BACKPRESSURE";

export const LOGS_CHOPPED = "LOGS_CHOPPED";
export const REQUEST_LOGS_COMMAND = "request-logs";
export const SEND_INPUT_COMMAND = "send-input";


export class Chopup {
    private command: string;
    private args: string[];
    private logDir: string;
    private socketPath: string;
    private ipcServer!: net.Server;
    private childProcess: ChildProcess | null = null;
    private logBuffer: LogBufferEntry[] = [];
    private lastChopTime: number = Date.now();
    private activeConnections = new Set<net.Socket>();
    private exitInProgress = false;
    private cleanupInitiated = false;

    // Injected dependencies
    private spawnFn: SpawnFunction;
    private netCreateServerFn: typeof net.createServer; // Use typeof

    constructor(
        command: string,
        args: string[],
        logDir: string,
        socketPath?: string,
        // Injectable dependencies for testing
        spawnFunction?: SpawnFunction,
        netModule?: NetServerConstructor, // Use NetServerConstructor type
    ) {
        this.command = command;
        this.args = args;
        this.logDir = path.resolve(logDir);
        if (!fsSync.existsSync(this.logDir)) {
            fsSync.mkdirSync(this.logDir, { recursive: true });
        }
        this.socketPath =
            socketPath || path.join(this.logDir, `chopup-${process.pid}.sock`);

        // Use injected dependencies or default to actual modules
        this.spawnFn = spawnFunction || spawn; // Type compatibility should be better now
        this.netCreateServerFn = netModule?.createServer || net.createServer;
    }

    // Centralized logging for the wrapper
    private log(message: string): void {
        const logMessage = `[chopup_wrapper ${new Date().toISOString()}] ${message}\n`;
        // console.log(logMessage);
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

        this.ipcServer = this.netCreateServerFn((socket) => {
            this.log("IPC client connected");
            this.activeConnections.add(socket);

            socket.on("data", async (data) => {
                try {
                    const message = data.toString();
                    this.log(`IPC data received: ${message}`);
                    const parsedData = JSON.parse(message);

                    if (parsedData.command === REQUEST_LOGS_COMMAND) {
                        this.log("IPC command: request-logs");
                        this.chopLog();
                        if (!socket.destroyed) socket.write(LOGS_CHOPPED);
                    } else if (parsedData.command === SEND_INPUT_COMMAND) {
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
                                    // this.logToConsole(INPUT_SENT, "stdout"); // Client will log this based on socket reply
                                    if (!socket.destroyed) {
                                        try {
                                            socket.write(INPUT_SENT); // Server does NOT end socket here.
                                            this.log(
                                                "[IPC_SERVER] Successfully sent INPUT_SENT to client.",
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
                    const parseError = e as Error;
                    this.error(`IPC data parse error: ${parseError.message}. Data: ${data.toString()}`);
                    if (!socket.destroyed) {
                        try {
                            socket.write("IPC_PARSE_ERROR", () => {
                                if (!socket.destroyed) socket.end();
                            });
                        } catch (writeErr: unknown) {
                            const writeError = writeErr as Error;
                            this.error(`IPC write error (IPC_PARSE_ERROR): ${writeError.message}`);
                            if (!socket.destroyed) socket.end();
                        }
                    }
                }
            });

            socket.on("error", (err) => {
                this.error(`IPC socket error: ${err.message}`);
                this.activeConnections.delete(socket);
                // No need to explicitly socket.end() or socket.destroy() here, 'close' will be emitted.
            });

            socket.on("close", () => {
                this.log("IPC client disconnected");
                this.activeConnections.delete(socket);
            });
        });

        this.ipcServer.on("error", (err) => {
            this.error(`IPC server error: ${err.message}`);
            // Potentially more robust error handling here, e.g., retry starting server
        });

        this.ipcServer.listen(this.socketPath, () => {
            this.log(`IPC server listening on ${this.socketPath}`);
            // Announce socket path for clients, only if not suppressed
            const shouldSuppressSocketPath = process.env.CHOPUP_SUPPRESS_SOCKET_PATH_LOG === 'true';
            if (!shouldSuppressSocketPath) {
                this.logToConsole(`CHOPUP_SOCKET_PATH=${this.socketPath}`);
            }
        });
    }

    public chopLog(isFinalChop = false): void {
        const chopTime = Date.now();
        const logsToWrite = [...this.logBuffer]; // Create a copy
        const lastChop = this.lastChopTime;
        this.logBuffer = [];
        this.lastChopTime = chopTime;

        if (logsToWrite.length === 0 && !isFinalChop) {
            return;
        }

        const commandForFile = sanitizeForFolder(this.command);
        const filenameSuffix = `${isFinalChop ? 'final_' : ''}log`;
        const filename = path.join(
            this.logDir,
            `${commandForFile}_${lastChop}_${chopTime}_${filenameSuffix}`,
        );

        const content = logsToWrite
            .map((entry) => `[${new Date(entry.timestamp).toISOString()}] [${entry.type}] ${entry.line}`)
            .join(""); // Lines already have newlines

        this.log(`Chopping logs to ${filename}. Lines: ${logsToWrite.length}`);

        fs.writeFile(filename, content)
            .then(() => {
                this.log(`Successfully wrote logs to ${filename}`);
            })
            .catch((err) => {
                this.error(`Error writing log file ${filename}: ${err}`);
            });
    }

    private recordOutput(data: Buffer | string, type: "stdout" | "stderr"): void {
        const lines = data.toString().split(/\r?\n/);
        const timestamp = Date.now();
        for (let i = 0; i < lines.length; i++) {
            if (i === lines.length - 1 && lines[i] === "") continue;
            this.logBuffer.push({
                timestamp,
                type,
                line: `${lines[i]}\n`, // Use template literal
            });
        }
    }

    private async performFinalCleanup(
        exitCode: number | null,
        signal: NodeJS.Signals | null,
    ): Promise<void> {
        this.log(
            `Performing final cleanup. Exit code: ${exitCode}, Signal: ${signal}`,
        );

        this.chopLog(true);

        this.log("Closing all active IPC connections...");
        for (const socket of this.activeConnections) {
            if (!socket.destroyed) {
                socket.end();
            }
        }
        this.activeConnections.clear();

        if (this.ipcServer) {
            this.log("Closing IPC server...");
            await new Promise<void>((resolve) => { // Removed reject from Promise
                this.ipcServer.close((err) => {
                    if (err) {
                        this.error(`Error closing IPC server: ${err.message}`);
                    } else {
                        this.log("IPC server closed.");
                    }
                    resolve();
                });
            });
        }

        await this.attemptSocketUnlink();

        if (this.childProcess?.pid) { // Use optional chaining for pid access
            const currentPid = this.childProcess.pid; // Store pid in case childProcess is nulled by another async op
            this.log(
                `Ensuring child process (PID: ${currentPid}) is terminated.`,
            );
            await new Promise<void>((resolve) => {
                treeKill(currentPid, "SIGKILL", (err: Error | undefined) => { // Added type for err
                    if (err) {
                        this.error(
                            `Error during treeKill of PID ${currentPid}: ${err.message}`,
                        );
                    } else {
                        this.log(
                            `Successfully tree-killed process tree for PID ${currentPid}.`,
                        );
                    }
                    resolve();
                });
            });
            this.childProcess = null;
        } else {
            this.log("No child process to terminate or PID was null.");
        }
        this.log("Final cleanup procedures finished.");
    }

    private async attemptSocketUnlink(): Promise<void> { // Changed to async
        if (this.socketPath && fsSync.existsSync(this.socketPath)) {
            // Check if exists first
            this.log(`Attempting to unlink socket file: ${this.socketPath}`);
            try {
                await fs.unlink(this.socketPath);
                this.log(`Socket file ${this.socketPath} unlinked successfully.`);
            } catch (err: unknown) {
                const unlinkError = err as Error; // Type assertion
                this.error(
                    `Error unlinking socket file ${this.socketPath}: ${unlinkError.message}`,
                );
            }
        } else {
            this.log(
                `Socket file ${this.socketPath} does not exist or path is null, no unlink needed.`,
            );
        }
    }

    private attemptSocketUnlinkOnExit(): void {
        // This is for the 'exit' event, which must be synchronous
        if (this.socketPath && fsSync.existsSync(this.socketPath)) {
            this.log(
                `Attempting to synchronously unlink socket file on exit: ${this.socketPath}`,
            );
            try {
                fsSync.unlinkSync(this.socketPath);
                this.log(
                    `Socket file ${this.socketPath} synchronously unlinked on exit.`,
                );
            } catch (err: unknown) {
                const unlinkError = err as Error;
                // Cannot use this.error reliably here as console streams might be closed.
                // Log to a file or use a more robust mechanism if this failure is critical.
                console.warn(
                    `[chopup_wrapper_SYNC_EXIT_CLEANUP] Error unlinking socket file ${this.socketPath} on exit: ${unlinkError.message}`,
                );
            }
        } else {
            // console.warn(`[chopup_wrapper_SYNC_EXIT_CLEANUP] Socket file ${this.socketPath} not found on exit.`);
        }
    }


    private async doCleanup(
        exitCode: number | null = null,
        signal: NodeJS.Signals | null = null,
    ): Promise<void> {
        if (this.cleanupInitiated) {
            this.log("Cleanup already in progress or completed. Skipping.");
            return;
        }
        this.cleanupInitiated = true; // Mark cleanup as started
        this.exitInProgress = true; // Also set this flag

        this.log(
            `doCleanup called. Exit code: ${exitCode}, Signal: ${signal}. Cleanup initiated: ${this.cleanupInitiated}`,
        );
        await this.performFinalCleanup(exitCode, signal);
        this.log("doCleanup finished.");
    }


    public async run(): Promise<void> {
        this.log(`Starting Chopup for command: ${this.command} ${this.args.join(" ")}`);
        this.initializeSignalHandlers();
        this.setupIpcServer();

        // Make sure logDir exists
        try {
            await fs.mkdir(this.logDir, { recursive: true });
            this.log(`Log directory ensured: ${this.logDir}`);
        } catch (error: unknown) { // Specify type for error
            const mkdirError = error as Error; // Type assertion
            this.error(`Failed to create log directory ${this.logDir}: ${mkdirError.message}`);
            // Decide if this is fatal. For now, we assume it is.
            process.exit(1);
        }

        this.childProcess = this.spawnFn(this.command, this.args, {
            stdio: ["pipe", "pipe", "pipe"], // pipe for stdin, stdout, stderr
            // detached: true, // Detaching might complicate tree-kill and signal propagation
        });
        this.log(
            `Spawned child process with PID: ${this.childProcess.pid}. Command: ${this.command}`,
        );

        // Log initial chop to capture anything before first explicit request
        // this.chopLog(); // Maybe not, let first request handle it or a timer

        this.childProcess.stdout?.on("data", (data) => { // Optional chaining for stdout
            this.recordOutput(data, "stdout");
        });

        this.childProcess.stderr?.on("data", (data) => { // Optional chaining for stderr
            this.recordOutput(data, "stderr");
        });

        this.childProcess.on("error", async (err) => {
            this.error(`Child process error: ${err.message}. For command: ${this.command}`);
            this.exitInProgress = true; // Mark that we are exiting
            await this.doCleanup(1, null); // Treat as exit code 1, no specific signal
            process.exit(1); // Exit wrapper if child process fails to spawn
        });

        this.childProcess.on("exit", async (code, signal) => {
            this.log(
                `Child process exited. Code: ${code}, Signal: ${signal}. PID: ${this.childProcess?.pid}`,
            );
            this.exitInProgress = true; // Mark that we are exiting
            // Ensure cleanup runs, then exit the wrapper with the child's code/signal
            await this.doCleanup(code, signal);
            if (signal) {
                // If process was killed by a signal, exit with a code that reflects that.
                // Common practice: 128 + signal number.
                // For simplicity, if there's a signal, we use a generic code or re-signal self.
                // Here, we let the signal handlers (SIGINT/SIGTERM on wrapper) or a default exit handle it.
                // process.kill(process.pid, signal); // This would re-signal the wrapper.
                // Or exit with a code like 1 to indicate an issue if signal isn't SIGINT/SIGTERM.
                // If it was SIGINT/SIGTERM on child, our wrapper might have already caught its own.
                this.log(`Exiting due to child signal: ${signal}. Wrapper will use its own exit logic if applicable or default.`);
                // process.exit(code !== null ? code : 1); // Fallback exit code if signal doesn't map well
            } else {
                // process.exit(code !== null ? code : 0); // Exit with child's code or 0 if null
            }
            // The process.on('exit') for the wrapper will handle final sync cleanup.
            // The signal handlers (SIGINT, SIGTERM) on the wrapper call process.exit with specific codes.
            // If child exits cleanly (code 0 or other codes), the wrapper should reflect that.
            // If code is null and signal is null, it implies an unusual exit.
            const exitCodeToUse = code !== null ? code : (signal ? 128 + (os.constants.signals[signal] || 0) : 1);
            this.log(`Wrapper process will now exit with code: ${exitCodeToUse}`);
            process.exit(exitCodeToUse);
        });

        // Initial log message indicating the wrapper is running and has spawned the child.
        this.logToConsole(
            `Wrapping command: ${this.command} ${this.args.join(" ")}`,
        );
        this.logToConsole(`Child process PID: ${this.childProcess.pid}`);
        // Socket path is logged by setupIpcServer
    }

    public getSocketPath(): string { // Added public getter
        return this.socketPath;
    }
}

// Helper function needs to be defined or imported if used standalone
function sanitizeForFolder(name: string): string {
    return name
        .replace(/[^a-zA-Z0-9_-]+/g, "_") // Allow underscore, hyphen
        .replace(/^_+|_+$/g, "")
        .slice(0, 40);
} 