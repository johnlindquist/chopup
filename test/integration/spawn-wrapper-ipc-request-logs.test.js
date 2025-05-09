"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_child_process_1 = require("node:child_process");
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const tree_kill_1 = __importDefault(require("tree-kill"));
const node_net_1 = __importDefault(require("node:net"));
const BASE_DIR = node_path_1.default.resolve(__dirname, '../../');
const TEST_DIR = node_path_1.default.join(BASE_DIR, 'tmp/ipc-tests');
const LOG_DIR = node_path_1.default.join(BASE_DIR, 'tmp/advanced_test_logs');
const PID_FILE = node_path_1.default.join(TEST_DIR, 'ipc-test.pid');
const META_FILE = node_path_1.default.join(TEST_DIR, 'ipc-test.pid.meta.json');
const LOG_PREFIX = 'ipc_test_';
const WATCH_FILE = node_path_1.default.join(TEST_DIR, 'dummy.txt');
const LOGGER_SCRIPT = node_path_1.default.join(TEST_DIR, 'continuous-logger.js');
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function killAllSpawnWrapperProcesses() {
    try {
        const output = (0, node_child_process_1.execSync)("ps aux | grep '[t]sx src/index.ts' || true", { encoding: 'utf8' });
        const lines = output.split('\n').filter(Boolean);
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[1], 10);
            if (!isNaN(pid)) {
                try {
                    process.kill(pid, 'SIGKILL');
                    // eslint-disable-next-line no-console
                    console.log(`[TEST] Killed leftover chopup process PID ${pid}`);
                }
                catch (e) {
                    // eslint-disable-next-line no-console
                    console.error(`[TEST] Failed to kill PID ${pid}:`, e);
                }
            }
        }
    }
    catch (e) {
        // eslint-disable-next-line no-console
        console.error('[TEST] Error sweeping for leftover processes:', e);
    }
}
(0, vitest_1.describe)('chopup IPC request-logs integration', () => {
    let child = null;
    let childPGID = null;
    let logFilesBefore = [];
    (0, vitest_1.beforeAll)(() => __awaiter(void 0, void 0, void 0, function* () {
        yield promises_1.default.mkdir(LOG_DIR, { recursive: true });
        yield promises_1.default.mkdir(TEST_DIR, { recursive: true });
        // Clean up previous files
        logFilesBefore = yield promises_1.default.readdir(LOG_DIR);
        for (const f of logFilesBefore) {
            if (f.startsWith(LOG_PREFIX))
                yield promises_1.default.unlink(node_path_1.default.join(LOG_DIR, f));
        }
        yield Promise.all([
            promises_1.default.rm(PID_FILE, { force: true }),
            promises_1.default.rm(META_FILE, { force: true }),
            promises_1.default.rm(WATCH_FILE, { force: true }),
        ]);
        yield promises_1.default.writeFile(WATCH_FILE, 'initial\n');
    }));
    (0, vitest_1.afterAll)(() => __awaiter(void 0, void 0, void 0, function* () {
        if (child && child.pid) {
            yield new Promise((resolve) => {
                (0, tree_kill_1.default)(child.pid, 'SIGKILL', (err) => {
                    if (err) {
                        // eslint-disable-next-line no-console
                        console.error('[TEST] Error killing process tree:', err);
                    }
                    else {
                        // eslint-disable-next-line no-console
                        console.log(`[TEST] Killed process tree for PID ${child.pid}`);
                    }
                    resolve(undefined);
                });
            });
        }
        // Clean up
        yield Promise.all([
            promises_1.default.rm(PID_FILE, { force: true }),
            promises_1.default.rm(META_FILE, { force: true }),
            promises_1.default.rm(WATCH_FILE, { force: true }),
        ]);
        const logFilesAfter = yield promises_1.default.readdir(LOG_DIR);
        for (const f of logFilesAfter) {
            if (f.startsWith(LOG_PREFIX))
                yield promises_1.default.unlink(node_path_1.default.join(LOG_DIR, f));
        }
    }));
    (0, vitest_1.afterEach)(() => {
        return new Promise((resolve) => {
            if (child && child.pid) {
                (0, tree_kill_1.default)(child.pid, 'SIGKILL', (err) => {
                    if (err) {
                        // eslint-disable-next-line no-console
                        console.error('[TEST] Error killing process tree:', err);
                    }
                    else {
                        // eslint-disable-next-line no-console
                        console.log(`[TEST] Killed process tree for PID ${child.pid}`);
                    }
                    resolve(undefined);
                });
            }
            else {
                resolve(undefined);
            }
        });
    });
    (0, vitest_1.it)('should create log files on IPC request-logs', () => __awaiter(void 0, void 0, void 0, function* () {
        // Log the full spawn command and cwd
        // eslint-disable-next-line no-console
        console.log('[TEST] Spawning:', 'pnpm exec tsx src/index.ts wrap', '--watch', WATCH_FILE, '--log-dir', LOG_DIR, '--log-prefix', LOG_PREFIX, '--pid-file', PID_FILE, '--', 'node', LOGGER_SCRIPT);
        // eslint-disable-next-line no-console
        console.log('[TEST] CWD:', BASE_DIR);
        const wrapperLogPath = node_path_1.default.join(LOG_DIR, 'test_wrapper_stdout.log');
        const wrapperLog = yield promises_1.default.open(wrapperLogPath, 'w');
        // Start chopup with logger
        child = (0, node_child_process_1.spawn)('pnpm', [
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
                yield promises_1.default.access(META_FILE);
                break;
            }
            catch (_a) {
                // eslint-disable-next-line no-console
                console.log(`[TEST] Waiting for meta file... attempt ${metaTries + 1}/${maxTries}`);
                yield wait(500);
                metaTries++;
            }
        }
        // Print directory contents for debugging
        // eslint-disable-next-line no-console
        console.log('[TEST] Contents of TEST_DIR:', yield promises_1.default.readdir(TEST_DIR));
        // eslint-disable-next-line no-console
        console.log('[TEST] Contents of LOG_DIR:', yield promises_1.default.readdir(LOG_DIR));
        // Print meta file contents
        try {
            const metaContent = yield promises_1.default.readFile(META_FILE, 'utf8');
            // eslint-disable-next-line no-console
            console.log('[TEST] META_FILE contents:', metaContent);
            const meta = JSON.parse(metaContent);
            // Wait for the IPC server to be listening
            yield new Promise((resolve, reject) => {
                const socket = node_net_1.default.createConnection({ port: meta.ipcPort, host: 'localhost' }, () => {
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
        }
        catch (e) {
            // eslint-disable-next-line no-console
            console.error('[TEST] Could not read or parse META_FILE:', e);
        }
        if (metaTries >= maxTries) {
            // eslint-disable-next-line no-console
            console.error('[TEST] META_FILE not found, printing wrapper log:');
            try {
                const wrapperLog = yield promises_1.default.readFile(node_path_1.default.join(LOG_DIR, 'spawn_wrapper_meta.log'), 'utf8');
                // eslint-disable-next-line no-console
                console.error(wrapperLog);
            }
            catch (e) {
                // eslint-disable-next-line no-console
                console.error('[TEST] Could not read wrapper log:', e);
            }
        }
        (0, vitest_1.expect)(metaTries).toBeLessThan(maxTries);
        // Wait for logger to generate logs
        yield wait(2000);
        // First log request
        const firstLogPath = yield new Promise((resolve, reject) => {
            const req = (0, node_child_process_1.spawn)('pnpm', [
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
                if (match)
                    resolve(match[1].trim());
                else {
                    // eslint-disable-next-line no-console
                    console.error('[TEST] Full output from request-logs:', output);
                    reject(new Error('No log file path in output: ' + output));
                }
            });
        });
        const firstLogExists = yield promises_1.default.access(firstLogPath).then(() => true, () => false);
        (0, vitest_1.expect)(firstLogExists).toBe(true);
        const firstLogLines = (yield promises_1.default.readFile(firstLogPath, 'utf8')).split('\n').filter(Boolean).length;
        (0, vitest_1.expect)(firstLogLines).toBeGreaterThan(0);
        // Wait for more logs
        yield wait(3000);
        // Second log request
        const secondLogPath = yield new Promise((resolve, reject) => {
            const req = (0, node_child_process_1.spawn)('pnpm', [
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
                if (match)
                    resolve(match[1].trim());
                else
                    reject(new Error('No log file path in output: ' + output));
            });
        });
        (0, vitest_1.expect)(secondLogPath).not.toBe(firstLogPath);
        const secondLogExists = yield promises_1.default.access(secondLogPath).then(() => true, () => false);
        (0, vitest_1.expect)(secondLogExists).toBe(true);
        const secondLogLines = (yield promises_1.default.readFile(secondLogPath, 'utf8')).split('\n').filter(Boolean).length;
        (0, vitest_1.expect)(secondLogLines).toBeGreaterThan(0);
    }), 40000);
});
