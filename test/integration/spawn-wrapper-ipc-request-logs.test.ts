import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import treeKill from 'tree-kill';
import net from 'node:net';

const BASE_DIR = path.resolve(__dirname, '../../');
const TEST_DIR = path.join(BASE_DIR, 'tmp/ipc-tests');
const LOG_DIR = path.join(BASE_DIR, 'tmp/advanced_test_logs');
const PID_FILE = path.join(TEST_DIR, 'ipc-test.pid');
const META_FILE = path.join(TEST_DIR, 'ipc-test.pid.meta.json');
const LOG_PREFIX = 'ipc_test_';
const WATCH_FILE = path.join(TEST_DIR, 'dummy.txt');
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
            const pid = parseInt(parts[1], 10);
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

describe('chopup IPC request-logs integration', () => {
    let child: ReturnType<typeof spawn> | null = null;
    let childPGID: number | null = null;
    let logFilesBefore: string[] = [];

    beforeAll(async () => {
        await fs.mkdir(LOG_DIR, { recursive: true });
        await fs.mkdir(TEST_DIR, { recursive: true });
        // Clean up previous files
        logFilesBefore = await fs.readdir(LOG_DIR);
        for (const f of logFilesBefore) {
            if (f.startsWith(LOG_PREFIX)) await fs.unlink(path.join(LOG_DIR, f));
        }
        await Promise.all([
            fs.rm(PID_FILE, { force: true }),
            fs.rm(META_FILE, { force: true }),
            fs.rm(WATCH_FILE, { force: true }),
        ]);
        await fs.writeFile(WATCH_FILE, 'initial\n');
    });

    afterAll(async () => {
        if (child && child.pid) {
            await new Promise((resolve) => {
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
            });
        }
        // Clean up
        await Promise.all([
            fs.rm(PID_FILE, { force: true }),
            fs.rm(META_FILE, { force: true }),
            fs.rm(WATCH_FILE, { force: true }),
        ]);
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

    it('should create log files on IPC request-logs', async () => {
        // Log the full spawn command and cwd
        // eslint-disable-next-line no-console
        console.log('[TEST] Spawning:', 'pnpm exec tsx src/index.ts wrap', '--watch', WATCH_FILE, '--log-dir', LOG_DIR, '--log-prefix', LOG_PREFIX, '--pid-file', PID_FILE, '--', 'node', LOGGER_SCRIPT);
        // eslint-disable-next-line no-console
        console.log('[TEST] CWD:', BASE_DIR);
        const wrapperLogPath = path.join(LOG_DIR, 'test_wrapper_stdout.log');
        const wrapperLog = await fs.open(wrapperLogPath, 'w');
        // Start chopup with logger
        child = spawn('pnpm', [
            'exec', 'tsx', 'src/index.ts',
            'wrap',
            '--watch', WATCH_FILE,
            '--log-dir', LOG_DIR,
            '--log-prefix', LOG_PREFIX,
            '--pid-file', PID_FILE,
            '--',
            'node', LOGGER_SCRIPT,
        ], {
            cwd: BASE_DIR,
            stdio: ['ignore', wrapperLog.fd, wrapperLog.fd],
            detached: true,
        });
        childPGID = child.pid || null;
        // Check if process is running
        if (!child.pid) {
            throw new Error('[TEST] Spawned process has no PID!');
        }

        // Wait for meta file
        let metaTries = 0;
        const maxTries = 40;
        while (metaTries < maxTries) {
            try {
                await fs.access(META_FILE);
                break;
            } catch {
                // eslint-disable-next-line no-console
                console.log(`[TEST] Waiting for meta file... attempt ${metaTries + 1}/${maxTries}`);
                await wait(500);
                metaTries++;
            }
        }
        // Print directory contents for debugging
        // eslint-disable-next-line no-console
        console.log('[TEST] Contents of TEST_DIR:', await fs.readdir(TEST_DIR));
        // eslint-disable-next-line no-console
        console.log('[TEST] Contents of LOG_DIR:', await fs.readdir(LOG_DIR));
        // Print meta file contents
        try {
            const metaContent = await fs.readFile(META_FILE, 'utf8');
            // eslint-disable-next-line no-console
            console.log('[TEST] META_FILE contents:', metaContent);
            const meta = JSON.parse(metaContent);
            // Wait for the IPC server to be listening
            await new Promise((resolve, reject) => {
                const socket = net.createConnection({ port: meta.ipcPort, host: 'localhost' }, () => {
                    socket.end();
                    resolve(undefined);
                });
                socket.on('error', (err) => {
                    // eslint-disable-next-line no-console
                    console.log('[TEST] Waiting for IPC server to be ready...', err.message);
                    setTimeout(() => {
                        socket.destroy();
                        reject(err);
                    }, 500);
                });
            });
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[TEST] Could not read or parse META_FILE:', e);
        }
        if (metaTries >= maxTries) {
            // eslint-disable-next-line no-console
            console.error('[TEST] META_FILE not found, printing wrapper log:');
            try {
                const wrapperLog = await fs.readFile(path.join(LOG_DIR, 'spawn_wrapper_meta.log'), 'utf8');
                // eslint-disable-next-line no-console
                console.error(wrapperLog);
            } catch (e) {
                // eslint-disable-next-line no-console
                console.error('[TEST] Could not read wrapper log:', e);
            }
        }
        expect(metaTries).toBeLessThan(maxTries);

        // Wait for logger to generate logs
        await wait(2000);

        // First log request
        const firstLogPath = await new Promise<string>((resolve, reject) => {
            const req = spawn('pnpm', [
                'exec', 'tsx', 'src/index.ts',
                'request-logs', '--meta-file', META_FILE,
            ], {
                cwd: BASE_DIR,
                stdio: ['ignore', 'pipe', 'inherit'],
            });
            let output = '';
            req.stdout.on('data', (data) => {
                output += data.toString();
            });
            req.on('close', () => {
                const match = output.match(/New log file created by primary instance: (.*)/);
                if (match) resolve(match[1].trim());
                else {
                    // eslint-disable-next-line no-console
                    console.error('[TEST] Full output from request-logs:', output);
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
                'request-logs', '--meta-file', META_FILE,
            ], {
                cwd: BASE_DIR,
                stdio: ['ignore', 'pipe', 'inherit'],
            });
            let output = '';
            req.stdout.on('data', (data) => {
                output += data.toString();
            });
            req.on('close', () => {
                const match = output.match(/New log file created by primary instance: (.*)/);
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