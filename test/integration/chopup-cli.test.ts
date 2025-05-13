import { execSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import treeKill from "tree-kill"; // For cleanup
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";

const CHOPUP_DIST_PATH = path.resolve(__dirname, "../../dist/index.js");
const TMP_DIR_INTEGRATION = path.resolve(__dirname, "../../tmp/integration");
const SCRIPTS_DIR = path.join(__dirname, "input-tests/fixtures/scripts");
console.log(`[TEST CONFIG] CHOPUP_DIST_PATH: ${CHOPUP_DIST_PATH}`);
console.log(`[TEST CONFIG] TMP_DIR_INTEGRATION: ${TMP_DIR_INTEGRATION}`);
console.log(`[TEST CONFIG] SCRIPTS_DIR: ${SCRIPTS_DIR}`);

interface ChopupTestInstance {
	process: ChildProcessWithoutNullStreams;
	socketPath?: string;
	logDir: string;
	stdout: string[];
	stderr: string[];
	pid: number;
	kill: () => Promise<void>;
	cleanup: () => Promise<void>;
}

// Helper to spawn the chopup CLI
async function spawnChopup(
	args: string[],
	timeoutMs = 10000,
): Promise<ChopupTestInstance> {
	return new Promise((resolve, reject) => {
		const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
		const logDir = path.join(TMP_DIR_INTEGRATION, `logs-${uniqueId}`);
		// Generate a unique socket path for this instance
		const instanceSocketPath = path.join(
			TMP_DIR_INTEGRATION,
			`test-sock-${uniqueId}.sock`,
		);

		fsSync.mkdirSync(logDir, { recursive: true });
		// Also ensure parent dir for socket exists if it's in TMP_DIR_INTEGRATION directly
		fsSync.mkdirSync(path.dirname(instanceSocketPath), { recursive: true });

		// Pass the specific socket path along with other args
		// Options for 'run' must come BEFORE '--' and the command to wrap
		let finalArgs: string[];

		// Default to adding --verbose for tests that might expect echoed child output
		const baseChopupArgs = ["--verbose", "--log-dir", logDir, "--socket-path", instanceSocketPath];

		if (args[0] === "run") {
			const runCmd = args[0];
			const separatorIndex = args.indexOf("--");
			if (separatorIndex !== -1) {
				const commandToWrap = args.slice(separatorIndex); // Includes '--'
				const runArgsOnly = args.slice(1, separatorIndex);
				finalArgs = [
					...baseChopupArgs,
					runCmd,
					...runArgsOnly,
					...commandToWrap,
				];
			} else {
				// case: chopup run actual_cmd (no --)
				finalArgs = [
					...baseChopupArgs,
					runCmd,
					"--",
					...args.slice(1),
				];
			}
		} else if (args[0] === "request-logs" || args[0] === "send-input") {
			// Client commands: --socket is a command-specific option, not global to chopup binary
			// So baseChopupArgs (with global --socket-path for server) aren't prepended here.
			// However, if these client commands somehow need to be verbose themselves (unlikely for their own output), this would need adjustment.
			finalArgs = [...args]; // Pass args as is, they include their own --socket
		} else {
			// Passthrough case or other direct command. Assume global options apply.
			finalArgs = [
				...baseChopupArgs,
				...args, // This might be for the default action if no command is given
			];
		}

		console.log(
			`[TEST_SPAWN] Spawning with: node ${CHOPUP_DIST_PATH} ${finalArgs.join(" ")}`,
		); // DEBUG

		const proc = spawn("node", [CHOPUP_DIST_PATH, ...finalArgs], {
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				// CHOPUP_CLI_VERBOSE: "true", // Old, not used by src/index.ts's log() anymore
				CHOPUP_TEST_MODE: "true",   // Prevents instruction printing from Chopup class
			},
		});

		let socketPath: string | undefined;
		const stdoutData: string[] = [];
		const stderrData: string[] = [];
		let resolved = false;
		let socketPathFound = false;
		let processReadySignalReceived = false;

		const timer = setTimeout(() => {
			if (!resolved) {
				proc.kill();
				reject(
					new Error(
						`spawnChopup timed out after ${timeoutMs}ms for command: node ${CHOPUP_DIST_PATH} ${finalArgs.join(" ")}`,
					),
				);
			}
		}, timeoutMs);

		proc.stdout.on("data", (data) => {
			const line = data.toString();
			stdoutData.push(line);

			// Match socket path and aggressively strip any trailing newlines or whitespace
			// The socket path is now explicitly passed, but we still listen for CHOPUP_SOCKET_PATH for confirmation if needed.
			const socketMatch = line.match(/CHOPUP_SOCKET_PATH=([^\n\r]+)/);
			if (socketMatch?.[1]) {
				// Clean the socket path - remove all whitespace, newlines, CR, etc.
				const reportedSocketPath = socketMatch[1].trim();
				// socketPath = reportedSocketPath; // We use the explicitly passed one now
				console.log(
					`[TEST DEBUG] Reported socket path by instance: "${reportedSocketPath}" (using explicit: "${instanceSocketPath}")`,
				);
				if (reportedSocketPath.trim() === instanceSocketPath.trim()) {
					socketPathFound = true; // Confirmed instance is using the path we told it to
				}
			}

			// Check for ready signal
			if (line.includes("[chopup_wrapper] CHOPUP_PROCESS_READY")) {
				processReadySignalReceived = true;
				console.log("[TEST DEBUG] Process ready signal received");
			}

			// Resolve only when both signals are received
			if (socketPathFound && processReadySignalReceived && !resolved) {
				resolved = true;
				clearTimeout(timer); // Clear the main timeout

				// Verify socket exists immediately using the known instanceSocketPath
				if (fsSync.existsSync(instanceSocketPath)) {
					console.log(
						`[TEST DEBUG] Socket path verified to exist: ${instanceSocketPath}`,
					);
				} else {
					console.warn(
						`[TEST WARN] Explicit socket path ${instanceSocketPath} doesn\'t exist yet upon readiness signals!`,
					);
				}

				resolve({
					process: proc,
					socketPath: instanceSocketPath, // Use the explicitly passed and generated path
					logDir,
					stdout: stdoutData,
					stderr: stderrData,
					pid: proc.pid ?? -1,
					kill: () =>
						new Promise<void>((res, rej) => {
							if (proc.pid) {
								treeKill(proc.pid, (err) => (err ? rej(err) : res()));
							} else {
								res(); // Already dead
							}
						}),
					cleanup: async () => {
						if (proc && !proc.killed) {
							proc.kill(); // Send SIGTERM
							// Optionally wait a bit or check if it exited gracefully
							await new Promise((resolve) => setTimeout(resolve, 200)); // Wait briefly
							if (!proc.killed) {
								proc.kill("SIGKILL"); // Force kill if still running
							}
						}
						// Main process handles socket cleanup on exit
						// But we should clean up the log dir created by the test helper
						if (logDir && fsSync.existsSync(logDir)) {
							console.log(`[TEST_CLEANUP] Removing log dir: ${logDir}`);
							fsSync.rmSync(logDir, { recursive: true, force: true });
						}
					},
				});
			}
		});

		// Keep stderr listener simple for collecting data, not for resolving readiness
		proc.stderr.on("data", (data) => {
			stderrData.push(data.toString());
			// console.error(`Chopup stderr: ${data.toString()}`); // For debugging tests
		});

		proc.on("error", (err) => {
			if (!resolved) {
				clearTimeout(timer);
				resolved = true;
				reject(err);
			}
		});

		proc.on("exit", (code, signal) => {
			if (!resolved && instanceSocketPath) {
				// If exit happens quickly but after socket path was found
				resolved = true;
				clearTimeout(timer);
				resolve({
					process: proc,
					socketPath: instanceSocketPath, // Use explicit path
					logDir,
					stdout: stdoutData,
					stderr: stderrData,
					pid: proc.pid || -1, // PID might be null if already exited
					kill: () => Promise.resolve(), // Already exited
					cleanup: async () => {
						if (proc && !proc.killed) {
							proc.kill(); // Send SIGTERM
							// Optionally wait a bit or check if it exited gracefully
							await new Promise((resolve) => setTimeout(resolve, 200)); // Wait briefly
							if (!proc.killed) {
								proc.kill("SIGKILL"); // Force kill if still running
							}
						}
						// Main process handles socket cleanup on exit
						// But we should clean up the log dir created by the test helper
						if (logDir && fsSync.existsSync(logDir)) {
							console.log(`[TEST_CLEANUP] Removing log dir: ${logDir}`);
							fsSync.rmSync(logDir, { recursive: true, force: true });
						}
					},
				});
			} else if (!resolved) {
				clearTimeout(timer);
				resolved = true;
				reject(
					new Error(
						`Chopup process exited prematurely. Code: ${code}, Signal: ${signal}. Stderr: ${stderrData.join("")}`,
					),
				);
			}
		});
	});
}

