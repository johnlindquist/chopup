import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";

// Type Definitions
export type ConnectionListener = (socket: IMockSocket) => void;
export type MockServerMap = Map<string, IMockServer>; // path -> server

// Global state for mock IPC
const mockServers: MockServerMap = new Map();
let nextSocketId = 0;

export function resetMockIpc(): void {
	for (const server of mockServers.values()) {
		server.close(); // Ensure servers are closed
	}
	mockServers.clear();
	nextSocketId = 0;
}

// Helper function to simulate async operations
const tick = () => new Promise((resolve) => process.nextTick(resolve));

export class MockDuplex extends Duplex {
	private _otherSide: MockDuplex | null = null;
	private _buffer: Buffer[] = [];
	private _isReading: boolean;
	_connected: boolean;

	constructor(options?: import("stream").DuplexOptions) {
		super(options);
		this._isReading = false;
		this._connected = false;
	}

	_read(size: number) {
		/* no-op */
	}

	_write(
		chunk: any,
		encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	) {
		this.emit("data", chunk); // Echo back
		if (this._otherSide?._connected) {
			this._otherSide._receiveData(chunk);
		} else {
			// Silently drop data if not connected or no other side? Or error?
			// For now, let's drop silently, similar to a closed socket
		}
		callback();
	}

	_final(callback: (error?: Error | null) => void): void {
		if (this._otherSide) {
			this._otherSide.push(null); // Signal EOF to the other side
		}
		callback();
	}

	_destroy(
		error: Error | null,
		callback: (error?: Error | null) => void,
	): void {
		this._connected = false;
		if (this._otherSide?._connected) {
			this._otherSide.destroy(error ?? undefined); // Propagate destroy
		}
		this._otherSide = null;
		this.emit("close", !!error); // Emit close event
		callback(error);
	}

	// Custom method to link two MockDuplex streams
	_link(other: MockDuplex): void {
		this._otherSide = other;
		other._otherSide = this; // Bidirectional link
		this._connected = true;
		other._connected = true;

		// Flush any buffered data now that they are linked
		this._flushBuffer();
		other._flushBuffer();
	}

	// Custom method to receive data from the linked stream
	_receiveData(chunk: Buffer): void {
		if (this._isReading) {
			if (!this.push(chunk)) {
				this._isReading = false;
			}
		} else {
			this._buffer.push(chunk);
		}
	}

	_flushBuffer(): void {
		if (this._isReading) {
			while (this._buffer.length > 0) {
				const chunk = this._buffer.shift();
				if (!this.push(chunk)) {
					this._isReading = false;
					break;
				}
			}
		}
	}

	// Mock properties
	isTTY?: boolean | undefined = false;
	bytesRead = 0;
	bytesWritten = 0;
	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	// @ts-ignore : This is a mock property
	remoteAddress?: string;
	remotePort?: number;
	// Required by IMockSocket - these are guesses for a Duplex stream acting as a socket mock
	get localPort(): number | undefined {
		return undefined;
	} // MockDuplex doesn't have an ID
	get localAddress(): string | undefined {
		return "127.0.0.1";
	}
	get remoteFamily(): string | undefined {
		return "IPv4";
	}

	end(callback?: () => void): this {
		super.end(callback);
		return this;
	}
	// ref() and unref() are often called but don't need to do anything in the mock
	ref() {
		return this;
	}
	unref() {
		return this;
	}
}

// Interface for Mock Socket matching net.Socket structure needed
export interface IMockSocket extends MockDuplex {
	id: number;
	path: string; // The path it tried to connect to
	// Add any other net.Socket methods/properties if Chopup uses them
}

// Interface for Mock Server matching net.Server structure needed
export interface IMockServer extends EventEmitter {
	listen: (path: string, callback?: () => void) => this;
	close: (callback?: (err?: Error) => void) => this;
	address: () =>
		| string
		| { port: number; family: string; address: string }
		| null;
	_listeningPath: string | null;
	_connections: Set<IMockSocket>;
	_connectionListener: ConnectionListener | null;
	// Internal method to simulate a connection
	_simulateConnection: (clientSocket: IMockSocket) => void;
}

