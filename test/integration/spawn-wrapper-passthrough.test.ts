import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import fsSync from 'node:fs';

const LOG_DIR = path.resolve(__dirname, '../../tmp/passthrough_test_logs');
const LOG_PREFIX = 'passthrough_test_';

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSocket(socketPath: string, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (fsSync.existsSync(socketPath)) return;
        await wait(100);
    }
    throw new Error(`Timeout waiting for IPC socket: ${socketPath}`);
}

describe('chopup minimal passthrough integration', () => {
    let child: ReturnType<typeof spawn> | null = null;
    let logFilesBefore: string[] = [];
    let chopupPid: number | null = null;
    let socketPath = '';

    beforeAll(async () => {
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

    it('should chop logs on IPC request (echo passthrough)', async () => {
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
                    // Start chopup wrapping a process that produces output for a few seconds
                    child = spawn('pnpm', [
                        'exec', 'tsx', 'src/index.ts',
                        '--log-dir', LOG_DIR,
                        '--log-prefix', LOG_PREFIX,
                        '--',
                        'sh', '-c', 'yes | head -n 10 && sleep 2',
                    ], {
                        cwd: path.resolve(__dirname, '../../'),
                        stdio: ['ignore', 'pipe', 'inherit'],
                    });

                    // Parse PID and socket from chopup stdout, and wait for at least one log line
                    let stdoutData = '';
                    let foundPid = false;
                    let foundSocket = false;
                    let sawLogLine = false;
                    await new Promise<void>((resolve2, reject2) => {
                        const timeout = setTimeout(() => {
                            reject2(new Error(`Timeout waiting for PID, socket, and log output. Output so far: ${stdoutData}`));
                        }, 10000);
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
                                }
                            }
                            if (stdoutData.match(/\[CHILD_STDOUT\]/)) {
                                sawLogLine = true;
                            }
                            if (foundPid && foundSocket && sawLogLine) {
                                clearTimeout(timeout);
                                resolve2();
                            }
                        });
                    });
                    if (!foundSocket) {
                        // Wait up to 2 more seconds for the socket line
                        const start = Date.now();
                        while (!foundSocket && Date.now() - start < 2000) {
                            await wait(100);
                            const sockMatch = stdoutData.match(/\[CHOPUP\] IPC socket: (.+)/);
                            if (sockMatch) {
                                socketPath = sockMatch[1];
                                foundSocket = true;
                            }
                        }
                    }
                    if (!foundSocket) {
                        throw new Error(`Did not find IPC socket line in output. Output so far: ${stdoutData}`);
                    }
                    expect(chopupPid).toBeGreaterThan(0);
                    expect(socketPath).toMatch(/chopup_\d+\.sock/);
                    expect(sawLogLine).toBe(true);

                    // Wait for socket to exist
                    await waitForSocket(socketPath);

                    // Log chop request
                    const logPath = await new Promise<string>((resolve3, reject3) => {
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
    }, 15000);
}); 