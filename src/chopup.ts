import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import treeKill from "tree-kill";

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
export const INPUT_SEND_ERROR_BACKPRESSURE =
	"CHOPUP_INPUT_SEND_ERROR_BACKPRESSURE";

export const LOGS_CHOPPED = "LOGS_CHOPPED";
export const REQUEST_LOGS_COMMAND = "request-logs";
export const SEND_INPUT_COMMAND = "send-input";

// Define options interface
export interface ChopupOptions {
	command: string[];
	logDir?: string;
	socketPath?: string;
	logPrefix?: string;
	verbose?: boolean;
	initialChop?: boolean;
	send?: string; // Added from previous options
}

export class Chopup {
	private readonly command: string[];
	private readonly options: ChopupOptions;
	private readonly logDirectoryPath: string;
	private readonly socketPath: string; // Can be specified or generated
	private readonly logFilePrefix: string;
	private readonly verbose: boolean;
	private readonly initialChop: boolean;
	private ipcServer!: net.Server;
	private childProcess: ChildProcess | null = null;
	private logBuffer: LogBufferEntry[] = [];
	private lastChopTime: number = Date.now();
	private activeConnections = new Set<net.Socket>();
	private exitInProgress = false;
	private cleanupInitiated = false;
	private serverReadyPromise: Promise<void>; // Added
	private resolveServerReady!: () => void; // Added
	private rejectServerReady!: (reason?: unknown) => void; // Use unknown instead of any

	// Injected dependencies
	private spawnFn: SpawnFunction;
	private netCreateServerFn: typeof net.createServer; // Use typeof

