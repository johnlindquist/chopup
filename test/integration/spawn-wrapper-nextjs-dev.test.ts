import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import fsSync from 'node:fs';

const TEST_APP_DIR = path.resolve(__dirname, '../../tmp/nextjs-test-app');
const LOG_DIR = path.resolve(__dirname, '../../tmp/advanced_test_logs');
const LOG_PREFIX = 'next_dev_test_';

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSocket(socketPath: string, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (fsSync.existsSync(socketPath)) return;
        await wait(200);
    }
    throw new Error(`Timeout waiting for IPC socket: ${socketPath}`);
}

/**
 * EXTENDED/REAL-WORLD TEST: This test wraps a real Next.js dev server.
 * It is slow and may be flaky due to Next.js startup and output buffering.
 * Use for real-world coverage, not as a required smoke test.
 *
 * SKIPPED BY DEFAULT for reliability. Remove .skip to run manually.
 */
describe.skip('chopup EXTENDED integration: next dev server (IPC log chop)', () => {
    let child: ReturnType<typeof spawn> | null = null;
    let logFilesBefore: string[] = [];
    let chopupPid: number | null = null;

    beforeAll(async () => {
        // Ensure log dir exists and is clean
        await fs.mkdir(LOG_DIR, { recursive: true });
        logFilesBefore = await fs.readdir(LOG_DIR);
    });

    afterAll(async () => {
        if (child && !child.killed) child.kill('SIGKILL');
        // Clean up: remove new log files
        const logFilesAfter = await fs.readdir(LOG_DIR);
        const newFiles = logFilesAfter.filter(f => !logFilesBefore.includes(f));
        for (const file of newFiles) {
            await fs.unlink(path.join(LOG_DIR, file));
        }
    });

    it('should chop logs on IPC request (tsx dev)', async () => {
        let timeoutHandle: NodeJS.Timeout | null = null;
        let finished = false;
        const failOnTimeout = (done: () => void) => {
            if (finished) return;
            console.error('[TEST_TIMEOUT] Test exceeded 30s. Forcing cleanup and fail.');
            if (child && !child.killed) child.kill('SIGKILL');
            finished = true;
            done();
            throw new Error('Test timed out after 30s');
        };
        await new Promise<void>((resolve, reject) => {
            timeoutHandle = setTimeout(() => failOnTimeout(reject), 30000);
            (async () => {
                try {
                    // Start chopup wrapping next dev
                    child = spawn('pnpm', [
                        'exec', 'tsx', 'src/index.ts',
                        '--log-dir', LOG_DIR,
                        '--log-prefix', LOG_PREFIX,
                        '--',
                        'next', 'dev',
                    ], {
                        cwd: path.resolve(__dirname, '../../'),
                        stdio: ['ignore', 'pipe', 'inherit'],
                    });

                    // Parse PID and socket from chopup stdout (robust)
                    let stdoutData = '';
                    let foundPid = false;
                    let foundSocket = false;
                    let socketPath = '';
                    await new Promise<void>((resolve2, reject2) => {
                        const timeout = setTimeout(() => {
                            reject2(new Error(`Timeout waiting for PID and socket output. Output so far: ${stdoutData}`));
                        }, 20000);
                        if (!child || !child.stdout) {
                            reject2(new Error('Child process or stdout is not available.'));
                            return;
                        }
                        child.stdout.on('data', (data) => {
                            stdoutData += data.toString();
                            if (!foundPid) {
                                const match = stdoutData.match(/\[CHOPUP\] PID: (\d+)/);
                                if (match) {
                                    chopupPid = Number.parseInt(match[1], 10);
                                    foundPid = true;
                                }
                            }
                            if (foundPid && !foundSocket) {
                                const sockMatch = stdoutData.match(/\[CHOPUP\] IPC socket: (.+)/);
                                if (sockMatch) {
                                    socketPath = sockMatch[1];
                                    foundSocket = true;
                                    clearTimeout(timeout);
                                    resolve2();
                                }
                            }
                        });
                    });
                    if (!foundSocket) {
                        // Wait up to 5 more seconds for the socket line
                        const start = Date.now();
                        while (!foundSocket && Date.now() - start < 5000) {
                            await wait(100);
                            const sockMatch = stdoutData.match(/\[CHOPUP\] IPC socket: (.+)/);
                            if (sockMatch) {
                                socketPath = sockMatch[1];
                                foundSocket = true;
                            }
                        }
                    }
                    if (!foundSocket) {
                        // Print all output for debugging
                        throw new Error(`Did not find IPC socket line in output. Output so far: ${stdoutData}`);
                    }
                    expect(chopupPid).toBeGreaterThan(0);
                    expect(socketPath).toMatch(/chopup_\d+\.sock/);

                    // Wait for dev server to start
                    await wait(10000); // 10s for Next.js to boot

                    // Wait for socket to exist
                    await waitForSocket(socketPath);

                    // First log chop request
                    const firstLogPath = await new Promise<string>((resolve3, reject3) => {
                        const req = spawn('pnpm', [
                            'exec', 'tsx', 'src/index.ts',
                            '--pid', String(chopupPid),
                        ], {
                            cwd: path.resolve(__dirname, '../../'),
                            stdio: ['ignore', 'pipe', 'inherit'],
                        });
                        let output = '';
                        req.stdout.on('data', (data) => {
                            output += data.toString();
                        });
                        req.on('close', () => {
                            const match = output.match(/New log file created: (.*)/);
                            if (match) resolve3(match[1].trim());
                            else reject3(new Error(`No log file path in output: ${output}`));
                        });
                    });
                    const firstLogExists = await fs.access(firstLogPath).then(() => true, () => false);
                    expect(firstLogExists).toBe(true);
                    const firstLogLines = (await fs.readFile(firstLogPath, 'utf8')).split('\n').filter(Boolean).length;
                    expect(firstLogLines).toBeGreaterThan(0);
                    finished = true;
                    if (timeoutHandle) clearTimeout(timeoutHandle);
                    resolve();
                } catch (err) {
                    finished = true;
                    if (timeoutHandle) clearTimeout(timeoutHandle);
                    reject(err);
                }
            })();
        });
    }, 60000);

    it('should chop logs on IPC request (built CLI passthrough)', async () => {
        let timeoutHandle: NodeJS.Timeout | null = null;
        let finished = false;
        const failOnTimeout = (done: () => void) => {
            if (finished) return;
            console.error('[TEST_TIMEOUT] Test exceeded 30s. Forcing cleanup and fail.');
            if (child && !child.killed) child.kill('SIGKILL');
            finished = true;
            done();
            throw new Error('Test timed out after 30s');
        };
        await new Promise<void>((resolve, reject) => {
            timeoutHandle = setTimeout(() => failOnTimeout(reject), 30000);
            (async () => {
                try {
                    // Start chopup as built CLI, passthrough mode
                    child = spawn('node', [
                        'dist/index.js',
                        '--log-dir', LOG_DIR,
                        '--log-prefix', LOG_PREFIX,
                        'pnpm', 'dev',
                    ], {
                        cwd: path.resolve(__dirname, '../../'),
                        stdio: ['ignore', 'pipe', 'inherit'],
                    });

                    // Parse PID and socket from chopup stdout (robust)
                    let stdoutData = '';
                    let foundPid = false;
                    let foundSocket = false;
                    let socketPath = '';
                    await new Promise<void>((resolve2, reject2) => {
                        const timeout = setTimeout(() => {
                            reject2(new Error(`Timeout waiting for PID and socket output. Output so far: ${stdoutData}`));
                        }, 20000);
                        if (!child || !child.stdout) {
                            reject2(new Error('Child process or stdout is not available.'));
                            return;
                        }
                        child.stdout.on('data', (data) => {
                            stdoutData += data.toString();
                            if (!foundPid) {
                                const match = stdoutData.match(/\[CHOPUP\] PID: (\d+)/);
                                if (match) {
                                    chopupPid = Number.parseInt(match[1], 10);
                                    foundPid = true;
                                }
                            }
                            if (foundPid && !foundSocket) {
                                const sockMatch = stdoutData.match(/\[CHOPUP\] IPC socket: (.+)/);
                                if (sockMatch) {
                                    socketPath = sockMatch[1];
                                    foundSocket = true;
                                    clearTimeout(timeout);
                                    resolve2();
                                }
                            }
                        });
                    });
                    if (!foundSocket) {
                        // Wait up to 5 more seconds for the socket line
                        const start = Date.now();
                        while (!foundSocket && Date.now() - start < 5000) {
                            await wait(100);
                            const sockMatch = stdoutData.match(/\[CHOPUP\] IPC socket: (.+)/);
                            if (sockMatch) {
                                socketPath = sockMatch[1];
                                foundSocket = true;
                            }
                        }
                    }
                    if (!foundSocket) {
                        // Print all output for debugging
                        throw new Error(`Did not find IPC socket line in output. Output so far: ${stdoutData}`);
                    }
                    expect(chopupPid).toBeGreaterThan(0);
                    expect(socketPath).toMatch(/chopup_\d+\.sock/);

                    // Wait for dev server to start
                    await wait(10000); // 10s for Next.js to boot

                    // Wait for socket to exist
                    await waitForSocket(socketPath);

                    // Log chop request
                    const logPath = await new Promise<string>((resolve3, reject3) => {
                        const req = spawn('node', [
                            'dist/index.js',
                            '--pid', String(chopupPid),
                        ], {
                            cwd: path.resolve(__dirname, '../../'),
                            stdio: ['ignore', 'pipe', 'inherit'],
                        });
                        let output = '';
                        req.stdout.on('data', (data) => {
                            output += data.toString();
                        });
                        req.on('close', () => {
                            const match = output.match(/New log file created: (.*)/);
                            if (match) resolve3(match[1].trim());
                            else reject3(new Error(`No log file path in output: ${output}`));
                        });
                    });
                    const logExists = await fs.access(logPath).then(() => true, () => false);
                    expect(logExists).toBe(true);
                    const logLines = (await fs.readFile(logPath, 'utf8')).split('\n').filter(Boolean).length;
                    expect(logLines).toBeGreaterThan(0);
                    finished = true;
                    if (timeoutHandle) clearTimeout(timeoutHandle);
                    resolve();
                } catch (err) {
                    finished = true;
                    if (timeoutHandle) clearTimeout(timeoutHandle);
                    reject(err);
                }
            })();
        });
    }, 60000);
}); 