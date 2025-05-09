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
const TEST_APP_DIR = node_path_1.default.resolve(__dirname, '../../tmp/nextjs-test-app');
const LOG_DIR = node_path_1.default.resolve(__dirname, '../../tmp/advanced_test_logs');
const WATCH_PATH = node_path_1.default.join(TEST_APP_DIR, 'src/app/page.tsx');
const LOG_PREFIX = 'next_dev_test_';
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
(0, vitest_1.describe)('chopup integration: next dev server', () => {
    let child = null;
    let logFilesBefore = [];
    (0, vitest_1.beforeAll)(() => __awaiter(void 0, void 0, void 0, function* () {
        // Ensure log dir exists and is clean
        yield promises_1.default.mkdir(LOG_DIR, { recursive: true });
        logFilesBefore = yield promises_1.default.readdir(LOG_DIR);
    }));
    (0, vitest_1.afterAll)(() => __awaiter(void 0, void 0, void 0, function* () {
        if (child && !child.killed)
            child.kill('SIGKILL');
        // Clean up: remove new log files
        const logFilesAfter = yield promises_1.default.readdir(LOG_DIR);
        const newFiles = logFilesAfter.filter(f => !logFilesBefore.includes(f));
        for (const file of newFiles) {
            yield promises_1.default.unlink(node_path_1.default.join(LOG_DIR, file));
        }
    }));
    (0, vitest_1.it)('should chop logs when watched file changes', () => __awaiter(void 0, void 0, void 0, function* () {
        // Start chopup wrapping next dev
        child = (0, node_child_process_1.spawn)('pnpm', [
            'exec', 'tsx', 'src/index.ts',
            '--watch', WATCH_PATH,
            '--log-dir', LOG_DIR,
            '--log-prefix', LOG_PREFIX,
            '--',
            'next', 'dev',
        ], {
            cwd: node_path_1.default.resolve(__dirname, '../../'),
            stdio: 'inherit',
        });
        // Wait for dev server to start
        yield wait(10000); // 10s for Next.js to boot
        // Touch the watched file to trigger log chop
        const now = new Date();
        yield promises_1.default.utimes(WATCH_PATH, now, now);
        // Wait for debounce and log chop
        yield wait(5000);
        // Check for new log file
        const logFiles = yield promises_1.default.readdir(LOG_DIR);
        const newLogFiles = logFiles.filter(f => f.startsWith(LOG_PREFIX) && !logFilesBefore.includes(f));
        (0, vitest_1.expect)(newLogFiles.length).toBeGreaterThan(0);
    }), 30000);
    (0, vitest_1.it)('should chop logs when watched file changes (root passthrough)', () => __awaiter(void 0, void 0, void 0, function* () {
        // Start chopup as built CLI, passthrough mode
        child = (0, node_child_process_1.spawn)('node', [
            'dist/index.js',
            '--watch', WATCH_PATH,
            '--log-dir', LOG_DIR,
            '--log-prefix', LOG_PREFIX,
            'pnpm', 'dev',
        ], {
            cwd: node_path_1.default.resolve(__dirname, '../../'),
            stdio: 'inherit',
        });
        // Wait for dev server to start
        yield wait(10000); // 10s for Next.js to boot
        // Touch the watched file to trigger log chop
        const now = new Date();
        yield promises_1.default.utimes(WATCH_PATH, now, now);
        // Wait for debounce and log chop
        yield wait(5000);
        // Check for new log file
        const logFiles = yield promises_1.default.readdir(LOG_DIR);
        const newLogFiles = logFiles.filter(f => f.startsWith(LOG_PREFIX) && !logFilesBefore.includes(f));
        (0, vitest_1.expect)(newLogFiles.length).toBeGreaterThan(0);
    }), 30000);
});
