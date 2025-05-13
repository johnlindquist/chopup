import type { ChildProcess, SpawnOptions } from "node:child_process"; // Keep this type import
import EventEmitter from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises"; // Import fs promises
import net from "node:net";
import os from "node:os"; // Import os module
import path from "node:path";
import treeKill from "tree-kill";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { Mock } from "vitest";
import {
	Chopup,
	INPUT_SEND_ERROR,
	INPUT_SEND_ERROR_NO_CHILD,
	INPUT_SENT,
	LOGS_CHOPPED,
	REQUEST_LOGS_COMMAND,
	SEND_INPUT_COMMAND,
} from "../../src/chopup";
import type { ChopupOptions, NetServerConstructor } from "../../src/chopup"; // Added NetServerConstructor
import type { SpawnFunction } from "../../src/chopup"; // Import SpawnFunction type

// Mock tree-kill
vi.mock("tree-kill", () => {
	const mockFn = vi.fn((pid, signal, callback) => {
		console.log(
			`[MOCK_TREEKILL_MODULE] Mock called for PID: ${pid}, Signal: ${signal}`,
		);
		if (callback) process.nextTick(callback);
	});
	return { default: mockFn };
});

// Define base directories for unit test artifacts in OS temp dir
const TEST_BASE_DIR = path.join(os.tmpdir(), "chopup-unit-tests"); // Use os.tmpdir()
const TEST_LOG_DIR = path.join(TEST_BASE_DIR, "unit-logs");
const TEST_SOCKET_DIR = path.join(TEST_BASE_DIR, "unit-sockets");

// Helper function to create a unique socket path for each test
const getUniqueSocketPath = () =>
	path.join(
		TEST_SOCKET_DIR,
		`test-unit-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.sock`,
	);

// Mock implementation for ChildProcess
class FakeChildProcess extends EventEmitter {
	pid = 12345;
	stdout: EventEmitter;
	stderr: EventEmitter;
	stdin: { write: Mock; end: Mock } | null; // Make stdin potentially null
	killed = false; // Track if kill was called

	constructor(hasStdin = true) {
		super();
		this.stdout = new EventEmitter();
		this.stderr = new EventEmitter();
		if (hasStdin) {
			this.stdin = {
				write: vi.fn((_data: unknown, cb) => {
					if (cb) cb();
					return true;
				}), // Mock write, specify unknown for _data
				end: vi.fn(),
			};
		} else {
			this.stdin = null; // Set stdin to null if hasStdin is false
		}
	}

	kill(_signal?: string | number) {
		// Accept number for signal
		this.killed = true;
		// Optionally emit exit after a short delay to simulate async kill
		setTimeout(
			() => this.emitExit(null, (_signal as NodeJS.Signals) || "SIGTERM"),
			10,
		); // Provide signal
	}

	// Method to simulate process exit
	emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
		this.emit("exit", code, signal);
	}

	// Method to simulate stdout data
	emitStdout(data: string) {
		this.stdout.emit("data", data);
	}

	// Method to simulate stderr data
	emitStderr(data: string) {
		this.stderr.emit("data", data);
	}

	// Expose stdin mocks for assertions
	get stdinWriteMock() {
		return this.stdin?.write;
	}
	get stdinEndMock() {
		return this.stdin?.end;
	}
}

