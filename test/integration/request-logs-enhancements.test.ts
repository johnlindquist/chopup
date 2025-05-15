import { execSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
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
} from "vitest";

const CHOPUP_DIST_PATH = path.resolve(__dirname, "../../dist/index.js");
const TMP_DIR_INTEGRATION = path.resolve(
    __dirname,
    "../../tmp/integration-req-logs-enh",
); // Unique tmp dir
const SCRIPTS_DIR = path.join(__dirname, "input-tests/fixtures/scripts"); // REVERTED PATH

interface ChopupTestInstance {
    process: ChildProcessWithoutNullStreams;
    socketPath: string; // Made non-optional as we ensure it's defined
    logDir: string;
    stdout: string[];
    stderr: string[];
    pid: number;
    kill: () => Promise<void>;
    cleanup: () => Promise<void>;
}

// Adapted from chopup-cli.test.ts
async function spawnChopupInstance(
    args: string[],
    timeoutMs = 15000, // Increased timeout for potentially slower CI
): Promise<ChopupTestInstance> {
    return new Promise((resolve, reject) => {
        const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const logDir = path.join(TMP_DIR_INTEGRATION, `logs-${uniqueId}`);
        const instanceSocketPath = path.join(
            TMP_DIR_INTEGRATION,
            `test-sock-${uniqueId}.sock`,
        );

        fsSync.mkdirSync(logDir, { recursive: true });
        fsSync.mkdirSync(path.dirname(instanceSocketPath), { recursive: true });

        // Always use --verbose for easier debugging in tests
        // Pass the specific socket path along with other args
        // Options for \'run\' must come BEFORE \'--\' and the command to wrap
        let finalArgs: string[];
        const baseChopupArgs = [
            "--verbose",
            "--log-dir",
            logDir,
            "--socket-path",
            instanceSocketPath,
        ];

        if (args[0] === "run") {
            const runCmd = args[0];
            const separatorIndex = args.indexOf("--");
            if (separatorIndex !== -1) {
                const commandToWrap = args.slice(separatorIndex);
                const runArgsOnly = args.slice(1, separatorIndex);
                finalArgs = [
                    ...baseChopupArgs,
                    runCmd,
                    ...runArgsOnly,
                    ...commandToWrap,
                ];
            } else {
                finalArgs = [
                    ...baseChopupArgs,
                    runCmd,
                    "--", // Ensure separator
                    ...args.slice(1),
                ];
            }
        } else {
            // For client commands, they handle their own socket arg
            finalArgs = [...args];
        }

        console.log(
            `[TEST_SPAWN_ENH] Spawning: node ${CHOPUP_DIST_PATH} ${finalArgs.join(" ")}`,
        );

        const proc = spawn("node", [CHOPUP_DIST_PATH, ...finalArgs], {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                CHOPUP_TEST_MODE: "true", // Suppress user instructions
                CHOPUP_CLI_VERBOSE: "true", // Enable Chopup CLI debug logs, also makes isTestMode true in chopLog
            },
        });

        const stdoutData: string[] = [];
        const stderrData: string[] = [];
        let resolved = false;
        let socketPathConfirmedByInstance = false;
        let processReadySignalReceived = false;

        const timer = setTimeout(() => {
            if (!resolved) {
                proc.kill();
                console.error(
                    `[TEST_SPAWN_ENH_TIMEOUT] Stdout: ${stdoutData.join("\\n")}`,
                );
                console.error(
                    `[TEST_SPAWN_ENH_TIMEOUT] Stderr: ${stderrData.join("\\n")}`,
                );
                reject(
                    new Error(
                        `spawnChopupInstance timed out after ${timeoutMs}ms for command: node ${CHOPUP_DIST_PATH} ${finalArgs.join(" ")}`,
                    ),
                );
            }
        }, timeoutMs);

        proc.stdout.on("data", (data) => {
            const line = data.toString();
            stdoutData.push(line);
            // console.log(`[CHOPUP_STDOUT_ENH ${proc.pid}] ${line.trim()}`); // Verbose logging

            // Detect CHOPUP_SOCKET_PATH and CHOPUP_PROCESS_READY
            // Enhanced logging for socket path detection
            if (!socketPathConfirmedByInstance && line.includes("CHOPUP_SOCKET_PATH=")) {
                console.log(
                    `[TEST_SPAWN_ENH ${proc.pid}] Raw line with CHOPUP_SOCKET_PATH: "${line.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`,
                );
                const socketMatch = line.match(/CHOPUP_SOCKET_PATH=([^\n\r]+)/);
                console.log(
                    `[TEST_SPAWN_ENH ${proc.pid}] Socket match result: ${JSON.stringify(socketMatch)}`,
                );
                if (socketMatch?.[1]) {
                    const reportedSocketPath = socketMatch[1].trim();
                    console.log(
                        `[TEST_SPAWN_ENH ${proc.pid}] Reported socket path: "${reportedSocketPath}"`,
                    );
                    console.log(
                        `[TEST_SPAWN_ENH ${proc.pid}] Expected instance socket path: "${instanceSocketPath}"`,
                    );
                    if (reportedSocketPath === instanceSocketPath) {
                        socketPathConfirmedByInstance = true;
                        console.log(
                            `[TEST_SPAWN_ENH ${proc.pid}] Socket path CONFIRMED by instance: ${instanceSocketPath}`,
                        );
                    } else {
                        console.warn(
                            `[TEST_SPAWN_ENH ${proc.pid}] Socket path MISMATCH. Reported: "${reportedSocketPath}", Expected: "${instanceSocketPath}"`,
                        );
                    }
                } else {
                    console.warn(
                        `[TEST_SPAWN_ENH ${proc.pid}] CHOPUP_SOCKET_PATH prefix found, but regex failed to extract path from line: "${line.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`,
                    );
                }
            }

            if (!processReadySignalReceived && line.includes("[chopup_wrapper] CHOPUP_PROCESS_READY")) {
                processReadySignalReceived = true;
                console.log(
                    `[TEST_SPAWN_ENH ${proc.pid}] Process ready signal received.`,
                );
            }

            if (
                socketPathConfirmedByInstance &&
                processReadySignalReceived &&
                !resolved
            ) {
                // Additional check for socket file existence before resolving
                if (fsSync.existsSync(instanceSocketPath)) {
                    resolved = true;
                    clearTimeout(timer);
                    console.log(
                        `[TEST_SPAWN_ENH ${proc.pid}] Instance ready. Socket: ${instanceSocketPath}`,
                    );
                    resolve({
                        process: proc,
                        socketPath: instanceSocketPath,
                        logDir,
                        stdout: stdoutData,
                        stderr: stderrData,
                        pid: proc.pid ?? -1,
                        kill: () =>
                            new Promise<void>((res, rej) => {
                                if (proc.pid) {
                                    treeKill(proc.pid, (err) => (err ? rej(err) : res()));
                                } else {
                                    res();
                                }
                            }),
                        cleanup: async () => {
                            // Kill first
                            if (proc && proc.pid && !proc.killed) {
                                await new Promise<void>((resolveKill) => {
                                    treeKill(proc.pid as number, "SIGKILL", (err) => {
                                        if (err)
                                            console.error(
                                                `[TEST_CLEANUP_ENH] Error tree-killing ${proc.pid}: ${err.message}`,
                                            );
                                        resolveKill();
                                    });
                                });
                            }
                            // Then remove dirs
                            if (fsSync.existsSync(logDir)) {
                                await fs.rm(logDir, { recursive: true, force: true });
                            }
                            if (
                                fsSync.existsSync(instanceSocketPath) &&
                                instanceSocketPath.startsWith(TMP_DIR_INTEGRATION)
                            ) {
                                try {
                                    await fs.unlink(instanceSocketPath);
                                } catch (e) {
                                    /* ignore, might be cleaned up by process */
                                }
                            }
                            const parentSocketDir = path.dirname(instanceSocketPath);
                            if (
                                parentSocketDir !== TMP_DIR_INTEGRATION &&
                                fsSync.existsSync(parentSocketDir) &&
                                fsSync.readdirSync(parentSocketDir).length === 0
                            ) {
                                await fs.rmdir(parentSocketDir);
                            }
                        },
                    });
                } else {
                    console.warn(
                        `[TEST_SPAWN_ENH ${proc.pid}] Signals received, but socket ${instanceSocketPath} not found yet. Waiting...`,
                    );
                }
            }
        });

        proc.stderr.on("data", (data) => {
            stderrData.push(data.toString());
            // console.error(`[CHOPUP_STDERR_ENH ${proc.pid}] ${data.toString().trim()}`);
        });

        proc.on("error", (err) => {
            if (!resolved) {
                clearTimeout(timer);
                resolved = true;
                console.error(
                    `[TEST_SPAWN_ENH ${proc.pid}] Process error: ${err.message}`,
                );
                reject(err);
            }
        });

        proc.on("exit", (code, signal) => {
            if (!resolved) {
                clearTimeout(timer);
                resolved = true;
                console.error(
                    `[TEST_SPAWN_ENH ${proc.pid}] Exited prematurely. Code: ${code}, Signal: ${signal}. Stderr: ${stderrData.join("")}`,
                );
                reject(
                    new Error(
                        `Chopup process exited prematurely. Code: ${code}, Signal: ${signal}`,
                    ),
                );
            }
        });
    });
}