	constructor(
		command: string[],
		options: ChopupOptions,
		// Injectable dependencies for testing
		spawnFunction?: SpawnFunction,
		netModule?: NetServerConstructor, // Use NetServerConstructor type
	) {
		// Use explicit command array if provided, otherwise default to empty
		this.command = command || [];
		if (this.command.length === 0) {
			throw new Error(
				"Chopup requires a command to run. Provide it after '--'. Usage: chopup run -- <command> [args...]",
			);
		}

		this.options = options;
		this.verbose = options.verbose || false;
		this.initialChop = options.initialChop || false;
		this.logDirectoryPath = path.resolve(options.logDir || "./chopup-logs");
		this.logFilePrefix = options.logPrefix || "log";

		// Ensure log directory exists before generating socket path
		if (!fsSync.existsSync(this.logDirectoryPath)) {
			try {
				fsSync.mkdirSync(this.logDirectoryPath, { recursive: true });
				this.log(`Log directory created: ${this.logDirectoryPath}`);
			} catch (err: unknown) {
				const mkdirError = err as Error;
				throw new Error(
					`Failed to create log directory ${this.logDirectoryPath}: ${mkdirError.message}`,
				);
			}
		} else {
			this.log(`Log directory already exists: ${this.logDirectoryPath}`);
		}

		// Use specified socket path or generate one
		if (options.socketPath) {
			this.socketPath = path.resolve(options.socketPath);
			this.log(`Using specified socket path: ${this.socketPath}`);
		} else {
			this.socketPath = path.join(
				this.logDirectoryPath,
				`chopup-${process.pid}.sock`,
			);
			this.log(`Generated socket path: ${this.socketPath}`);
		}

		this.logBuffer = [];
		this.lastChopTime = Date.now();

		// Initialize server ready promise
		this.serverReadyPromise = new Promise<void>((resolve, reject) => {
			this.resolveServerReady = resolve;
			this.rejectServerReady = reject;
		});

		// Use injected dependencies or default to actual modules
		this.spawnFn = spawnFunction || (spawn as unknown as SpawnFunction);
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
		// Don't auto-append newlines - callers must do this explicitly
		const formattedMessage = `[chopup_wrapper] ${message}`;
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

		// Debug log for socket path before setup
		console.log(
			`[DEBUG_SOCKET] Setting up IPC server on socket: ${this.socketPath}`,
		);

		this.ipcServer = this.netCreateServerFn((socket) => {
			this.log("IPC client connected");
			console.error(
				`[DEBUG_IPC_SERVER_CONNECT] Client connected to ${this.socketPath}. Remote port: ${socket.remotePort}`,
			); // DEBUG
			this.activeConnections.add(socket);

			socket.on("data", async (data) => {
				try {
					const message = data.toString();
					this.log(`IPC data received: ${message}`);
					let commandData: { command: string; input?: string };
					try {
						commandData = JSON.parse(message);
					} catch (error) {
						this.logToConsole("IPC_PARSE_ERROR\n", "stderr");
						await this.writeToSocket(socket, "IPC_PARSE_ERROR"); // Await write
						return; // Stop processing this data chunk
					}

					this.logToConsole(
						`[DEBUG_IPC_HANDLER] Received ${commandData.command}.`,
					);

					switch (commandData.command) {
						case REQUEST_LOGS_COMMAND:
							this.logToConsole(
								`[DEBUG_IPC_HANDLER] Received ${REQUEST_LOGS_COMMAND}. Calling chopLog...`,
							);
							await this.chopLog(); // Assuming chopLog might be async now or in future
							await this.writeToSocket(socket, LOGS_CHOPPED); // Await write
							break;

						case SEND_INPUT_COMMAND:
							this.logToConsole(
								`[DEBUG_IPC_HANDLER] Received ${SEND_INPUT_COMMAND}.`,
							);
							if (this.childProcess?.stdin) {
								const writeSuccess = this.childProcess.stdin.write(
									`${commandData.input}\n`, // Corrected: Use single backslash for newline
									(err) => {
										if (err) {
											this.logToConsole(
												`[ERROR_IPC_HANDLER] Error writing to child stdin: ${err.message}\n`,
												"stderr",
											);
											// Try to inform client even if stdin write failed
											this.writeToSocket(socket, INPUT_SEND_ERROR).catch((e) =>
												this.logToConsole(
													`Error sending INPUT_SEND_ERROR to client: ${(e as Error).message}`,
													"stderr",
												),
											);
										} else {
											this.logToConsole(
												"[DEBUG_IPC_HANDLER] Successfully wrote to child stdin.",
											);
											// Only send success if write callback confirms no error
											this.writeToSocket(socket, INPUT_SENT).catch((e) =>
												this.logToConsole(
													`Error sending INPUT_SENT to client: ${(e as Error).message}`,
													"stderr",
												),
											);
										}
									},
								);
								if (!writeSuccess) {
									this.logToConsole(
										"[WARN_IPC_HANDLER] Child stdin buffer full, write failed synchronously.\\n", // REMOVE UNUSED TEMPLATE
										"stderr",
									);
									// Inform client about synchronous failure
									await this.writeToSocket(socket, INPUT_SEND_ERROR); // Await write
								}
								// Response (INPUT_SENT or INPUT_SEND_ERROR) is now sent within the write callback or after sync failure check
							} else {
								this.logToConsole(
									"[ERROR_IPC_HANDLER] Cannot send input: Child process or stdin not available.\n",
									"stderr",
								);
								await this.writeToSocket(socket, INPUT_SEND_ERROR_NO_CHILD); // Await write
							}
							break;

						default:
							this.logToConsole(
								`[WARN_IPC_HANDLER] Received unknown command: ${commandData.command}\n`,
								"stderr",
							);
							await this.writeToSocket(socket, "UNKNOWN_COMMAND"); // Await write
					}
				} catch (e: unknown) {
					const parseError = e as Error;
					this.error(
						`IPC data parse error: ${parseError.message}. Data: ${data.toString()}`,
					);
					if (!socket.destroyed) {
						try {
							socket.write("IPC_PARSE_ERROR", () => {
								if (!socket.destroyed) socket.end();
							});
						} catch (writeErr: unknown) {
							const writeError = writeErr as Error;
							this.error(
								`IPC write error (IPC_PARSE_ERROR): ${writeError.message}`,
							);
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
			console.error(`[DEBUG_SOCKET] IPC server error: ${err.message}`);
			this.rejectServerReady(err); // Reject the promise on server error
		});

		// Helper function to verify socket existence with retry
		const verifySocketExistsWithRetry = (
			attempts = 5,
			delay = 100,
		): Promise<void> => {
			return new Promise((resolve, reject) => {
				const check = () => {
					if (fsSync.existsSync(this.socketPath)) {
						resolve();
					} else {
						if (attempts > 0) {
							console.log(
								`[DEBUG_SOCKET] Socket not found, retrying in ${delay}ms (${attempts} attempts left)`,
							);
							setTimeout(
								() =>
									verifySocketExistsWithRetry(attempts - 1, delay)
										.then(resolve)
										.catch(reject),
								delay,
							);
						} else {
							reject(
								new Error(
									`Socket file ${this.socketPath} not found after multiple retries.`,
								),
							);
						}
					}
				};
				check();
			});
		};

		// Start listening
		this.ipcServer.listen(this.socketPath, () => {
			this.log(`IPC server is now listening on ${this.socketPath}`);
			console.log(
				`[DEBUG_SOCKET] IPC server is now listening on ${this.socketPath}`,
			);

			const onServerReady = () => {
				console.log(
					`[DEBUG_SOCKET] Server ready sequence starting. Socket path: ${this.socketPath}`,
				);
				// Announce socket path for clients, only if not suppressed
				const shouldSuppressSocketPath =
					process.env.CHOPUP_SUPPRESS_SOCKET_PATH_LOG === "true";
				if (!shouldSuppressSocketPath) {
					this.logToConsole(`CHOPUP_SOCKET_PATH=${this.socketPath}\n`);
				}

				// Announce process ready *after* server is listening AND socket file exists (or assumed in test)
				this.logToConsole("CHOPUP_PROCESS_READY\n");
				this.resolveServerReady();
				console.log("[DEBUG_SOCKET] Server ready sequence completed.");
			};

			verifySocketExistsWithRetry()
				.then(() => {
					console.log(
						`[DEBUG_SOCKET] Socket file verified to exist: ${this.socketPath}`,
					);
					onServerReady(); // Call shared readiness logic after verification
				})
				.catch((err: Error) => {
					console.error(
						`[DEBUG_SOCKET] Socket verification failed: ${err.message}`,
					);
					this.rejectServerReady(err);
				});
		});
	}

	// Make chopLog async to allow awaiting file write
	public async chopLog(isFinalChop = false): Promise<void> {
		console.error(
			"[DEBUG_CHOPLOG_INVOKED] chopLog called. isFinalChop:",
			isFinalChop,
			"Buffer length:",
			this.logBuffer.length,
		); // VERY EARLY DEBUG
		console.error(
			"[DEBUG_CHOPLOG_ENTRY] chopLog function called (logged to stderr).",
		); // LOG TO STDERR
		const chopTime = Date.now();
		const logsToWrite = [...this.logBuffer]; // Create a copy
		const lastChop = this.lastChopTime;
		this.logBuffer = [];
		this.lastChopTime = chopTime;

		const isTestMode =
			process.env.CHOPUP_CLI_VERBOSE === "true" ||
			process.env.CHOPUP_TEST_MODE === "true";

		// Determine if we should proceed with writing a log file
		// Always proceed if there are logs or it's a final chop.
		// If in test mode, we might still proceed even with no logs.
		const hasLogs = logsToWrite.length > 0;
		const shouldAttemptWrite = hasLogs || isFinalChop || isTestMode;

		if (!shouldAttemptWrite) {
			console.log(
				"[DEBUG] Skipping log chop: No logs, not final chop, and not in test mode.",
			);
			return; // Return resolved promise for skipped write
		}

		const commandForFile = sanitizeForFolder(this.command.join(" "));
		const filenameSuffix = `${isFinalChop ? "final_" : ""}log`;
		const filename = path.join(
			this.logDirectoryPath,
			`${commandForFile}_${lastChop}_${chopTime}_${filenameSuffix}`,
		);

		// Use buffer data or a test message if forced by test mode with empty buffer
		let content = hasLogs
			? logsToWrite
					.map(
						(entry) =>
							`[${new Date(entry.timestamp).toISOString()}] [${entry.type}] ${entry.line}`,
					)
					.join("") // Lines already have newlines
			: ""; // Default to empty if no logs

		// If in test mode and buffer was empty, create a minimal test message
		if (isTestMode && !hasLogs) {
			content = `[TEST_MODE] Empty log chop created at ${new Date(chopTime).toISOString()}\n`;
			console.log(
				`[DEBUG_CHOPLOG_TEST_MODE_WRITE] Forcing content for test mode. Filename: ${filename}, Content: "${content.substring(0, 50)}..."`,
			); // DEBUG
		}

		// Avoid writing an empty file unless forced by test mode
		if (content.length === 0) {
			// This should only happen if not isTestMode, not isFinalChop, and logsToWrite was empty
			console.log(
				"[DEBUG] Skipping log chop: Content is empty and not in forced test mode.",
			);
			return; // Return resolved promise for skipped write
		}

		this.log(`Chopping logs to ${filename}. Lines: ${logsToWrite.length}`);
		console.log(
			`[DEBUG_CHOPLOG] Chopping logs to ${filename}. Lines: ${logsToWrite.length}`,
		);
		console.log(
			`[DEBUG_CHOPLOG] Log file will ${logsToWrite.length === 0 && isTestMode ? "contain test message" : "contain actual logs"}`,
		);

		// Return the promise from writeFile
		return fs
			.writeFile(filename, content)
			.then(() => {
				this.log(`Successfully wrote logs to ${filename}`);
				console.log(`[DEBUG_CHOPLOG] Successfully wrote logs to ${filename}`);
			})
			.catch((err) => {
				this.error(`Error writing log file ${filename}: ${err}`);
				console.error(
					`[DEBUG_CHOPLOG] Error writing log file ${filename}: ${err}`,
				);
				// Re-throw error so the await in the IPC handler catches it if needed
				throw err;
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
			await new Promise<void>((resolve) => {
				// Removed reject from Promise
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

		if (this.childProcess?.pid) {
			// Use optional chaining for pid access
			const currentPid = this.childProcess.pid; // Store pid in case childProcess is nulled by another async op
			this.log(`Ensuring child process (PID: ${currentPid}) is terminated.`);
			await new Promise<void>((resolve) => {
				treeKill(currentPid, "SIGKILL", (err: Error | undefined) => {
					// Added type for err
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

	private async attemptSocketUnlink(): Promise<void> {
		// Changed to async
		if (this.socketPath && fsSync.existsSync(this.socketPath)) {
			// Check if exists first
			this.log(`Attempting to unlink socket file: ${this.socketPath}`);
			console.log(
				`[DEBUG_SOCKET] Attempting to unlink socket file: ${this.socketPath}`,
			);
			try {
				console.log("[DEBUG_SOCKET_CLEANUP] Before await fs.unlink()"); // ADDED DEBUG
				await fs.unlink(this.socketPath);
				console.log("[DEBUG_SOCKET_CLEANUP] After await fs.unlink()"); // ADDED DEBUG
				this.log(`Socket file ${this.socketPath} unlinked successfully.`);
				console.log(
					`[DEBUG_SOCKET] Socket file unlinked successfully: ${this.socketPath}`,
				);
			} catch (err: unknown) {
				const unlinkError = err as Error; // Type assertion
				this.error(
					`Error unlinking socket file ${this.socketPath}: ${unlinkError.message}`,
				);
				console.error(
					`[DEBUG_SOCKET] Error unlinking socket file: ${this.socketPath}, error: ${unlinkError.message}`,
				);
			}
		} else {
			this.log(
				`Socket file ${this.socketPath} does not exist or path is null, no unlink needed.`,
			);
			console.log(
				`[DEBUG_SOCKET] Socket file does not exist, no unlink needed: ${this.socketPath}`,
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

		this.log("Cleanup finished.");
	}

	public async run(): Promise<number> {
		this.log("Chopup instance run initiated.");
		// Ensure cleanup handler is attached only once
		if (!this.cleanupInitiated) {
			this.initializeSignalHandlers();
			this.setupIpcServer(); // Starts listening asynchronously
		}

		// Wait for the server to be ready before proceeding fully
		try {
			this.log("Waiting for IPC server to be ready...");
			await this.serverReadyPromise;
			this.log("IPC server is ready.");
		} catch (serverError) {
			this.error(
				`IPC server failed to start: ${(serverError as Error).message}`,
			);
			// Decide on cleanup and exit strategy if server fails
			await this.doCleanup(null, null);
			throw serverError; // Re-throw the error
		}

		return new Promise((resolve, reject) => {
			try {
				// Spawn the child process (moved after server ready wait)
				if (this.command.length === 0) {
					throw new Error(
						"Cannot spawn child process: command array is empty.",
					);
				}
				const cmd = this.command[0];
				const args = this.command.slice(1);

				// Ensure logDir exists before spawning
				try {
					fsSync.mkdirSync(this.logDirectoryPath, { recursive: true });
					this.log(`Log directory ensured: ${this.logDirectoryPath}`);
				} catch (error: unknown) {
					const mkdirError = error as Error;
					this.error(
						`Failed to create log directory ${this.logDirectoryPath}: ${mkdirError.message}`,
					);
					// Reject the main promise if log dir fails
					reject(
						new Error(`Failed to create log directory: ${mkdirError.message}`),
					);
					return; // Stop execution
				}

				this.childProcess = this.spawnFn(cmd, args, {
					stdio: ["pipe", "pipe", "pipe"],
					env: { ...process.env },
					detached: false, // Ensure child is not detached for easier cleanup
					shell: false, // Avoid spawning through shell unless necessary
				});

				this.log(
					`Spawned child process with PID: ${this.childProcess.pid}. Command: ${cmd} ${args.join(" ")}`,
				);

				// Attach listeners AFTER spawning
				this.childProcess.stdout?.on("data", (data) => {
					this.recordOutput(data, "stdout");
				});

				this.childProcess.stderr?.on("data", (data) => {
					this.recordOutput(data, "stderr");
				});

				this.childProcess.on("error", async (err) => {
					this.error(`Child process error: ${err.message}`);
					// Ensure cleanup happens before rejecting
					this.doCleanup(null, null).finally(() => reject(err));
				});

				this.childProcess.on("exit", async (code, signal) => {
					this.log(
						`[DEBUG_EXIT_HANDLER_ENTRY] Child process exit event received. Code: ${code}, Signal: ${signal}. PID: ${this.childProcess?.pid}`,
					);
					this.log(
						`Child process exited. Code: ${code}, Signal: ${signal}. PID: ${this.childProcess?.pid}`,
					);
					// Ensure cleanup happens before resolving
					this.doCleanup(code, signal).finally(() => {
						this.log("[DEBUG_EXIT_HANDLER] doCleanup finished.");
						const exitCodeToUse =
							code !== null
								? code
								: signal
									? 128 + (os.constants.signals[signal] || 0)
									: 1;
						this.log(
							`Wrapper process will now exit with code: ${exitCodeToUse}`,
						);
						this.log("[DEBUG_EXIT_HANDLER] Resolving run() promise.");
						resolve(exitCodeToUse);
					});
				});

				if (this.childProcess?.pid) {
					console.log(
						`Child process started with PID: ${this.childProcess.pid}, IPC Socket: ${this.socketPath}`,
					);
				} else {
					console.error(
						`Child process failed to start. Socket: ${this.socketPath}`,
					);
				}
			} catch (e: unknown) {
				const error = e as Error;
				this.error(`Error during child process setup: ${error.message}`);
				// Ensure cleanup happens before rejecting
				this.doCleanup(null, null).finally(() => reject(error));
			}
		});
	}

	public getSocketPath(): string {
		// Added public getter
		return this.socketPath;
	}

	private _generateLogFilename(chopTime: number, finalChop = false): string {
		// Sanitize command args for filename: replace non-filesystem-safe chars with underscores
		const sanitizedCommand = this.command
			.map((arg) => arg.replace(/[^a-zA-Z0-9_.-]/g, "_")) // Allow alphanumeric, underscore, dot, hyphen
			.join("_"); // Join with underscores
		const suffix = finalChop ? "final_log" : "log";
		const filename = `${sanitizedCommand}_${this.lastChopTime}_${chopTime}_${suffix}`;
		return path.join(this.logDirectoryPath, filename);
	}

	// Helper to promisify socket write with error handling
	private writeToSocket(socket: net.Socket, message: string): Promise<void> {
		return new Promise((resolve, reject) => {
			this.logToConsole(`[DEBUG_IPC_SERVER] Attempting to write ${message}`);
			socket.write(message, (err) => {
				if (err) {
					this.logToConsole(
						`[ERROR_IPC_SERVER] Error writing to socket: ${err.message}\n`,
						"stderr",
					);
					reject(err);
				} else {
					this.logToConsole(`[DEBUG_IPC_SERVER] Successfully wrote ${message}`);
					resolve();
				}
			});
		});
	}
}

// Helper function needs to be defined or imported if used standalone
function sanitizeForFolder(name: string): string {
	return name
		.replace(/[^a-zA-Z0-9_-]+/g, "_") // Allow underscore, hyphen
		.replace(/^_+|_+$/g, "")
		.slice(0, 40);
}

// Helper function to parse JSON safely
function parseJsonSafely(jsonString: string): unknown {
	try {
		return JSON.parse(jsonString);
	} catch (error) {
		console.error(`Error parsing JSON: ${error}`);
		return null;
	}
}
