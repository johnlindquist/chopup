import { EventEmitter } from "node:events";
import type {
	PassThrough as PassThroughType,
	Readable,
	Writable,
} from "node:stream";
import { PassThrough as ActualPassThrough } from "node:stream";

export class FakeChildProcess extends EventEmitter {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	pid: number = Math.floor(Math.random() * 10000) + 1000; // Random PID
	connected = true; // Mock connection status
	killed = false;

	private _stdoutPT: PassThroughType;
	private _stderrPT: PassThroughType;
	private _stdinPT: PassThroughType; // To capture what's written to stdin

	constructor(options?: { pid?: number }) {
		super();
		if (options?.pid) {
			this.pid = options.pid;
		}

		this._stdinPT = new ActualPassThrough(); // What the test writes
		this.stdin = this._stdinPT;

		this._stdoutPT = new ActualPassThrough();
		this.stdout = this._stdoutPT;

		this._stderrPT = new ActualPassThrough();
		this.stderr = this._stderrPT;

		// Simulate process being spawned and running
		// process.nextTick(() => this.emit('spawn')); // Can emit 'spawn' if needed
	}

	// Methods to simulate child process behavior
	writeToStdout(data: string | Buffer) {
		if (!this._stdoutPT.destroyed && this._stdoutPT.writable) {
			this._stdoutPT.write(data);
		}
	}

	writeToStderr(data: string | Buffer) {
		if (!this._stderrPT.destroyed && this._stderrPT.writable) {
			this._stderrPT.write(data);
		}
	}

	// Method to simulate the child process exiting
	async exit(
		code: number | null = 0,
		signal: NodeJS.Signals | null = null,
	): Promise<void> {
		if (this.killed) return;
		this.connected = false;
		this.killed = true;

		// Simply end the streams, don't await their 'end' events here
		if (this._stdoutPT && !this._stdoutPT.destroyed) {
			this._stdoutPT.end();
		}
		if (this._stderrPT && !this._stderrPT.destroyed) {
			this._stderrPT.end();
		}
		if (this._stdinPT && !this._stdinPT.destroyed) {
			this._stdinPT.end();
		}

		this.emit("exit", code, signal);
		this.emit("close", code, signal);

		await new Promise((resolve) => process.nextTick(resolve));

		this.removeAllListeners();
	}

	// Methods to mimic ChildProcess API if needed by tests
	async kill(signal?: NodeJS.Signals | number): Promise<boolean> {
		if (this.killed) return false;
		// console.log(`[FakeChild ${this.pid}] received kill signal: ${signal}`);
		await this.exit(null, typeof signal === "string" ? signal : "SIGTERM"); // Default to SIGTERM if number
		return true;
	}

	disconnect() {
		if (!this.connected) return;
		this.connected = false;
		this.emit("disconnect");
	}

	// For tests to inspect what was written to stdin
	getStdinContent(): Promise<string> {
		return new Promise((resolve) => {
			let content = "";
			this._stdinPT.on("data", (chunk) => {
				content = content + chunk.toString();
			});
			this._stdinPT.on("end", () => resolve(content));
		});
	}
}
