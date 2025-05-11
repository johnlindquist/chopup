import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fsSync from 'node:fs';
import { spawnChopupWithScript, TMP_DIR } from '../test-utils/input-helpers';
import type { ChopupInstance } from '../test-utils/input-helpers';
import fs from 'node:fs/promises';

const SCRIPT_NAME = 'echo-input.js';
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures/scripts');
const scriptPath = path.join(FIXTURES_DIR, SCRIPT_NAME);

const testRunId = `smoke_test_${Date.now()}`;
const baseLogDir = path.join(TMP_DIR, 'input-test-logs', testRunId);
const outputDir = path.join(baseLogDir, 'outputs');

describe('Input Sending Smoke Test', () => {
    let chopupInstance: ChopupInstance | null = null;

    beforeAll(async () => {
        console.log('[SMOKE_TEST] beforeAll: creating outputDir');
        await fs.mkdir(outputDir, { recursive: true });
        try {
            await fs.access(scriptPath, fs.constants.X_OK);
        } catch {
            await fs.chmod(scriptPath, '755');
        }
    });

    afterAll(async () => {
        console.log('[SMOKE_TEST] afterAll: cleaning up chopupInstance');
        if (chopupInstance) {
            await chopupInstance.cleanup();
        }
    });

    it('should successfully send input to a wrapped script and verify its output', async () => {
        console.log('[SMOKE_TEST] Test start');
        const testId = 'smoke_test';
        const outputFile = path.join(outputDir, `${testId}_output.txt`);
        console.log('[SMOKE_TEST] Spawning chopupInstance');
        chopupInstance = await spawnChopupWithScript(scriptPath, [outputFile], testId, 5000);
        expect(chopupInstance).toBeDefined();
        expect(chopupInstance.socketPath).toBeDefined();
        expect(fsSync.existsSync(chopupInstance.socketPath)).toBe(true);

        const testInput = 'hello-smoke-test\n';
        console.log('[SMOKE_TEST] Sending input');
        await chopupInstance.sendInput(testInput);

        console.log('[SMOKE_TEST] Waiting 100ms for output');
        await new Promise(resolve => setTimeout(resolve, 100));

        console.log('[SMOKE_TEST] Checking output');
        const output = await chopupInstance.getWrappedProcessOutput();
        expect(output).toBe(testInput);

        console.log('[SMOKE_TEST] Cleaning up chopupInstance');
        await chopupInstance.cleanup();
        console.log('[SMOKE_TEST] chopupInstance cleanup complete');

        let socketGone = false;
        for (let i = 0; i < 10; i++) {
            console.log(`[SMOKE_TEST] Checking if socket exists (attempt ${i + 1}):`, chopupInstance.socketPath, fsSync.existsSync(chopupInstance.socketPath));
            if (!fsSync.existsSync(chopupInstance.socketPath)) {
                socketGone = true;
                console.log(`[SMOKE_TEST] Socket gone after ${i + 1} attempts.`);
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!socketGone) {
            console.error(`[SMOKE_TEST] ERROR: Socket file still exists after 1s: ${chopupInstance.socketPath}`);
        }
        console.log(`[SMOKE_TEST] Final socketGone: ${socketGone}, exists: ${fsSync.existsSync(chopupInstance.socketPath)}`);
        expect(socketGone).toBe(true);

        try {
            console.log('[SMOKE_TEST] Attempting to send input after cleanup');
            await chopupInstance.sendInput("after-cleanup");
            throw new Error("sendInput after cleanup should have failed but did not.");
        } catch (error: unknown) {
            if (error instanceof Error) {
                const message = error.message.toLowerCase();
                const isProcessNotRunningError = message.includes('chopup process is not running');
                const isConnectionError = message.includes('connect enoent') || message.includes('econnrefused');
                expect(isProcessNotRunningError || isConnectionError).toBe(true);
            } else {
                throw new Error('Caught an unknown error type during cleanup check.');
            }
        }
        console.log('[SMOKE_TEST] Test end');
    }, 5000);
}); 