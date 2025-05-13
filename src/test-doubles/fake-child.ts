import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream"; // Explicit types

// Interface defining the structure we need for testing
export interface ChildProcessLike extends EventEmitter {
	stdin: Writable | null;
	stdout: Readable | null;
	stderr: Readable | null;
	pid?: number;
	connected?: boolean;
	killed?: boolean; // Added killed property
	exitCode?: number | null; // Added exitCode
	signalCode?: NodeJS.Signals | null; // Added signalCode
	kill: (signal?: NodeJS.Signals | number) => boolean;
	disconnect?: () => void;
	// Allow extra properties for flexibility if needed by tests
	// biome-ignore lint/suspicious/noExplicitAny: Index signature for test double flexibility
	[key: string]: any;
}

interface FakeChildProcessOptions {
	pid?: number;
	exitCode?: number | null;
	signalCode?: NodeJS.Signals | null;
}

export class FakeChildProcess extends EventEmitter implements ChildProcessLike {
	stdin: PassThrough;
	stdout: PassThrough;
	stderr: PassThrough;
	pid: number;
	connected: boolean;
	killed: boolean;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;

	private _stdinContent: string;

	constructor(options: FakeChildProcessOptions = {}) {
		super();
		this.pid = options.pid ?? Math.floor(Math.random() * 10000) + 1000; // Default random PID
		this.stdin = new PassThrough();
		this.stdout = new PassThrough();
		this.stderr = new PassThrough();
		this.connected = true;
		this.killed = false;
		this.exitCode = options.exitCode ?? null;
		this.signalCode = options.signalCode ?? null;
		this._stdinContent = "";

		// Capture stdin data
		this.stdin.on("data", (chunk) => {
			this._stdinContent += chunk.toString();
		});
	}

	writeToStdout(data: string | Buffer): void {
		this.stdout.write(data);
	}

	writeToStderr(data: string | Buffer): void {
		this.stderr.write(data);
	}

	async exit(
		code: number | null = 0,
		signal: NodeJS.Signals | null = null,
	): Promise<void> {
		if (this.killed) {
			// Already exited/killed
			return;
		}
		this.killed = true;
		this.connected = false;
		this.exitCode = code;
		this.signalCode = signal;

		// End streams asynchronously
		this.stdout.end();
		this.stderr.end();
		this.stdin.end(); // End stdin as well

		// Emit events after a tick to simulate async exit
		await new Promise((resolve) => process.nextTick(resolve));

		this.emit("exit", this.exitCode, this.signalCode);
		this.emit("close", this.exitCode, this.signalCode);
		this.removeAllListeners(); // Clean up listeners after exit
	}

	kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
		const signalName = typeof signal === "number" ? undefined : signal; // Extract signal name if it's a string
		if (!this.killed) {
			this.exit(null, signalName); // Use the extracted signal name or null
			return true;
		}
		return false;
	}

	disconnect(): void {
		if (this.connected) {
			this.connected = false;
			this.emit("disconnect");
		}
	}

	// Helper for tests to check what was written to stdin
	async getStdinContent(): Promise<string> {
		return new Promise((resolve) => {
			if (this.stdin.readableEnded) {
				resolve(this._stdinContent);
			} else {
				this.stdin.once("end", () => {
					resolve(this._stdinContent);
				});
			}
		});
	}
}
