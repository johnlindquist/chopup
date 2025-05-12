import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import treeKill from 'tree-kill'; // For cleanup

const CHOPUP_DIST_PATH = path.resolve(__dirname, '../../dist/index.js');
const TMP_DIR_INTEGRATION = path.resolve(__dirname, '../../tmp/integration');
const SCRIPTS_DIR = path.join(__dirname, '../input-tests/fixtures/scripts');

interface ChopupTestInstance {
    process: ChildProcessWithoutNullStreams;
    socketPath?: string;
    logDir: string;
    stdout: string[];
    stderr: string[];
    pid: number;
    kill: () => Promise<void>;
}

// Helper to spawn the chopup CLI
async function spawnChopup(args: string[], timeoutMs = 5000): Promise<ChopupTestInstance> {
    return new Promise((resolve, reject) => {
        const logDir = path.join(TMP_DIR_INTEGRATION, `logs-${Date.now()}-${Math.random().toString(36).substring(7)}`);
        fsSync.mkdirSync(logDir, { recursive: true });

        const fullArgs = [...args, '--log-dir', logDir];
        const proc = spawn('node', [CHOPUP_DIST_PATH, ...fullArgs], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, CHOPUP_SUPPRESS_SOCKET_PATH_LOG: 'true' }, // Suppress direct log for cleaner test output
        });

        let socketPath: string | undefined;
        const stdoutData: string[] = [];
        const stderrData: string[] = [];
        let resolved = false;

        const timer = setTimeout(() => {
            if (!resolved) {
                proc.kill();
                reject(new Error(`spawnChopup timed out after ${timeoutMs}ms for command: node ${CHOPUP_DIST_PATH} ${fullArgs.join(' ')}`));
            }
        }, timeoutMs);

        proc.stdout.on('data', (data) => {
            const line = data.toString();
            stdoutData.push(line);
            // Standard CHOPUP_SOCKET_PATH printed by the wrapper itself
            const match = line.match(/CHOPUP_SOCKET_PATH=(.*)/);
            if (match?.[1]) {
                socketPath = match[1].trim();
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    resolve({
                        process: proc,
                        socketPath,
                        logDir,
                        stdout: stdoutData,
                        stderr: stderrData,
                        pid: proc.pid ?? -1, // Use nullish coalescing
                        kill: () => new Promise<void>((res, rej) => {
                            if (proc.pid) {
                                treeKill(proc.pid, (err) => err ? rej(err) : res())
                            } else {
                                res(); // Already dead
                            }
                        }),
                    });
                }
            }
        });

        proc.stderr.on('data', (data) => {
            stderrData.push(data.toString());
            // console.error(`Chopup stderr: ${data.toString()}`); // For debugging tests
        });

        proc.on('error', (err) => {
            if (!resolved) {
                clearTimeout(timer);
                resolved = true;
                reject(err);
            }
        });

        proc.on('exit', (code, signal) => {
            if (!resolved && socketPath) { // If exit happens quickly but after socket path was found
                resolved = true;
                clearTimeout(timer);
                resolve({
                    process: proc,
                    socketPath,
                    logDir,
                    stdout: stdoutData,
                    stderr: stderrData,
                    pid: proc.pid || -1, // PID might be null if already exited
                    kill: () => Promise.resolve(), // Already exited
                });
            } else if (!resolved) {
                clearTimeout(timer);
                resolved = true;
                reject(new Error(`Chopup process exited prematurely. Code: ${code}, Signal: ${signal}. Stderr: ${stderrData.join('')}`));
            }
        });
    });
}

describe('Chopup CLI Integration Tests', () => {
    beforeAll(async () => {
        await fs.mkdir(TMP_DIR_INTEGRATION, { recursive: true });
        // Compile chopup if dist doesn't exist or is outdated (simple check)
        if (!fsSync.existsSync(CHOPUP_DIST_PATH)) {
            console.log('dist/index.js not found, running pnpm build...');
            execSync('pnpm build', { stdio: 'inherit' });
        }
    });

    afterAll(async () => {
        // await fs.rm(TMP_DIR_INTEGRATION, { recursive: true, force: true });
        // console.log("Cleaned up integration tmp dir. Comment out above line to inspect logs.");
    });

    describe('run subcommand (default)', () => {
        it('should spawn a command, create a log directory, and start an IPC server', async () => {
            const instance = await spawnChopup(['run', '--', 'echo', 'hello world']);
            expect(instance.pid).toBeGreaterThan(0);
            expect(instance.socketPath).toBeDefined();
            expect(fsSync.existsSync(instance.logDir)).toBe(true);
            expect(fsSync.existsSync(instance.socketPath ?? '')).toBe(true); // Use nullish coalescing

            // Check for child process output eventually
            await new Promise(resolve => setTimeout(resolve, 200)); // Give time for echo to run
            const stdoutCombined = instance.stdout.join('');
            expect(stdoutCombined).toContain('hello world');

            await instance.kill();
            // Socket should be cleaned up by chopup itself on exit
            expect(fsSync.existsSync(instance.socketPath ?? '')).toBe(false); // Use nullish coalescing
        }, 10000);
    });

    describe('request-logs CLI command', () => {
        it('should request logs from a running chopup instance and create a log chop file', async () => {
            const targetScript = path.join(SCRIPTS_DIR, 'continuous-output.js');
            const instance = await spawnChopup(['run', '--', 'node', targetScript]);

            await new Promise(resolve => setTimeout(resolve, 1000)); // Let it produce some logs

            execSync(`node ${CHOPUP_DIST_PATH} request-logs --socket ${instance.socketPath}`);

            await new Promise(resolve => setTimeout(resolve, 500)); // Give time for chop to complete

            const logFiles = await fs.readdir(instance.logDir);
            expect(logFiles.some(file => file.includes('_log'))).toBe(true);

            await instance.kill();
        }, 15000);
    });

    describe('send-input CLI command', () => {
        it('should send input to the wrapped process via CLI', async () => {
            const targetScript = path.join(SCRIPTS_DIR, 'stdin-echo.js');
            const instance = await spawnChopup(['run', '--', 'node', targetScript]);
            const testInput = "hello from integration test";

            execSync(`node ${CHOPUP_DIST_PATH} send-input --socket ${instance.socketPath} --input "${testInput}"`);

            await new Promise(resolve => setTimeout(resolve, 1000)); // Give time for input to be processed and echoed

            const stdoutCombined = instance.stdout.join('');
            expect(stdoutCombined).toContain(`ECHOED: ${testInput}`);

            await instance.kill();
        }, 15000);
    });
}); 