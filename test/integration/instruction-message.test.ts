import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, type ExecSyncOptionsWithBufferEncoding } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import treeKill from "tree-kill";

import { INSTRUCTIONS_TEMPLATE } from "../../src/messages";

const CHOPUP_DIST_PATH = path.resolve(__dirname, "../../dist/index.js");
const SCRIPTS_DIR = path.resolve(__dirname, "./fixtures/scripts");
const TEMP_DIR_BASE = path.join(os.tmpdir(), "chopup-tests");

interface ChopupTestInstance {
    process: import("node:child_process").ChildProcess;
    socketPath: string;
    logDir: string;
    stdout: string[];
    stderr: string[];
    pid: number;
    kill: () => Promise<void>;
    cleanup: () => Promise<void>;
}

async function spawnChopup(
    args: string[],
    timeoutMs = 10000,
    envVars: Record<string, string> = {},
): Promise<ChopupTestInstance> {
    return new Promise((resolve, reject) => {
        const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const logDir = path.join(TEMP_DIR_BASE, `test-logs-${uniqueId}`);
        const instanceSocketPath = path.join(TEMP_DIR_BASE, `chopup-test-sock-${uniqueId}.sock`);

        fsSync.mkdirSync(logDir, { recursive: true });

        const fullArgs = [
            CHOPUP_DIST_PATH,
            "--log-dir",
            logDir,
            "--socket-path",
            instanceSocketPath,
            ...args,
        ];

        let resolved = false;
        const stdoutData: string[] = [];
        const stderrData: string[] = [];
        let socketPathFound = "";
        let processReadySignalReceived = false;

        const proc = require("node:child_process").spawn("node", fullArgs, {
            detached: false,
            stdio: "pipe",
            env: { ...process.env, ...envVars },
        });

        const timer = setTimeout(() => {
            if (!resolved) {
                reject(
                    new Error(
                        `Timeout: Chopup did not become ready within ${timeoutMs}ms. Socket: ${socketPathFound}, Ready: ${processReadySignalReceived}`,
                    ),
                );
                if (proc.pid) treeKill(proc.pid);
            }
        }, timeoutMs);

        proc.stdout.on("data", (data) => {
            const line = data.toString();
            stdoutData.push(line);
            // console.log(`[Test STDOUT CHOPUP ${proc.pid}]: ${line.trim()}`);

            if (line.includes("CHOPUP_SOCKET_PATH=")) {
                socketPathFound = line.split("=")[1].trim();
            }
            if (line.includes("CHOPUP_PROCESS_READY")) {
                processReadySignalReceived = true;
            }

            if (socketPathFound && processReadySignalReceived && !resolved) {
                resolved = true;
                clearTimeout(timer); // Clear the main timeout
                resolve({
                    process: proc,
                    socketPath: instanceSocketPath,
                    logDir,
                    stdout: stdoutData, // Use the potentially updated stdoutData
                    stderr: stderrData,
                    pid: proc.pid ?? -1,
                    kill: () =>
                        new Promise<void>((res, rej) => {
                            if (proc.pid) {
                                treeKill(proc.pid, "SIGKILL", (err) => (err ? rej(err) : res()));
                            } else {
                                res();
                            }
                        }),
                    cleanup: async () => {
                        if (fsSync.existsSync(logDir)) {
                            fsSync.rmSync(logDir, { recursive: true, force: true });
                        }
                    },
                });
            }
        });

        proc.stderr.on("data", (data) => {
            stderrData.push(data.toString());
            // console.error(`[Test STDERR CHOPUP ${proc.pid}]: ${data.toString().trim()}`);
        });

        proc.on("error", (err) => {
            clearTimeout(timer);
            reject(new Error(`Chopup process error: ${err.message}`));
        });

        proc.on("exit", (code, signal) => {
            clearTimeout(timer);
            if (!resolved) {
                // If it exits before resolving, it's an error, unless killed intentionally by test
                if (!proc.killed) {
                    reject(
                        new Error(
                            `Chopup process exited prematurely with code ${code}, signal ${signal}. Stderr: ${stderrData.join("")}`,
                        ),
                    );
                }
            }
        });
    });
}

describe("Instruction Message Tests", () => {
    let chopupInstance: ChopupTestInstance | null = null;

    beforeEach(() => {
        fsSync.mkdirSync(TEMP_DIR_BASE, { recursive: true });
    });

    afterEach(async () => {
        if (chopupInstance) {
            await chopupInstance.kill();
            await chopupInstance.cleanup();
            if (fsSync.existsSync(chopupInstance.socketPath)) {
                try {
                    fsSync.unlinkSync(chopupInstance.socketPath);
                } catch (e) { /* ignore */ }
            }
            chopupInstance = null;
        }
        if (fsSync.existsSync(TEMP_DIR_BASE)) {
            fsSync.rmSync(TEMP_DIR_BASE, { recursive: true, force: true });
        }
    });

    async function waitForInstructions(instance: ChopupTestInstance, expectedContent: string, timeout = 2000, interval = 100): Promise<string> {
        let elapsedTime = 0;
        while (elapsedTime < timeout) {
            const currentStdout = instance.stdout.join("");
            if (currentStdout.includes(expectedContent)) {
                return currentStdout;
            }
            await new Promise(r => setTimeout(r, interval));
            elapsedTime += interval;
        }
        return instance.stdout.join(""); // Return last known stdout if timeout
    }

    it("should print correct instructions by default", async () => {
        const targetScript = path.join(SCRIPTS_DIR, "simple-echo.js");
        chopupInstance = await spawnChopup(["run", "--", "node", targetScript]);

        const expectedInstructionsRaw = INSTRUCTIONS_TEMPLATE
            .replace(/{execName}/g, "chopup")
            .replace(/{socketPath}/g, chopupInstance.socketPath);
        const expectedOutput = `[chopup_wrapper] ${expectedInstructionsRaw}`;

        const fullStdout = await waitForInstructions(chopupInstance, expectedOutput.split("\n")[0]); // Wait for first line
        expect(fullStdout).toContain(expectedOutput);
    }, 15000);

    it("should print correct instructions with CHOPUP_EXEC_NAME set", async () => {
        const targetScript = path.join(SCRIPTS_DIR, "simple-echo.js");
        const customExecName = "my-custom-chopup";
        chopupInstance = await spawnChopup(
            ["run", "--", "node", targetScript],
            10000,
            { CHOPUP_EXEC_NAME: customExecName }
        );

        const expectedInstructionsRaw = INSTRUCTIONS_TEMPLATE
            .replace(/{execName}/g, customExecName)
            .replace(/{socketPath}/g, chopupInstance.socketPath);
        const expectedOutput = `[chopup_wrapper] ${expectedInstructionsRaw}`;

        const fullStdout = await waitForInstructions(chopupInstance, expectedOutput.split("\n")[0]); // Wait for first line
        expect(fullStdout).toContain(expectedOutput);
    }, 15000);

    it("should NOT print instructions if CHOPUP_TEST_MODE is true", async () => {
        const targetScript = path.join(SCRIPTS_DIR, "simple-echo.js");
        chopupInstance = await spawnChopup(
            ["run", "--", "node", targetScript],
            10000,
            { CHOPUP_TEST_MODE: "true" }
        );
        const fullStdout = chopupInstance.stdout.join("");

        const unexpectedInstructionsPattern = "--- Chopup Control ---";

        expect(fullStdout).not.toContain(unexpectedInstructionsPattern);
    }, 15000);
}); 