export function createServer(
	connectionListener?: ConnectionListener,
): IMockServer {
	const server = new EventEmitter() as IMockServer;
	server._listeningPath = null;
	server._connections = new Set();
	server._connectionListener = connectionListener || null;

	server.listen = (path: string, callback?: () => void): IMockServer => {
		if (server._listeningPath) {
			throw new Error(`Server already listening on ${server._listeningPath}`);
		}
		if (mockServers.has(path)) {
			const error = new Error(`EADDRINUSE: address already in use ${path}`);
			(error as NodeJS.ErrnoException).code = "EADDRINUSE";
			// Defer emission to mimic async nature
			process.nextTick(() => server.emit("error", error));
			return server;
		}
		server._listeningPath = path;
		mockServers.set(path, server);
		// Defer emission to mimic async nature
		process.nextTick(() => {
			server.emit("listening");
			if (callback) callback();
		});
		return server;
	};

	server.close = (callback?: (err?: Error) => void): IMockServer => {
		if (server._listeningPath) {
			mockServers.delete(server._listeningPath);
			server._listeningPath = null;

			// Close all active connections gracefully
			const closePromises = Array.from(server._connections).map(
				(socket) =>
					new Promise<void>((resolve) => {
						if (!socket.destroyed) {
							socket.once("close", () => resolve());
							socket.end(); // Initiate graceful close
							socket.destroy(); // Force destroy if end doesn't close quickly
						} else {
							resolve();
						}
					}),
			);

			Promise.all(closePromises)
				.then(() => {
					process.nextTick(() => {
						// Defer close event
						server.emit("close");
						if (callback) callback();
					});
				})
				.catch((err) => {
					process.nextTick(() => {
						// Defer close event with error
						if (callback) callback(err);
						else server.emit("error", err); // Emit error if no callback
					});
				});
		} else {
			process.nextTick(() => {
				if (callback) callback();
			});
		}
		return server;
	};

	server.address = () => {
		if (server._listeningPath) {
			// Return path for pipe/socket, consistent with net.Server
			return server._listeningPath;
		}
		return null;
	};

	// Internal method for server to handle a new connection
	server._simulateConnection = (clientSocket: IMockSocket) => {
		const serverSocket = new MockDuplex() as IMockSocket;
		serverSocket.id = nextSocketId++;
		serverSocket.path = server._listeningPath as string; // Server side knows its path

		server._connections.add(serverSocket);

		serverSocket.once("close", () => {
			server._connections.delete(serverSocket);
		});

		// Link the client and server sockets
		clientSocket._link(serverSocket);

		// Emit connection on server *after* linking
		if (server._connectionListener) {
			try {
				server._connectionListener(serverSocket);
			} catch (error) {
				// Errors in user listener shouldn't crash the server, emit error
				process.nextTick(() => serverSocket.emit("error", error));
			}
		}
		server.emit("connection", serverSocket);

		// Emit 'connect' on the client side *after* server 'connection' logic ran
		// Use nextTick to ensure server listener setup is complete
		process.nextTick(() => {
			if (!clientSocket.destroyed) {
				// Check if client was destroyed before connect
				clientSocket.emit("connect");
			}
		});
	};

	return server;
}

export function createConnection(
	path: string,
	connectionListener?: () => void,
): IMockSocket {
	const clientSocket = new MockDuplex() as IMockSocket;
	clientSocket.id = nextSocketId++;
	clientSocket.path = path; // Store the path

	if (connectionListener) {
		clientSocket.once("connect", connectionListener);
	}

	// Simulate async connection attempt
	process.nextTick(() => {
		if (clientSocket.destroyed) return; // Don't proceed if destroyed before tick

		const server = mockServers.get(path);
		if (server?._listeningPath) {
			// Check server exists and is listening
			try {
				server._simulateConnection(clientSocket);
				// 'connect' is emitted by _simulateConnection after server setup
			} catch (e) {
				// Error during connection simulation
				const error =
					e instanceof Error ? e : new Error("Connection simulation failed");
				clientSocket.emit("error", error);
				clientSocket.destroy(error);
			}
		} else {
			// No server listening at this path
			const error = new Error(
				`connect ECONNREFUSED ${path}`,
			) as NodeJS.ErrnoException;
			error.code = "ECONNREFUSED";
			// error.address = path; // NodeJS.ErrnoException doesn't strictly have .address, though common in net errors
			(error as any).address = path; // Add for test compatibility if needed, acknowledge lint
			clientSocket.emit("error", error);
			clientSocket.destroy(error); // Ensure socket is destroyed on connection failure
		}
	});

	return clientSocket;
}
