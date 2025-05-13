#!/usr/bin/env node

import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { program } from "commander";
import type { Command as CommanderCommand } from "commander";

import {
	Chopup,
	type ChopupOptions,
	INPUT_SEND_ERROR,
	INPUT_SEND_ERROR_BACKPRESSURE,
	INPUT_SEND_ERROR_NO_CHILD,
	INPUT_SENT,
} from "./chopup";

let effectiveArgv = process.argv;
if (effectiveArgv.length > 2 && effectiveArgv[2] === "--") {
	effectiveArgv = [
		effectiveArgv[0],
		effectiveArgv[1],
		"run",
		...effectiveArgv.slice(3),
	];
}

// Global logging helpers
function log(verbose: boolean, ...args: unknown[]) {
	if (verbose) console.log("[CHOPUP_CLI]", ...args);
}
function logWarn(...args: unknown[]) {
	console.warn("[CHOPUP_CLI_WARN]", ...args);
}
function logError(...args: unknown[]) {
	console.error("[CHOPUP_CLI_ERROR]", ...args);
}

function sanitizeForFolder(name: string): string {
	return name
		.replace(/[^a-zA-Z0-9_-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 40);
}

function getIpcSocketPath(pid: number): string {
	const base = os.tmpdir();
	const sockName = `chopup_${pid}.sock`;
	return path.join(base, sockName);
}

const INPUT_SEND_ERROR_NO_SERVER = "CHOPUP_INPUT_SEND_ERROR_NO_SERVER";

async function setupWatcher(
	watchPath: string,
	getSocketPath: () => string | null,
	logger: typeof log,
	errorLogger: typeof logError,
) {
	logger(`Watcher: Attempting to watch ${watchPath}`);
	const watcher = chokidar.watch(watchPath, {
		persistent: true,
		ignoreInitial: true,
	});

	watcher.on("all", (event, filePath) => {
		logger(`Watcher: File ${filePath} event: ${event}. Requesting log chop.`);
		const actualSocketPath = getSocketPath();
		if (!actualSocketPath) {
			errorLogger(
				"Watcher: Cannot request logs, Chopup instance socket path not available.",
			);
			return;
		}
		const client = net.createConnection({ path: actualSocketPath });
		client.on("connect", () => {
			logger(
				`Watcher: Connected to ${actualSocketPath} for file change event.`,
			);
			client.write(JSON.stringify({ command: "request-logs" }));
		});
		client.on("data", (data) => {
			logger(`Watcher: IPC response: ${data.toString()}`);
			client.end();
		});
		client.on("error", (err) =>
			errorLogger(`Watcher: IPC error for ${actualSocketPath}: ${err.message}`),
		);
		client.on("end", () => logger("Watcher: IPC connection ended."));
	});
	watcher.on("ready", () =>
		logger(`Watcher: Ready and watching ${watchPath}.`),
	);
	watcher.on("error", (err: unknown) =>
		errorLogger(
			`Watcher: Error watching ${watchPath}: ${(err as Error).message}`,
		),
	);
}

async function performInitialSend(
	input: string,
	getSocketPath: () => string | null,
	logger: typeof log,
	errorLogger: typeof logError,
	warnLogger: typeof logWarn,
) {
	logger(`InitialSend: Attempting to send "${input}"`);
	await new Promise((resolve) => setTimeout(resolve, 1500));

	const actualSocketPath = getSocketPath();
	if (!actualSocketPath) {
		errorLogger(
			"InitialSend: Cannot send input, Chopup instance socket path not available.",
		);
		return;
	}

	logger(`InitialSend: Connecting to ${actualSocketPath}`);
	const client = net.createConnection({ path: actualSocketPath });

	client.on("connect", () => {
		logger(`InitialSend: Connected. Sending: "${input}"`);
		client.write(JSON.stringify({ command: "send-input", input }));
	});
	client.on("data", (data) => {
		const response = data.toString();
		logger(`InitialSend: IPC Response: ${response}`);
		if (response === INPUT_SENT)
			logger("InitialSend: Input successfully sent.");
		else warnLogger(`InitialSend: Unexpected IPC response: ${response}`);
		client.end();
	});
	client.on("error", (err) => {
		errorLogger(
			`InitialSend: IPC Error for ${actualSocketPath}: ${err.message}`,
		);
		if (!client.destroyed) client.destroy();
	});
	client.on("end", () => logger("InitialSend: IPC Connection ended."));
	client.on("close", () => logger("InitialSend: IPC Connection closed."));

	const clientTimeout = setTimeout(() => {
		errorLogger(
			`InitialSend: Operation timed out for socket ${actualSocketPath}.`,
		);
		if (!client.destroyed) client.destroy();
	}, 7000);

	client.on("close", () => clearTimeout(clientTimeout));
}

async function mainAction(
	this: CommanderCommand,
	commandArgsFromAction: string[],
	optionsFromAction: Record<string, unknown>,
) {
	const commandName = this.name();
	let combinedOptions: Record<string, unknown>;
	if (this.parent) {
		combinedOptions = { ...this.parent.opts(), ...optionsFromAction };
	} else {
		combinedOptions = { ...this.opts(), ...optionsFromAction };
	}

	const effectiveCommandName =
		commandName === "chopup" && commandArgsFromAction.length > 0
			? "run"
			: commandName;

	log(
		combinedOptions.verbose as boolean,
		`Effective command: ${effectiveCommandName}, Args: ${commandArgsFromAction.join(" ")}, Opts: ${JSON.stringify(combinedOptions)}`,
	);

	const {
		logDir: logDirOption,
		watchFile: watchFileOption,
		socketPath: socketPathOption,
		send: sendOption,
		socket: clientSocketOption,
		input: clientInputOption,
	} = combinedOptions;

	const defaultLogDir =
		process.env.CHOPUP_LOG_DIR || path.join(os.tmpdir(), "chopup", "logs");
	const logDir = path.resolve(
		typeof logDirOption === "string" ? logDirOption : defaultLogDir,
	);

	if (effectiveCommandName === "run") {
		const commandToRun = commandArgsFromAction[0];
		const Cargs = commandArgsFromAction.slice(1);

		if (!commandToRun) {
			logError("Error: No command specified for 'run'.");
			this.help();
			process.exit(1);
		}

		if (!fsSync.existsSync(logDir)) {
			try {
				await fs.mkdir(logDir, { recursive: true });
				log(combinedOptions.verbose as boolean, `Log directory created / ensured: ${logDir}`);
			} catch (err: unknown) {
				logError(
					`Fatal: Failed to create log directory ${logDir}: ${(err as Error).message}`,
				);
				process.exit(1);
			}
		}

		log(
			combinedOptions.verbose as boolean,
			`Run: Command = '${commandToRun}', Args = '${Cargs.join(" ")}', LogDir = '${logDir}', SocketForServer = '${socketPathOption || "Default"}'`,
		);

		// Log the values for debugging
		log(
			combinedOptions.verbose as boolean,
			`commandToRun: ${commandToRun}, args: ${Cargs.join(" ")}`,
		);
		log(
			combinedOptions.verbose as boolean,
			`socketPathOption: ${socketPathOption}, type: ${typeof socketPathOption}`,
		);
		log(combinedOptions.verbose as boolean, `logDir: ${logDir}, type: ${typeof logDir}`);

		const chopupInstance = new Chopup([commandToRun, ...Cargs], {
			command: [commandToRun, ...Cargs],
			logDir: logDir,
			socketPath: socketPathOption as string,
			verbose: combinedOptions.verbose as boolean,
		});

		// Log the actual socket path used
		log(
			combinedOptions.verbose as boolean,
			`Actual socket path: ${chopupInstance.getSocketPath()}`,
		);

		const getActualSocketPath = () => chopupInstance.getSocketPath();

		if (watchFileOption) {
			setupWatcher(
				watchFileOption as string,
				getActualSocketPath,
				(...args) => log(combinedOptions.verbose as boolean, ...args),
				logError,
			).catch((e) => logError("Error in setupWatcher:", e));
		}
		if (sendOption && typeof sendOption === "string") {
			performInitialSend(
				sendOption,
				getActualSocketPath,
				(...args) => log(combinedOptions.verbose as boolean, ...args),
				logError,
				logWarn,
			).catch((e) => logError("Error in performInitialSend:", e));
		}

		try {
			await chopupInstance.run();
			log(combinedOptions.verbose as boolean, "Chopup instance run completed.");
		} catch (error) {
			logError("Error during chopupInstance.run():", error);
			process.exit(1);
		}
	} else if (effectiveCommandName === "request-logs") {
		if (!clientSocketOption) {
			logError("Error: --socket option is required for request-logs.");
			this.help();
			process.exit(1);
		}
		log(combinedOptions.verbose as boolean, `Client: Requesting logs via socket: ${clientSocketOption}`);
		const client = net.createConnection({ path: clientSocketOption as string });
		const clientTimeout = setTimeout(() => {
			logError("request-logs timeout");
			if (!client.destroyed) client.destroy();
			process.exit(124);
		}, 5000);

		client.on("connect", () => {
			log(combinedOptions.verbose as boolean, "Client: Connected for request-logs.");
			client.write(JSON.stringify({ command: "request-logs" }));
		});
		client.on("data", (data) => {
			const res = data.toString();
			log(combinedOptions.verbose as boolean, `Client: Response for request - logs: ${res}`);
			if (res === "LOGS_CHOPPED") console.log("LOGS_CHOPPED");
			else logWarn("Unexpected response.");
			clearTimeout(clientTimeout);
			client.end(() => process.exit(0));
		});
		client.on("error", (err) => {
			logError(
				`Client: Error for request-logs on ${clientSocketOption}: ${(err as NodeJS.ErrnoException).message}`,
			);
			if (
				(err as NodeJS.ErrnoException).code === "ECONNREFUSED" ||
				(err as NodeJS.ErrnoException).code === "ENOENT"
			)
				console.error("CHOPUP_REQUEST_LOGS_ERROR_NO_SERVER");
			else console.error("CHOPUP_REQUEST_LOGS_ERROR_UNKNOWN");
			clearTimeout(clientTimeout);
			if (!client.destroyed) client.destroy();
			else process.exit(1);
		});
		client.on("close", () => {
			clearTimeout(clientTimeout);
			log(combinedOptions.verbose as boolean, "Client: Connection closed for request-logs.");
		});
	} else if (effectiveCommandName === "send-input") {
		if (!clientSocketOption || typeof clientInputOption !== "string") {
			logError(
				"Error: --socket and --input (string) are required for send-input.",
			);
			this.help();
			process.exit(1);
		}
		log(
			combinedOptions.verbose as boolean,
			`Client: Sending input "${clientInputOption}" via socket: ${clientSocketOption}`,
		);
		suppressSendInputLogs();
		const client = net.createConnection({ path: clientSocketOption as string });
		let clientExited = false;
		const exitClient = (code: number) => {
			if (clientExited) return;
			clientExited = true;
			clearTimeout(clientTimeout);
			if (!client.destroyed) client.end(() => process.exit(code));
			else process.exit(code);
		};
		const clientTimeout = setTimeout(() => {
			logError("send-input timeout");
			console.error(INPUT_SEND_ERROR_NO_SERVER);
			exitClient(124);
		}, 5000);

		client.on("connect", () => {
			log(combinedOptions.verbose as boolean, "Client: Connected for send-input.");
			client.write(
				JSON.stringify({ command: "send-input", input: clientInputOption }),
			);
		});
		client.on("data", (data) => {
			const res = data.toString();
			log(combinedOptions.verbose as boolean, `Client: Response for send-input: ${res}`);
			if (res === INPUT_SENT) {
				console.log(INPUT_SENT);
				exitClient(0);
			} else if (
				[
					INPUT_SEND_ERROR,
					INPUT_SEND_ERROR_NO_CHILD,
					INPUT_SEND_ERROR_BACKPRESSURE,
				].includes(res)
			) {
				console.error(res);
				exitClient(1);
			} else if (res === "IPC_PARSE_ERROR") {
				console.error("CHOPUP_SEND_INPUT_ERROR_SERVER_PARSE");
				exitClient(1);
			} else {
				logWarn("Unexpected response.");
				console.error("CHOPUP_SEND_INPUT_ERROR_UNEXPECTED_RESPONSE");
				exitClient(1);
			}
		});
		client.on("error", (err) => {
			logError(
				`Client: Error for send-input on ${clientSocketOption}: ${(err as NodeJS.ErrnoException).message}`,
			);
			if (
				(err as NodeJS.ErrnoException).code === "ECONNREFUSED" ||
				(err as NodeJS.ErrnoException).code === "ENOENT"
			)
				console.error(INPUT_SEND_ERROR_NO_SERVER);
			else console.error("CHOPUP_SEND_INPUT_ERROR_CONNECTION_FAILED");
			exitClient(1);
		});
		client.on("close", () => {
			log(combinedOptions.verbose as boolean, "Client: Connection closed for send-input.");
			if (!clientExited) {
				logWarn("Closed unexpectedly.");
				console.error("CHOPUP_SEND_INPUT_ERROR_UNEXPECTED_CLOSE");
				exitClient(1);
			}
		});
	} else {
		logWarn(
			`Unknown command or insufficient args for default: ${effectiveCommandName}`,
		);
		program.help();
	}
}

function suppressSendInputLogs() {
	process.env.CHOPUP_SUPPRESS_SOCKET_PATH_LOG = "true";
}

program
	.name("chopup")
	.description("Wraps processes, segments logs, allows IPC interaction.")
	.option(
		"-l, --log-dir <dir>",
		`Log directory. Default: CHOPUP_LOG_DIR or ${path.join(os.tmpdir(), "chopup", "logs")}`,
	)
	.option(
		"-w, --watch-file <file>",
		"EXPERIMENTAL: File/dir to watch for triggering log chops on the 'run' instance.",
	)
	.option(
		"-s, --socket-path <path>",
		"For 'run': specify IPC server socket path. Default: generated in log-dir.",
	)
	.option(
		"--send <input>",
		"EXPERIMENTAL: For 'run': send initial input string after start.",
	)
	.option("-v, --verbose", "Enable verbose logging", false)
	.option(
		"--initial-chop",
		"Perform an initial log chop immediately on startup",
		false,
	)
	.argument("[command...]", "The command to wrap and execute")
	.action(async (command) => {
		const chopupInstance = new Chopup(
			command, // Command array
			{
				command,
				verbose: program.opts().verbose,
				socketPath: program.opts().socketPath,
				logDir: program.opts().logDir,
				initialChop: program.opts().initialChop,
			} as ChopupOptions,
		);
		await chopupInstance.run();
	});

program
	.command("run")
	.description("Run the specified command and wrap it (primary operation).")
	.argument("<command>", "The command to execute.")
	.argument("[args...]", "Arguments for the command.")
	.allowUnknownOption(true)
	.action(async function (
		this: CommanderCommand,
		command: string,
		args: string[],
		cmdObj: CommanderCommand,
	) {
		const globalOpts = this.parent?.opts() || {};
		await mainAction.call(this, [command, ...args], globalOpts);
	});

program
	.command("request-logs")
	.description("Request the running Chopup instance to chop logs.")
	.requiredOption("--socket <path>", "IPC socket path of the Chopup instance.")
	.action(async function (this: CommanderCommand, options: { socket: string }) {
		const globalOpts = this.parent?.opts() || {};
		await mainAction.call(this, [], { ...globalOpts, ...options });
	});

program
	.command("send-input")
	.description("Send input string to the wrapped process.")
	.requiredOption("--socket <path>", "IPC socket path of the Chopup instance.")
	.requiredOption("-i, --input <string>", "Input string to send.")
	.action(async function (
		this: CommanderCommand,
		options: { socket: string; input: string },
	) {
		const globalOpts = this.parent?.opts() || {};
		await mainAction.call(this, [], { ...globalOpts, ...options });
	});

program.parseAsync(effectiveArgv).catch((err) => {
	logError("Unhandled error during program execution:", err.message);
	if (err.stack && process.env.CHOPUP_CLI_VERBOSE) console.error(err.stack);
	process.exit(1);
});