// Helper to wait for socket file to exist
async function waitForSocket(
	socketPath: string,
	timeoutMs = 5000,
): Promise<void> {
	if (!socketPath) {
		throw new Error("Cannot wait for socket: socketPath is undefined");
	}

	const startTime = Date.now();
	console.log(`[TEST_DEBUG] Waiting for socket at path: ${socketPath}`);

	while (Date.now() - startTime < timeoutMs) {
		// Verify the socket still exists
		if (fsSync.existsSync(socketPath)) {
			console.log(`[TEST_DEBUG] Socket found: ${socketPath}`);
			return;
		}
		// Wait before checking again
		await new Promise((resolve) => setTimeout(resolve, 50)); // Poll every 50ms
	}

	// One last check before giving up
	if (fsSync.existsSync(socketPath)) {
		console.log(`[TEST_DEBUG] Socket found on final check: ${socketPath}`);
		return;
	}

	throw new Error(`Timed out waiting for socket file to exist: ${socketPath}`);
}

describe("Chopup CLI Integration Tests", () => {
	let runningInstances: ChopupTestInstance[] = [];

	beforeAll(async () => {
		await fs.mkdir(TMP_DIR_INTEGRATION, { recursive: true });
		// Compile chopup if dist doesn't exist or is outdated (simple check)
		if (!fsSync.existsSync(CHOPUP_DIST_PATH)) {
			console.log("dist/index.js not found, running pnpm build...");
			execSync("pnpm build", { stdio: "inherit" });
		}
	});

	afterAll(async () => {
		// await fs.rm(TMP_DIR_INTEGRATION, { recursive: true, force: true });
		// console.log("Cleaned up integration tmp dir. Comment out above line to inspect logs.");
	});

	afterEach(async () => {
		// Clean up any instances that might be running
		for (const instance of runningInstances) {
			await instance.kill();
		}
		runningInstances = [];
	});

	describe("run subcommand (default)", () => {
		it("should spawn a command, create a log directory, and start an IPC server", async () => {
			const instance = await spawnChopup(["run", "--", "echo", "hello world"]);
			runningInstances.push(instance);

			expect(instance.pid).toBeGreaterThan(0);
			expect(instance.socketPath).toBeDefined();
			expect(fsSync.existsSync(instance.logDir)).toBe(true);

			// Wait for the socket file to exist
			if (instance.socketPath) {
				await waitForSocket(instance.socketPath, 5000);
				expect(fsSync.existsSync(instance.socketPath)).toBe(true);
			}

			// Check for child process output eventually
			await new Promise((resolve) => setTimeout(resolve, 200)); // Give time for echo to run
			const stdoutCombined = instance.stdout.join("");
			expect(stdoutCombined).toContain("hello world");

			await instance.kill();
			// Socket should be cleaned up by chopup itself on exit
			if (instance.socketPath) {
				expect(fsSync.existsSync(instance.socketPath)).toBe(false);
			}
		}, 10000);
	});

	describe("request-logs CLI command", () => {
		it("should request logs from a running chopup instance and create a log chop file", async () => {
			const targetScript = path.join(SCRIPTS_DIR, "continuous-output.js");
			console.log(`[TEST SETUP] Using script at: ${targetScript}`);
			console.log(
				`[TEST SETUP] Verifying script exists: ${fsSync.existsSync(targetScript)}`,
			);

			const instance = await spawnChopup(["run", "--", "node", targetScript]);
			runningInstances.push(instance);

			// Wait for child to maybe produce some logs
			await new Promise((resolve) => setTimeout(resolve, 2000));

			const sockPath = instance.socketPath;
			if (!sockPath) throw new Error("Socket path not found after spawn");
			const logDir = instance.logDir;
			if (!logDir) throw new Error("Log directory not found after spawn");

			try {
				console.log(`[TEST_DEBUG] Waiting for socket at path: ${sockPath}`);
				await waitForSocket(sockPath); // Ensure socket exists before command
				console.log(`[TEST_DEBUG] Socket found: ${sockPath}`);

				console.log(`[TEST INFO] Verified socket exists: ${sockPath}`);
				console.log(
					`[TEST DEBUG] Log directory BEFORE request-logs: ${fsSync.readdirSync(logDir).join(", ") || "(empty)"}`,
				);

				// Execute request-logs command
				try {
					const output = execSync(
						`node ${CHOPUP_DIST_PATH} request-logs --socket ${sockPath}`,
						{
							timeout: 5000,
							encoding: "utf8",
						},
					);
					console.log(`[TEST INFO] Command output: ${output}`);
					expect(output.trim()).toContain("LOGS_CHOPPED");
				} catch (err: unknown) {
					console.error(
						`[TEST ERROR] Command execution failed: ${(err as Error).message}`,
					);
					if (err && typeof err === "object" && "stdout" in err) {
						console.log(
							`[TEST ERROR] Command stdout: ${(err as { stdout: Buffer | string }).stdout?.toString()}`,
						);
					}
					if (err && typeof err === "object" && "stderr" in err) {
						console.error(
							`[TEST ERROR] Command stderr: ${(err as { stderr: Buffer | string }).stderr?.toString()}`,
						);
					}
					throw err;
				}

				console.log(
					`[TEST DEBUG] Log directory immediately AFTER request-logs: ${fsSync.readdirSync(logDir).join(", ") || "(empty)"}`,
				);

				// --- BEGIN POLLING FOR LOG FILE ---
				const pollStartTime = Date.now();
				const pollTimeout = 3000; // Max wait 3 seconds
				let logFiles: string[] = [];

				while (Date.now() - pollStartTime < pollTimeout) {
					const filesInDir = fsSync.readdirSync(logDir);
					console.log(
						`[TEST POLLING] Files in ${logDir}: ${filesInDir.join(", ") || "(empty)"}`,
					); // Log all files
					logFiles = filesInDir.filter((f) => f.includes("_log"));
					if (logFiles.length > 0) {
						console.log(
							`[TEST DEBUG] Found log file(s) after ${Date.now() - pollStartTime}ms: ${logFiles.join(", ")}`,
						);
						break;
					}
					// Wait a short interval before checking again
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				// --- END POLLING FOR LOG FILE ---

				console.log(`[TEST DEBUG] Final check - Log directory: ${logDir}`);
				console.log(
					`[TEST DEBUG] Final check - Contents of log directory: ${fsSync.readdirSync(logDir).join(", ") || "(empty)"}`,
				);
				console.log(
					`[TEST DEBUG] Final check - Log files found (containing '_log'): ${logFiles.length}`,
				);

				expect(logFiles.length).toBeGreaterThan(0);
			} finally {
				// Ensure we clean up the instance at the end of the test
				await instance.kill();
			}
		}, 10000); // Test timeout
	});

	// Comment out other tests to run them one at a time
	/*
	describe('send-input CLI command', () => {
		it('should send input to the wrapped process via CLI', async () => {
			const targetScript = path.join(SCRIPTS_DIR, 'stdin-echo.js');

			// Run each test with a separate chopup instance
			const instance = await spawnChopup(['run', '--', 'node', targetScript]);
			runningInstances.push(instance);
		    
			const testInput = "hello from integration test";

			const sockPath = instance.socketPath;
			if (!sockPath) throw new Error("Socket path not found for send-input test");
		    
			try {
				// Wait for the socket file to exist before executing client command
				await waitForSocket(sockPath, 5000); // Increased timeout to 5 seconds
			    
				console.log(`[TEST INFO] Verified socket exists: ${sockPath}`);
			    
				// Add a retry mechanism for the execSync call
				let retries = 3;
				let success = false;
				let lastError;
			    
				while (retries > 0 && !success) {
					try {
						// Verify the socket exists before each attempt
						if (!fsSync.existsSync(sockPath)) {
							console.log(`[TEST WARNING] Socket file disappeared: ${sockPath}`);
							throw new Error(`Socket file disappeared: ${sockPath}`);
						}
					    
						// Run client command directly on socket path
						console.log(`[TEST INFO] Running send-input command on socket: ${sockPath}`);
						execSync(`node ${CHOPUP_DIST_PATH} send-input --socket ${sockPath} --input "${testInput}"`);
						success = true;
					} catch (err) {
						console.log(`[TEST RETRY] Send-input failed, retrying... (${retries} left)`);
						lastError = err;
						retries--;
						await new Promise(resolve => setTimeout(resolve, 500)); // Wait before retry
					}
				}
			    
				if (!success) {
					throw lastError;
				}

				await new Promise(resolve => setTimeout(resolve, 1000)); // Give time for input to be processed and echoed

				const stdoutCombined = instance.stdout.join('');
				expect(stdoutCombined).toContain(`ECHOED: ${testInput}`);
			} finally {
				// Ensure we clean up the instance at the end of the test
				await instance.kill();
				const instanceIndex = runningInstances.indexOf(instance);
				if (instanceIndex >= 0) {
					runningInstances.splice(instanceIndex, 1);
				}
			}
		}, 15000);
	});
	*/
});
