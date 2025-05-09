import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const TEST_APP_DIR = path.resolve(__dirname, '../../tmp/nextjs-test-app');
const LOG_DIR = path.resolve(__dirname, '../../tmp/advanced_test_logs');
const WATCH_PATH = path.join(TEST_APP_DIR, 'src/app/page.tsx');
const LOG_PREFIX = 'next_dev_test_';

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('chopup integration: next dev server', () => {
    let child: ReturnType<typeof spawn> | null = null;
    let logFilesBefore: string[] = [];

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

    it('should chop logs when watched file changes', async () => {
        // Start chopup wrapping next dev
        child = spawn('pnpm', [
            'exec', 'tsx', 'src/index.ts',
            '--watch', WATCH_PATH,
            '--log-dir', LOG_DIR,
            '--log-prefix', LOG_PREFIX,
            '--',
            'next', 'dev',
        ], {
            cwd: path.resolve(__dirname, '../../'),
            stdio: 'inherit',
        });

        // Wait for dev server to start
        await wait(10000); // 10s for Next.js to boot

        // Touch the watched file to trigger log chop
        const now = new Date();
        await fs.utimes(WATCH_PATH, now, now);

        // Wait for debounce and log chop
        await wait(5000);

        // Check for new log file
        const logFiles = await fs.readdir(LOG_DIR);
        const newLogFiles = logFiles.filter(f => f.startsWith(LOG_PREFIX) && !logFilesBefore.includes(f));
        expect(newLogFiles.length).toBeGreaterThan(0);
    }, 30000);

    it('should chop logs when watched file changes (root passthrough)', async () => {
        // Start chopup as built CLI, passthrough mode
        child = spawn('node', [
            'dist/index.js',
            '--watch', WATCH_PATH,
            '--log-dir', LOG_DIR,
            '--log-prefix', LOG_PREFIX,
            'pnpm', 'dev',
        ], {
            cwd: path.resolve(__dirname, '../../'),
            stdio: 'inherit',
        });

        // Wait for dev server to start
        await wait(10000); // 10s for Next.js to boot

        // Touch the watched file to trigger log chop
        const now = new Date();
        await fs.utimes(WATCH_PATH, now, now);

        // Wait for debounce and log chop
        await wait(5000);

        // Check for new log file
        const logFiles = await fs.readdir(LOG_DIR);
        const newLogFiles = logFiles.filter(f => f.startsWith(LOG_PREFIX) && !logFilesBefore.includes(f));
        expect(newLogFiles.length).toBeGreaterThan(0);
    }, 30000);
}); 