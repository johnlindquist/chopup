import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import treeKill from 'tree-kill';

const BASE_DIR = path.resolve(__dirname, '../../');
const TEST_DIR = path.join(BASE_DIR, 'tmp/ipc-tests');
const LOG_DIR = path.join(BASE_DIR, 'tmp/advanced_test_logs');
const LOG_PREFIX = 'ipc_test_';
const LOGGER_SCRIPT = path.join(TEST_DIR, 'continuous-logger.js');

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function killAllSpawnWrapperProcesses() {
    try {
        const output = execSync("ps aux | grep '[t]sx src/index.ts' || true", { encoding: 'utf8' });
        const lines = output.split('\n').filter(Boolean);
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            const pid = Number.parseInt(parts[1], 10);
            if (!isNaN(pid)) {
                try {
                    process.kill(pid, 'SIGKILL');
                    // eslint-disable-next-line no-console
                    console.log(`[TEST] Killed leftover chopup process PID ${pid}`);
                } catch (e) {
                    // eslint-disable-next-line no-console
                    console.error(`[TEST] Failed to kill PID ${pid}:`, e);
                }
            }
        }
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[TEST] Error sweeping for leftover processes:', e);
    }
}

describe('chopup IPC log chop integration', () => {
    let child: ReturnType<typeof spawn> | null = null;
    let childPGID: number | null = null;
    let logFilesBefore: string[] = [];
    let chopupPid: number | null = null;
    let wrapperLogPath: string;
    let wrapperLog: any;

    beforeAll(async () => {
        await fs.mkdir(LOG_DIR, { recursive: true });
        await fs.mkdir(TEST_DIR, { recursive: true });
        // Clean up previous files
        logFilesBefore = await fs.readdir(LOG_DIR);
        for (const f of logFilesBefore) {
            if (f.startsWith(LOG_PREFIX)) await fs.unlink(path.join(LOG_DIR, f));
        }
    });

    afterAll(async () => {
        if (child && child.pid) {
            await new Promise((resolve) => {
                treeKill(child.pid!, 'SIGKILL', (err) => {
                    if (err) {
                        // eslint-disable-next-line no-console
                        console.error('[TEST] Error killing process tree:', err);
                    } else {
                        // eslint-disable-next-line no-console
                        console.log(`[TEST] Killed process tree for PID ${child!.pid}`);
                    }
                    resolve(undefined);
                });
            });
        }
        // Clean up
        const logFilesAfter = await fs.readdir(LOG_DIR);
        for (const f of logFilesAfter) {
            if (f.startsWith(LOG_PREFIX)) await fs.unlink(path.join(LOG_DIR, f));
        }
    });

    afterEach(() => {
        return new Promise((resolve) => {
            if (child && child.pid) {
                treeKill(child.pid, 'SIGKILL', (err) => {
                    if (err) {
                        // eslint-disable-next-line no-console
                        console.error('[TEST] Error killing process tree:', err);
                    } else {
                        // eslint-disable-next-line no-console
                        console.log(`[TEST] Killed process tree for PID ${child.pid}`);
                    }
                    resolve(undefined);
                });
            } else {
                resolve(undefined);
            }
        });
    });

    it('should create log files on IPC chop request', async () => {
        // Start chopup with logger
        wrapperLogPath = path.join(LOG_DIR, 'test_wrapper_stdout.log');
        wrapperLog = await fs.open(wrapperLogPath, 'w');
        child = spawn('pnpm', [
            'exec', 'tsx', 'src/index.ts',
            '--log-dir', LOG_DIR,
            '--log-prefix', LOG_PREFIX,
            '--',
            'node', LOGGER_SCRIPT,
        ], {
            cwd: BASE_DIR,
            stdio: ['ignore', 'pipe', wrapperLog.fd],
            detached: true,
        });
        childPGID = child.pid || null;
        if (!child.pid) throw new Error('[TEST] Spawned process has no PID!');

        // Parse PID from chopup stdout
        let stdoutData = '';
        await new Promise<void>((resolve, reject) => {
            child!.stdout!.on('data', (data) => {
                stdoutData += data.toString();
                const match = stdoutData.match(/\[CHOPUP\] PID: (\d+)/);
                if (match) {
                    chopupPid = Number.parseInt(match[1], 10);
                    resolve();
                }
            });
            setTimeout(() => reject(new Error('Timeout waiting for PID output')), 10000);
        });
        expect(chopupPid).toBeGreaterThan(0);

        // Wait for logger to generate logs
        await wait(2000);

        // First log request
        const firstLogPath = await new Promise<string>((resolve, reject) => {
            const req = spawn('pnpm', [
                'exec', 'tsx', 'src/index.ts',
                '--pid', String(chopupPid),
            ], {
                cwd: BASE_DIR,
                stdio: ['ignore', 'pipe', 'inherit'],
            });
            let output = '';
            req.stdout.on('data', (data) => {
                output += data.toString();
            });
            req.on('close', () => {
                const match = output.match(/New log file created: (.*)/);
                if (match) resolve(match[1].trim());
                else {
                    // eslint-disable-next-line no-console
                    console.error('[TEST] Full output from --pid:', output);
                    reject(new Error('No log file path in output: ' + output));
                }
            });
        });
        const firstLogExists = await fs.access(firstLogPath).then(() => true, () => false);
        expect(firstLogExists).toBe(true);
        const firstLogLines = (await fs.readFile(firstLogPath, 'utf8')).split('\n').filter(Boolean).length;
        expect(firstLogLines).toBeGreaterThan(0);

        // Wait for more logs
        await wait(3000);

        // Second log request
        const secondLogPath = await new Promise<string>((resolve, reject) => {
            const req = spawn('pnpm', [
                'exec', 'tsx', 'src/index.ts',
                '--pid', String(chopupPid),
            ], {
                cwd: BASE_DIR,
                stdio: ['ignore', 'pipe', 'inherit'],
            });
            let output = '';
            req.stdout.on('data', (data) => {
                output += data.toString();
            });
            req.on('close', () => {
                const match = output.match(/New log file created: (.*)/);
                if (match) resolve(match[1].trim());
                else reject(new Error('No log file path in output: ' + output));
            });
        });
        expect(secondLogPath).not.toBe(firstLogPath);
        const secondLogExists = await fs.access(secondLogPath).then(() => true, () => false);
        expect(secondLogExists).toBe(true);
        const secondLogLines = (await fs.readFile(secondLogPath, 'utf8')).split('\n').filter(Boolean).length;
        expect(secondLogLines).toBeGreaterThan(0);
    }, 40000);
}); 