async function waitForSocketFile(
    socketPath: string,
    timeoutMs = 5000,
): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        if (fsSync.existsSync(socketPath)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
        `Timeout waiting for socket file ${socketPath} to exist.`,
    );
}

describe("Request Logs Enhancements", () => {
    let chopupInstance: ChopupTestInstance | null = null;

    beforeAll(async () => {
        if (fsSync.existsSync(TMP_DIR_INTEGRATION)) {
            await fs.rm(TMP_DIR_INTEGRATION, { recursive: true, force: true });
        }
        await fs.mkdir(TMP_DIR_INTEGRATION, { recursive: true });
        if (!fsSync.existsSync(CHOPUP_DIST_PATH)) {
            console.log(
                "[REQ_LOGS_TEST] dist/index.js not found, running pnpm build...",
            );
            execSync("pnpm build", { stdio: "inherit" });
        }
    });

    afterEach(async () => {
        if (chopupInstance) {
            await chopupInstance.cleanup();
            chopupInstance = null;
        }
    });

    afterAll(async () => {
        // Optional: Keep tmp dir for inspection by commenting out
        // if (fsSync.existsSync(TMP_DIR_INTEGRATION)) {
        // 	await fs.rm(TMP_DIR_INTEGRATION, { recursive: true, force: true });
        // }
    });

    it("should output log file path on request-logs and pipe content with --pipe", async () => {
        // Start a long-running script that produces some output
        const scriptToRun = path.join(SCRIPTS_DIR, "continuous-output.js");
        if (!fsSync.existsSync(scriptToRun)) {
            throw new Error(`Test script not found: ${scriptToRun}`);
        }

        chopupInstance = await spawnChopupInstance([
            "run",
            "--",
            "node",
            scriptToRun,
            "TestPrefix", // Argument for the script
        ]);

        try {
            expect(chopupInstance.pid).toBeGreaterThan(0);
            expect(chopupInstance.socketPath).toBeDefined();
            await waitForSocketFile(chopupInstance.socketPath);

            // Give the script some time to produce output
            await new Promise((resolve) => setTimeout(resolve, 1500)); // Wait for some logs

            // 1. Test request-logs (no pipe)
            let requestLogsOutput = "";
            try {
                requestLogsOutput = execSync(
                    `node ${CHOPUP_DIST_PATH} request-logs --socket ${chopupInstance.socketPath}`,
                    { encoding: "utf8", timeout: 5000 },
                );
            } catch (e: any) {
                console.error(
                    "Error executing request-logs (no pipe):",
                    e.stdout,
                    e.stderr,
                );
                throw e;
            }

            console.log("[TEST_INFO] request-logs output:", requestLogsOutput.trim());
            expect(requestLogsOutput).toContain("Logs chopped to:");
            const logFilePathMatch = requestLogsOutput.match(
                /Logs chopped to: (.*)/,
            );
            expect(logFilePathMatch).not.toBeNull();
            const logFilePath1 = logFilePathMatch?.[1].trim();
            expect(logFilePath1).toBeDefined();
            expect(fsSync.existsSync(logFilePath1 as string)).toBe(true);
            const logContent1 = await fs.readFile(logFilePath1 as string, "utf-8");
            expect(logContent1).toContain("TestPrefix"); // Check content from the script

            // Give some more time for new logs
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // 2. Test request-logs --pipe
            let requestLogsPipeOutput = "";
            try {
                requestLogsPipeOutput = execSync(
                    `node ${CHOPUP_DIST_PATH} request-logs --socket ${chopupInstance.socketPath} --pipe`,
                    { encoding: "utf8", timeout: 5000 },
                );
            } catch (e: any) {
                console.error(
                    "Error executing request-logs --pipe:",
                    e.stdout,
                    e.stderr,
                );
                throw e;
            }
            console.log(
                "[TEST_INFO] request-logs --pipe output:",
                requestLogsPipeOutput.trim(),
            );

            expect(requestLogsPipeOutput).toContain("Logs chopped to:");
            const logFilePathMatch2 = requestLogsPipeOutput.match(
                /Logs chopped to: (.*)/,
            );
            expect(logFilePathMatch2).not.toBeNull();
            const logFilePath2 = logFilePathMatch2?.[1].trim();
            expect(logFilePath2).toBeDefined();
            expect(logFilePath2).not.toEqual(logFilePath1); // Should be a new file
            expect(fsSync.existsSync(logFilePath2 as string)).toBe(true);

            // Verify the piped content is part of the output
            const logContent2 = await fs.readFile(logFilePath2 as string, "utf-8");
            expect(logContent2).toContain("TestPrefix");
            // The stdout from execSync (requestLogsPipeOutput) should contain the file path message AND the file content
            expect(requestLogsPipeOutput).toContain(
                logContent2.trim().split("\\n")[0],
            ); // Check at least the first line of actual log content
        } catch (error) {
            if (chopupInstance) {
                console.error(
                    "--- Chopup Instance STDOUT ---",
                    chopupInstance.stdout.join(""),
                );
                console.error(
                    "--- Chopup Instance STDERR (debug logs) ---",
                    chopupInstance.stderr.join(""),
                );
            }
            throw error; // Re-throw the original error to fail the test
        }
    }, 25000); // Increased test timeout
}); 