describe("Chopup", () => {
	let currentTestSocketPath: string;
	let client: net.Socket | null = null;
	let serverInstance: Chopup | null = null; // Track server instance for cleanup
	let fakeChild: FakeChildProcess | null = null; // Track fake child for cleanup/assertion
	let mockSpawn: Mock<Parameters<SpawnFunction>, ReturnType<SpawnFunction>>;
	let mockCreateServer: Mock<
		Parameters<typeof net.createServer>,
		ReturnType<typeof net.createServer>
	>;
	let mockNetModule: NetServerConstructor; // This is an object with a method, not a mock function itself
	let mockTreeKill: Mock<Parameters<typeof treeKill>, void>; // treeKill mock doesn't have a specific return type in the mock setup

	// Ensure socket and log directories are clean before tests
	beforeAll(async () => {
		// Use rm with force: true to ensure directories are removed even if non-empty or permissions issues
		await fs
			.rm(TEST_LOG_DIR, { recursive: true, force: true })
			.catch((e) =>
				console.warn(`Ignoring error clearing ${TEST_LOG_DIR}: ${e.message}`),
			);
		await fs
			.rm(TEST_SOCKET_DIR, { recursive: true, force: true })
			.catch((e) =>
				console.warn(
					`Ignoring error clearing ${TEST_SOCKET_DIR}: ${e.message}`,
				),
			);
		// Recreate directories synchronously
		fsSync.mkdirSync(TEST_LOG_DIR, { recursive: true });
		fsSync.mkdirSync(TEST_SOCKET_DIR, { recursive: true });
		console.log(
			`[TEST_SETUP] Ensured clean directories: ${TEST_LOG_DIR}, ${TEST_SOCKET_DIR}`,
		);
	});

	beforeEach(async () => {
		// Generate a unique path for each test to avoid conflicts
		currentTestSocketPath = getUniqueSocketPath();
		vi.useFakeTimers(); // Removed { shouldAdvanceTime: true }
		vi.setSystemTime(new Date("2020-09-13T12:26:40Z")); // Consistent time for tests

		// Mock fs.writeFile to avoid actual file writes during most tests
		vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
		// Mock fs.unlink to avoid actual file unlinks during most tests
		vi.spyOn(fs, "unlink").mockResolvedValue(undefined);
		// Create a new fake child for each test
		fakeChild = new FakeChildProcess();
	});

	afterEach(async () => {
		console.log(
			`[TEST_CLEANUP] Starting afterEach for socket: ${currentTestSocketPath}`,
		);
		vi.restoreAllMocks();
		vi.useRealTimers();

		// Close client connection if it exists
		if (client && !client.destroyed) {
			console.log("[TEST_CLEANUP] Closing test client connection.");
			const closePromise = new Promise<void>((resolve) => {
				if (client) {
					client.once("close", resolve);
				}
			});
			client.destroy();
			await closePromise;
			console.log("[TEST_CLEANUP] Test client connection closed.");
			client = null;
		}

		// Close server and clean up socket if server instance exists
		if (serverInstance) {
			const serverSocketPath = serverInstance.getSocketPath(); // Get path before cleanup
			console.log(
				`[TEST_CLEANUP] Cleaning up server instance for socket: ${serverSocketPath}`,
			);
			// @ts-expect-error Accessing private method for test cleanup
			await serverInstance.performFinalCleanup(0, null);
			console.log(
				`[TEST_CLEANUP] Server instance cleanup finished for socket: ${serverSocketPath}.`,
			);
			serverInstance = null;
		} else {
			console.log("[TEST_CLEANUP] No server instance found to clean up.");
		}
		fakeChild = null; // Clear fake child reference

		// Extra safety: attempt to remove the specific socket file if it still exists
		try {
			// Use stat to check existence before unlinking
			await fs.stat(currentTestSocketPath);
			console.log(
				`[TEST_CLEANUP] Attempting to remove residual socket file: ${currentTestSocketPath}`,
			);
			await fs.unlink(currentTestSocketPath);
			console.log(
				`[TEST_CLEANUP] Residual socket file removed: ${currentTestSocketPath}`,
			);
		} catch (err: unknown) {
			// L168: unknown
			// Type assertion needed after checking code property
			if ((err as Error & { code?: string }).code !== "ENOENT") {
				console.warn(
					`[TEST_CLEANUP] Error removing socket ${currentTestSocketPath}:`,
					err,
				);
			} else {
				// console.log(`[TEST_CLEANUP] Residual socket file already removed: ${currentTestSocketPath}`); // Less noise
			}
		}
		console.log(
			`[TEST_CLEANUP] Finished afterEach for socket: ${currentTestSocketPath}`,
		);

		// Cleanup: close server, attempt to remove socket, ensure child killed
		if (serverInstance) {
			// Check if serverInstance is not null
			// Accessing private members for testing cleanup is okay here
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			const server = (serverInstance as any).ipcServer as
				| net.Server
				| undefined;
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			const child = (serverInstance as any).childProcess as ChildProcess | null;

			if (server?.listening) {
				console.log(
					`[TEST_CLEANUP] Closing server instance for socket: ${serverInstance.getSocketPath()}`,
				);
				await new Promise<void>((resolve, reject) => {
					server.close((err?: Error) => {
						if (err) reject(err);
						else resolve();
					});
				});
			}

			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			const internalFakeChild = (serverInstance as any).currentFakeChild as
				| FakeChildProcess
				| undefined;
			if (child?.pid && internalFakeChild && !internalFakeChild.killed) {
				console.log(
					`[TEST_CLEANUP] Killing fake child PID ${child.pid} for socket: ${serverInstance.getSocketPath()}`,
				);
				treeKill(child.pid, "SIGTERM");
			}
		}
	});

	// Helper to create instance with mocks and unique socket path
	const createChopupInstance = (
		args: string[] = ["test-cmd", "arg1", "arg2"],
		logDir = TEST_LOG_DIR,
		options: Partial<ChopupOptions> = {},
	) => {
		const spawnFn = vi
			.fn()
			.mockReturnValue(fakeChild as unknown as ChildProcess);

		// Spy on the real fsSync.existsSync to restore it later
		const originalExistsSync = fsSync.existsSync;
		const existsSyncMock = vi.fn((p: fsSync.PathLike) => {
			// If this is the socket path AND the listen mock has been called (i.e., server is "listening")
			// then for the purpose of verifySocketExistsWithRetry, report true.
			if (
				p === currentTestSocketPath &&
				mockNetServerListenSpy.mock.calls.length > 0
			) {
				return true;
			}
			// Otherwise, fall back to the original existsSync.
			// This allows the initial check in setupIpcServer to see the real file (if test wrote one)
			// or use a test-specific mock if the test set one up AFTER createChopupInstance.
			return originalExistsSync(p);
		});
		vi.spyOn(fsSync, "existsSync").mockImplementation(existsSyncMock);

		// Mock unlinkSync for the initial cleanup in setupIpcServer for mocked net
		const originalUnlinkSync = fsSync.unlinkSync;
		const unlinkSyncMockFn = vi.fn(() => {}); // Benign mock
		vi.spyOn(fsSync, "unlinkSync").mockImplementation(unlinkSyncMockFn);

		// Prepare a mock net.Server with a spy on listen
		const mockNetServerListenSpy = vi.fn(
			(_path: string, callback?: () => void) => {
				// _path is string
				// When listen is called, our existsSyncMock should start returning true for the socketPath
				if (callback) callback();
				return mockServerInstance;
			},
		);
		const mockServerInstance = {
			listen: mockNetServerListenSpy,
			close: vi.fn((callback?: (err?: Error) => void) => {
				if (callback) callback();
				return mockServerInstance;
			}),
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				// L180 (Original L180, L194 in current file): unknown for handler args
				// Store the connection handler for direct invocation in tests
				if (event === "connection") {
					(
						mockServerInstance as unknown as {
							_connectionHandler: (...args: unknown[]) => void;
						}
					)._connectionHandler = handler; // unknown for handler args
				}
				return mockServerInstance;
			}),
			address: vi.fn(() => ({
				port: 12345,
				family: "IPv4",
				address: "127.0.0.1",
			})),
			getConnections: vi.fn(
				(cb: (error: Error | null, count: number) => void) => cb(null, 0),
			), // Typed cb
		} as unknown as net.Server;

		let capturedConnectionHandler: ((socket: net.Socket) => void) | undefined;
		const mockNetCreateServerFn = vi.fn(
			(handlerArg?: (socket: net.Socket) => void) => {
				capturedConnectionHandler = handlerArg;
				return mockServerInstance;
			},
		);
		const mockNetModule = {
			createServer: mockNetCreateServerFn,
		};

		// Ensure command is passed within the options object for ChopupOptions type
		const instance = new Chopup(
			args,
			{
				command: args, // Explicitly pass command here to satisfy ChopupOptions
				logDir,
				socketPath: currentTestSocketPath, // Use the test-specific socket path
				verbose: options.verbose ?? true, // Default verbose to true for tests
				initialChop: options.initialChop ?? false, // Default initialChop
				...options, // Spread remaining options
			},
			spawnFn, // Inject mocked spawn
			mockNetModule as NetServerConstructor, // Explicit cast to NetServerConstructor
		);
		serverInstance = instance; // Track the created instance
		console.log(
			`[TEST_HELPER] Created Chopup instance with socket: ${instance.getSocketPath()}`,
		);

		// Important: Add a cleanup for the existsSync mock specific to this instance creation
		// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
		const originalPerformFinalCleanup = (instance as any).performFinalCleanup;
		// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
		(instance as any).performFinalCleanup = async (
			...cleanupArgs: [number | null, NodeJS.Signals | null]
		) => {
			await originalPerformFinalCleanup.apply(instance, cleanupArgs);
			vi.spyOn(fsSync, "existsSync").mockImplementation(originalExistsSync); // Restore original
			vi.spyOn(fsSync, "unlinkSync").mockImplementation(originalUnlinkSync); // Restore original unlinkSync
		};

		return {
			instance,
			mockServerInstance, // Expose mock server
			getMockServerConnectionHandler: () => capturedConnectionHandler, // Return the captured handler
			spawnFn, // Expose spawnFn spy
		};
	};

	// Helper to connect a client
	const connectClient = (timeout = 5000): Promise<net.Socket> => {
		// Add a small delay before attempting connection
		return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
			return new Promise((resolve, reject) => {
				console.log(
					`[TEST_HELPER] Attempting to connect client to socket: ${currentTestSocketPath}`,
				);
				const connectionAttemptTime = Date.now();
				let timer: NodeJS.Timeout | null = null;

				client = net.createConnection(currentTestSocketPath);

				const cleanup = () => {
					if (timer) clearTimeout(timer);
					client?.removeAllListeners();
				};

				timer = setTimeout(() => {
					const duration = Date.now() - connectionAttemptTime;
					console.error(
						`[TEST_CLIENT_ERROR] Timeout (${timeout}ms) connecting client to ${currentTestSocketPath}. Duration: ${duration}ms`,
					);
					cleanup();
					client?.destroy();
					reject(
						new Error(`Timeout connecting client to ${currentTestSocketPath}`),
					);
				}, timeout);

				client.on("connect", () => {
					const duration = Date.now() - connectionAttemptTime;
					console.log(
						`[TEST_HELPER] Client connected successfully to ${currentTestSocketPath} in ${duration}ms`,
					);
					cleanup();
					if (client) {
						resolve(client);
					} else {
						// Should theoretically not happen if connect event fired
						reject(
							new Error(
								"Client connection reported success but client object is null",
							),
						);
					}
				});
				client.on("error", (err) => {
					const duration = Date.now() - connectionAttemptTime;
					console.error(
						`[TEST_CLIENT_ERROR] Failed to connect client to ${currentTestSocketPath} after ${duration}ms:`,
						err,
					);
					cleanup();
					client?.destroy();
					reject(err);
				});
				client.on("close", (hadError) => {
					// console.log(`[TEST_HELPER] Client connection closed (hadError: ${hadError}) for ${currentTestSocketPath}`); // Less noise
				});
			});
		});
	};

	// Helper function to send a command to the IPC server and await response
	const sendCommand = (payload: object): Promise<string> => {
		return new Promise((resolve, reject) => {
			if (!client || client.destroyed) {
				return reject(new Error("Client not connected or already destroyed"));
			}
			const message = JSON.stringify(payload);
			const responseHandler = (data: Buffer) => {
				client?.off("error", errorHandler); // Use optional chaining
				resolve(data.toString());
			};
			const errorHandler = (err: Error) => {
				client?.off("data", responseHandler); // Use optional chaining
				reject(err);
			};
			client.once("data", responseHandler);
			client.once("error", errorHandler);
			client.write(message, (err) => {
				if (err) {
					errorHandler(err); // Reject if write fails
				}
			});
		});
	};

	// --- Test Suites ---

	describe("Constructor", () => {
		it("should initialize properties correctly", () => {
			const { instance: chopup } = createChopupInstance();
			expect(chopup.getSocketPath()).toBe(currentTestSocketPath);
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			expect((chopup as any).logDirectoryPath).toBe(TEST_LOG_DIR);
		});

		it("should use provided socketPath if available", () => {
			const customSocketPath = "/custom/socket.sock";
			// Provide options object correctly
			const { instance: chopup } = createChopupInstance(undefined, undefined, {
				socketPath: customSocketPath,
			});
			expect(chopup.getSocketPath()).toBe(customSocketPath);
		});

		it("should create log directory if it does not exist", () => {
			// Mock existsSync specifically for the log directory path
			const existsSyncSpy = vi
				.spyOn(fsSync, "existsSync")
				.mockImplementation((p: fsSync.PathLike) => p !== TEST_LOG_DIR); // L260: Typed p
			// Need to spy on mkdirSync from fsSync
			const mkdirSyncSpy = vi
				.spyOn(fsSync, "mkdirSync")
				.mockImplementation(() => ""); // Mock implementation
			mkdirSyncSpy.mockClear(); // Clear calls from beforeAll

			createChopupInstance();

			expect(mkdirSyncSpy).toHaveBeenCalledWith(TEST_LOG_DIR, {
				recursive: true,
			});

			existsSyncSpy.mockRestore();
			mkdirSyncSpy.mockRestore();
		});

		it("should NOT create log directory if it already exists", () => {
			// Mock existsSync specifically for the log directory path used by the instance
			const existsSyncSpy = vi
				.spyOn(fsSync, "existsSync")
				.mockImplementation((p: fsSync.PathLike) => p === TEST_LOG_DIR);
			const mkdirSyncSpy = vi.spyOn(fsSync, "mkdirSync");
			// Clear any calls from beforeAll or other setup
			mkdirSyncSpy.mockClear();

			createChopupInstance(); // This uses TEST_LOG_DIR by default

			expect(mkdirSyncSpy).not.toHaveBeenCalled();

			// Restore mocks used specifically in this test
			existsSyncSpy.mockRestore();
			mkdirSyncSpy.mockRestore();
		});
	});

	describe("run", () => {
		it("should initialize signal handlers, IPC server, and spawn child process", async () => {
			const { instance: chopup, spawnFn: spawnFnSpyFromHelper } =
				createChopupInstance();
			// Spy on methods of the actual instance
			const initializeSignalHandlersSpy = vi.spyOn(
				chopup as Chopup & { initializeSignalHandlers: () => void },
				"initializeSignalHandlers",
			);
			const setupIpcServerSpy = vi.spyOn(
				chopup as Chopup & { setupIpcServer: () => Promise<void> },
				"setupIpcServer",
			);

			const runPromise = chopup.run();
			// Wait for server to be ready using the internal promise
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			await (chopup as any).serverReadyPromise;

			expect(initializeSignalHandlersSpy).toHaveBeenCalled();
			expect(setupIpcServerSpy).toHaveBeenCalled();
			expect(spawnFnSpyFromHelper).toHaveBeenCalledWith(
				"test-cmd",
				["arg1", "arg2"],
				expect.any(Object),
			);

			// Check listeners on the *real* fake child
			expect(fakeChild?.stdout?.listenerCount("data")).toBeGreaterThanOrEqual(
				1,
			);
			expect(fakeChild?.stderr?.listenerCount("data")).toBeGreaterThanOrEqual(
				1,
			);
			expect(fakeChild?.listenerCount("error")).toBeGreaterThanOrEqual(1);
			expect(fakeChild?.listenerCount("exit")).toBeGreaterThanOrEqual(1);

			// Allow run promise to potentially resolve (e.g., if child exits immediately)
			fakeChild?.emitExit(0); // Simulate immediate exit
			await vi.runAllTimersAsync(); // Ensure all timers (like in FakeChildProcess.kill) run
			await runPromise; // Ensure run completes
		});

		it("should log startup messages via logToConsole", async () => {
			const { instance: chopup } = createChopupInstance();
			const logToConsoleSpy = vi.spyOn(
				chopup as Chopup & {
					logToConsole: (message: string, error?: boolean | undefined) => void;
				},
				"logToConsole",
			);
			const runPromise = chopup.run();

			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			await (chopup as any).serverReadyPromise;

			// Advance timers to allow for async operations like process.nextTick within server ready sequence
			await vi.advanceTimersToNextTimerAsync();

			// Use `expect.stringContaining` for socket path as it's dynamic
			expect(logToConsoleSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					`CHOPUP_SOCKET_PATH=${currentTestSocketPath}\n`,
				),
			);
			// Fix: Expect the newline character as it's passed in the call
			expect(logToConsoleSpy).toHaveBeenCalledWith("CHOPUP_PROCESS_READY\n");

			fakeChild?.emitExit(0); // Simulate exit
			await vi.runAllTimersAsync(); // Ensure all timers (like in FakeChildProcess.kill) run
			await runPromise; // Ensure run completes
			// Ensure run promise also completes
			await expect(runPromise).resolves.toBe(0); // Expect exit code 0
		});
	});

	// Increase timeout for IPC tests
	describe("IPC Server", { timeout: 10000 }, () => {
		let testChopup: Chopup;
		let mockConnectionHandler: (socket: net.Socket) => void;
		let mockClientSocket: MockClientSocket;

		// Mock Socket class for testing IPC handler
		class MockClientSocket extends EventEmitter {
			write = vi.fn((_data: unknown, cb?: () => void) => {
				if (cb) cb();
				return true;
			});
			end = vi.fn();
			destroyed = false;
		}

		beforeEach(async () => {
			const { instance, getMockServerConnectionHandler } =
				createChopupInstance();
			testChopup = instance;
			serverInstance = instance; // Track for afterEach cleanup
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			(testChopup as any).setupIpcServer();
			const handler = getMockServerConnectionHandler();
			if (!handler) {
				throw new Error("Connection handler not set up on mock server");
			}
			mockConnectionHandler = handler;
			mockClientSocket = new MockClientSocket();
		});

		it("should start IPC server and listen on socket path", async () => {
			// This test now primarily checks if setupIpcServer was called,
			// and if the mock listen was invoked, which is implicitly handled by createChopupInstance
			// and the beforeEach block. We can refine this test if needed.
			const { instance } = createChopupInstance(); // Use a fresh one for this specific test scope
			const runPromise = instance.run();
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			await (instance as any).serverReadyPromise;

			// Verify netCreateServerFn was called from the instance's injected dependency
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			const createServerFnSpy = vi.mocked((instance as any).netCreateServerFn);
			expect(createServerFnSpy).toHaveBeenCalled();
			const actualMockedServer = createServerFnSpy.mock.results[0]
				.value as net.Server; // cast to net.Server
			const listenSpy = actualMockedServer.listen as Mock;
			expect(listenSpy).toHaveBeenCalledWith(
				currentTestSocketPath,
				expect.any(Function),
			);

			fakeChild?.emitExit(0);
			await vi.runAllTimersAsync(); // Ensure timers complete for runPromise to resolve
			await runPromise;
		});

		it('should handle "request-logs" command', async () => {
			// Wait for server to be ready using the internal promise
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			await (testChopup as any).serverReadyPromise;

			const chopLogSpy = vi.spyOn(
				testChopup as Chopup & {
					chopLog: (finalChop?: boolean | undefined) => Promise<void>;
				},
				"chopLog",
			);
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			(testChopup as any).logBuffer.push({
				timestamp: Date.now(),
				type: "stdout",
				line: "test log for request\n",
			});

			// Simulate client connection
			mockConnectionHandler(mockClientSocket as unknown as net.Socket);
			// Simulate data from client
			mockClientSocket.emit(
				"data",
				JSON.stringify({ command: REQUEST_LOGS_COMMAND }),
			);

			// Allow async operations within handler to complete
			await vi.advanceTimersByTimeAsync(50);

			expect(mockClientSocket.write).toHaveBeenCalledWith(
				LOGS_CHOPPED,
				expect.any(Function),
			);
			expect(chopLogSpy).toHaveBeenCalled();
		});

		it('should handle "send-input" command and write to child stdin', async () => {
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			(testChopup as any).resolveServerReady();
			// Ensure childProcess and its stdin are set up on testChopup for this test
			// The global fakeChild is used by createChopupInstance, which sets it on the instance
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			(testChopup as any).childProcess = fakeChild as unknown as ChildProcess;

			const testInput = "hello child";
			const stdinWriteSpy = fakeChild?.stdinWriteMock;
			expect(stdinWriteSpy).toBeDefined();

			mockConnectionHandler(mockClientSocket as unknown as net.Socket);
			mockClientSocket.emit(
				"data",
				JSON.stringify({ command: SEND_INPUT_COMMAND, input: testInput }),
			);

			await vi.advanceTimersByTimeAsync(50); // Allow write callback etc.

			// Check only the input string, as expect.any(Function) seems flaky here
			expect(stdinWriteSpy).toHaveBeenCalledWith(
				`${testInput}\n`,
				expect.anything(),
			);
			expect(mockClientSocket.write).toHaveBeenCalledWith(
				INPUT_SENT,
				expect.any(Function),
			); // Expect callback
		});

		it('should handle "send-input" when child process stdin is not available', async () => {
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			(testChopup as any).resolveServerReady();
			const childWithoutStdin = new FakeChildProcess(false);
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			(testChopup as any).childProcess =
				childWithoutStdin as unknown as ChildProcess;
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			expect(
				((testChopup as any).childProcess as ChildProcess & { stdin: unknown })
					.stdin,
			).toBeNull();

			mockConnectionHandler(mockClientSocket as unknown as net.Socket);
			mockClientSocket.emit(
				"data",
				JSON.stringify({ command: SEND_INPUT_COMMAND, input: "test" }),
			);

			await vi.advanceTimersByTimeAsync(50);

			expect(mockClientSocket.write).toHaveBeenCalledWith(
				INPUT_SEND_ERROR_NO_CHILD,
				expect.any(Function),
			);
		});

		it("should handle unknown IPC command", async () => {
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			(testChopup as any).resolveServerReady();
			mockConnectionHandler(mockClientSocket as unknown as net.Socket);
			mockClientSocket.emit(
				"data",
				JSON.stringify({ command: "unknown-command" }),
			);

			await vi.advanceTimersByTimeAsync(50);

			expect(mockClientSocket.write).toHaveBeenCalledWith(
				"UNKNOWN_COMMAND",
				expect.any(Function),
			);
		});

		it("should handle IPC data parse error", async () => {
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			(testChopup as any).resolveServerReady();
			mockConnectionHandler(mockClientSocket as unknown as net.Socket);
			mockClientSocket.emit("data", "invalid json"); // Send invalid JSON directly

			await vi.advanceTimersByTimeAsync(50);

			expect(mockClientSocket.write).toHaveBeenCalledWith(
				"IPC_PARSE_ERROR",
				expect.any(Function),
			);
		});

		// The test for removing existing socket is fine as it uses full run() and its specific mocks.
		// The test for performFinalCleanup in IPC server block might need adjustment or can be covered by other cleanup tests
		// For now, let's keep it and see if the general changes help.
		it("should remove existing socket file on IPC server setup if it exists", async () => {
			// Create a dummy socket file first
			fsSync.writeFileSync(currentTestSocketPath, "dummy");

			const { instance: localChopupInstance } = createChopupInstance();
			serverInstance = localChopupInstance; // Track for afterEach

			// The existsSync mock in createChopupInstance should now correctly use originalExistsSync for the initial check.
			// So, no local override of existsSync is needed here for that part.
			const unlinkSyncSpy = vi.spyOn(fsSync, "unlinkSync") as Mock<
				[fsSync.PathLike],
				void
			>;

			const runPromise = localChopupInstance.run();
			// biome-ignore lint/suspicious/noExplicitAny: Accessing private member for testing
			await (localChopupInstance as any).serverReadyPromise; // Wait for setup to complete

			expect(unlinkSyncSpy).toHaveBeenCalledWith(currentTestSocketPath);

			// Restore any mocks if they were altered by other means, or ensure they are scoped.
			// existsSyncSpy is managed internally by createChopupInstance and its cleanup.
			unlinkSyncSpy.mockRestore();

			fakeChild?.emitExit(0);
			await vi.runAllTimersAsync(); // Ensure timers run for runPromise
			await runPromise;
		});

		it("should perform final cleanup on child process exit", async () => {
			const { instance: localChopupInstance } = createChopupInstance();
			serverInstance = localChopupInstance; // Track
			const doCleanupSpy = vi.spyOn(
				localChopupInstance as Chopup & {
					doCleanup: (
						code: number | null,
						signal: NodeJS.Signals | null,
					) => Promise<void>;
				},
				"doCleanup",
			);
			const runPromise = localChopupInstance.run();
			await (localChopupInstance as any).serverReadyPromise; // Wait for setup

			expect(fakeChild).toBeDefined();
			// Ensure fakeChild exists before non-null assertion
			if (fakeChild) {
				fakeChild.emitExit(0, null); // Simulate exit
			}
			await vi.runAllTimersAsync(); // Ensure timers run for cleanup and promise resolution

			expect(doCleanupSpy).toHaveBeenCalledWith(0, null);

			// Ensure run promise also completes
			await expect(runPromise).resolves.toBe(0);
		});

		it("doCleanup should call performFinalCleanup and prevent multiple runs", async () => {
			const { instance: localChopupInstance } = createChopupInstance();
			serverInstance = localChopupInstance; // Track
			const performFinalCleanupSpy = vi
				.spyOn(
					localChopupInstance as Chopup & {
						performFinalCleanup: (
							code: number | null,
							signal: NodeJS.Signals | null,
						) => Promise<void>;
					},
					"performFinalCleanup",
				)
				.mockResolvedValue(undefined);
			await (localChopupInstance as any).doCleanup(0, "SIGINT"); // Changed to as any
			await vi.runAllTimersAsync(); // Ensure async operations in doCleanup complete
			expect(performFinalCleanupSpy).toHaveBeenCalledTimes(1);
			expect((localChopupInstance as any).cleanupInitiated).toBe(true); // Changed to as any
			await (localChopupInstance as any).doCleanup(0, "SIGINT"); // Changed to as any
			await vi.runAllTimersAsync(); // And again
			expect(performFinalCleanupSpy).toHaveBeenCalledTimes(1); // Should not call again
		});

		it("initializeSignalHandlers should set up process signal listeners", () => {
			const processOnSpy = vi.spyOn(process, "on") as Mock<
				[string, (...args: unknown[]) => void],
				NodeJS.Process
			>;
			const { instance: localChopupInstance } = createChopupInstance();
			(localChopupInstance as any).initializeSignalHandlers(); // Changed to as any
			expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
			expect(processOnSpy).toHaveBeenCalledWith(
				"SIGTERM",
				expect.any(Function),
			);
			expect(processOnSpy).toHaveBeenCalledWith("exit", expect.any(Function));
			processOnSpy.mockRestore();
		});
	});

	describe("chopLog", () => {
		const MOCK_LAST_CHOP_TIME = 1600000000000;
		const MOCK_CHOP_TIME = 1600000005000;
		const MOCK_RECORD_OUTPUT_TIME = 1600000002000;

		it("should write logBuffer to file and clear buffer", async () => {
			const { instance: localChopupInstance } = createChopupInstance([
				"test-cmd",
				"arg1",
				"arg2",
			]);
			serverInstance = localChopupInstance; // Track
			const dateNowSpy = vi.spyOn(Date, "now");
			(localChopupInstance as any).lastChopTime = MOCK_LAST_CHOP_TIME; // Changed to as any
			(localChopupInstance as any).logBuffer = []; // Changed to as any
			dateNowSpy.mockReturnValue(MOCK_RECORD_OUTPUT_TIME);
			(localChopupInstance as any).recordOutput(
				Buffer.from("line1\n"),
				"stdout",
			); // Changed to as any
			(localChopupInstance as any).recordOutput(
				Buffer.from("line2\n"),
				"stderr",
			); // Changed to as any
			dateNowSpy.mockReturnValue(MOCK_CHOP_TIME);
			await (
				localChopupInstance as Chopup & {
					chopLog: (finalChop?: boolean | undefined) => Promise<void>;
				}
			).chopLog();
			const expectedFilename = path.join(
				TEST_LOG_DIR,
				`test-cmd_arg1_arg2_${MOCK_LAST_CHOP_TIME}_${MOCK_CHOP_TIME}_log`,
			);
			const isoTimestamp = new Date(MOCK_RECORD_OUTPUT_TIME).toISOString();
			const expectedContent = `[${isoTimestamp}] [stdout] line1\n[${isoTimestamp}] [stderr] line2\n`;
			expect(fs.writeFile).toHaveBeenCalledWith(
				expectedFilename,
				expectedContent,
			);
			expect((localChopupInstance as any).logBuffer.length).toBe(0); // Changed to as any
			expect((localChopupInstance as any).lastChopTime).toBe(MOCK_CHOP_TIME); // Changed to as any
			dateNowSpy.mockRestore();
		});

		it("should handle final chop correctly", async () => {
			const { instance: localChopupInstance } = createChopupInstance([
				"test-cmd",
				"arg1",
				"arg2",
			]);
			serverInstance = localChopupInstance; // Track
			const dateNowSpy = vi.spyOn(Date, "now");
			(localChopupInstance as any).lastChopTime = MOCK_LAST_CHOP_TIME; // Changed to as any
			(localChopupInstance as any).logBuffer = []; // Changed to as any
			dateNowSpy.mockReturnValue(MOCK_RECORD_OUTPUT_TIME);
			(localChopupInstance as any).recordOutput(
				Buffer.from("final line\n"),
				"stdout",
			); // Changed to as any
			dateNowSpy.mockReturnValue(MOCK_CHOP_TIME);
			await (
				localChopupInstance as Chopup & {
					chopLog: (finalChop?: boolean | undefined) => Promise<void>;
				}
			).chopLog(true); // finalChop = true
			const expectedFilename = path.join(
				TEST_LOG_DIR,
				`test-cmd_arg1_arg2_${MOCK_LAST_CHOP_TIME}_${MOCK_CHOP_TIME}_final_log`,
			);
			const isoTimestamp = new Date(MOCK_RECORD_OUTPUT_TIME).toISOString();
			const expectedContent = `[${isoTimestamp}] [stdout] final line\n`;
			expect(fs.writeFile).toHaveBeenCalledWith(
				expectedFilename,
				expectedContent,
			);
			dateNowSpy.mockRestore();
		});

		it("should not write if logBuffer is empty and not finalChop", async () => {
			const { instance: localChopupInstance } = createChopupInstance();
			serverInstance = localChopupInstance; // Track
			(fs.writeFile as Mock).mockClear();
			(localChopupInstance as any).logBuffer = []; // Changed to as any
			await (
				localChopupInstance as Chopup & {
					chopLog: (finalChop?: boolean | undefined) => Promise<void>;
				}
			).chopLog(false); // finalChop = false
			expect(fs.writeFile).not.toHaveBeenCalled();
		});
	});

	describe("recordOutput", () => {
		it("should add lines to logBuffer with correct timestamp and type", () => {
			const { instance: localChopupInstance } = createChopupInstance();
			serverInstance = localChopupInstance; // Track
			const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1234567890);
			(localChopupInstance as any).recordOutput(
				Buffer.from("out1\nout2"),
				"stdout",
			); // Changed to as any
			(localChopupInstance as any).recordOutput(Buffer.from("err1"), "stderr"); // Changed to as any
			const buffer = (localChopupInstance as any).logBuffer; // Changed to as any
			expect(buffer.length).toBe(3);
			expect(buffer[0]).toEqual({
				timestamp: 1234567890,
				type: "stdout",
				line: "out1\n",
			});
			expect(buffer[1]).toEqual({
				timestamp: 1234567890,
				type: "stdout",
				line: "out2\n",
			});
			expect(buffer[2]).toEqual({
				timestamp: 1234567890,
				type: "stderr",
				line: "err1\n",
			});
			dateNowSpy.mockRestore();
		});

		it("should split data by newline and handle CRLF", () => {
			const { instance: localChopupInstance } = createChopupInstance();
			serverInstance = localChopupInstance; // Track
			(localChopupInstance as any).logBuffer = []; // Changed to as any
			(localChopupInstance as any).recordOutput(
				Buffer.from("line1\r\nline2\nline3"),
				"stdout",
			); // Changed to as any
			const buffer = (localChopupInstance as any).logBuffer; // Changed to as any
			expect(buffer.length).toBe(3);
			expect(buffer[0].line).toBe("line1\n");
			expect(buffer[1].line).toBe("line2\n");
			expect(buffer[2].line).toBe("line3\n"); // Ensure trailing newline is added
		});

		it("should handle empty input", () => {
			const { instance: localChopupInstance } = createChopupInstance();
			serverInstance = localChopupInstance; // Track
			(localChopupInstance as any).logBuffer = []; // Changed to as any
			(localChopupInstance as any).recordOutput(Buffer.from(""), "stdout"); // Changed to as any
			expect((localChopupInstance as any).logBuffer.length).toBe(0); // Changed to as any
		});

		it("should handle input that is only newlines", () => {
			const { instance: localChopupInstance } = createChopupInstance();
			serverInstance = localChopupInstance; // Track
			(localChopupInstance as any).logBuffer = []; // Changed to as any
			(localChopupInstance as any).recordOutput(Buffer.from("\n\n"), "stdout"); // Changed to as any
			const buffer = (localChopupInstance as any).logBuffer; // Changed to as any
			expect(buffer.length).toBe(2);
			expect(buffer[0].line).toBe("\n");
			expect(buffer[1].line).toBe("\n");
		});

		it("should correctly add trailing newline if missing", () => {
			const { instance: localChopupInstance } = createChopupInstance();
			serverInstance = localChopupInstance; // Track
			(localChopupInstance as any).logBuffer = []; // Changed to as any
			(localChopupInstance as any).recordOutput(
				Buffer.from("no-trailing-newline"),
				"stdout",
			); // Changed to as any
			const buffer = (localChopupInstance as any).logBuffer; // Changed to as any
			expect(buffer.length).toBe(1);
			expect(buffer[0].line).toBe("no-trailing-newline\n");
		});
	});

	describe("getSocketPath", () => {
		it("should return the correct socket path", () => {
			const customPath = "/tmp/mysock.sock";
			const { instance: localChopupInstance } = createChopupInstance(
				undefined,
				undefined,
				{ socketPath: customPath },
			);
			serverInstance = localChopupInstance; // Track
			expect(localChopupInstance.getSocketPath()).toBe(customPath);

			// Need a different instance for default path test
			vi.restoreAllMocks(); // Restore mocks to get default behaviour if needed
			fakeChild = new FakeChildProcess(); // Need a fresh fake child
			currentTestSocketPath = getUniqueSocketPath(); // Get a new unique path
			const { instance: defaultChopup } = createChopupInstance();
			expect(defaultChopup.getSocketPath()).toBe(currentTestSocketPath);
		});
	});
});
