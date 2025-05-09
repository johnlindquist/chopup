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
        await fs.mkdir(outputDir, { recursive: true });
        try {
            await fs.access(scriptPath, fs.constants.X_OK);
        } catch {
            await fs.chmod(scriptPath, '755');
        }
    });

    afterAll(async () => {
        if (chopupInstance) {
            await chopupInstance.cleanup();
        }
        // Optionally clean up logs
        // await fs.rm(baseLogDir, { recursive: true, force: true });
    });

    it('should successfully send input to a wrapped script and verify its output', async () => {
        const testId = 'smoke_test';
        const outputFile = path.join(outputDir, `${testId}_output.txt`);
        chopupInstance = await spawnChopupWithScript(scriptPath, [outputFile], testId);
        expect(chopupInstance).toBeDefined();
        expect(chopupInstance.socketPath).toBeDefined();
        expect(fsSync.existsSync(chopupInstance.socketPath)).toBe(true);

        const testInput = 'hello-smoke-test\n'; // Add newline as stdin is often line-buffered
        await chopupInstance.sendInput(testInput);

        // Give the script a moment to process input and write to its output file
        await new Promise(resolve => setTimeout(resolve, 500));

        const output = await chopupInstance.getWrappedProcessOutput();
        expect(output).toBe(testInput);

        // Verify cleanup by trying to send input again (should fail if process is gone)
        // and checking if socket file is removed (though chopup should do this on exit)
        await chopupInstance.cleanup(); // Explicitly call cleanup

        // Check if socket is gone - chopup cleans this on exit
        // It might take a moment for the OS to release the file handle
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(fsSync.existsSync(chopupInstance.socketPath)).toBe(false);

        // Attempting to send input again should ideally fail if the process is truly gone
        try {
            await chopupInstance.sendInput("after-cleanup");
            // If it doesn't throw, fail the test, as we expect an error after cleanup
            throw new Error("sendInput after cleanup should have failed but did not.");
        } catch (error: unknown) {
            if (error instanceof Error) {
                // Expect either the helper's own error or a connection error from the CLI
                const message = error.message.toLowerCase();
                const isProcessNotRunningError = message.includes('chopup process is not running');
                const isConnectionError = message.includes('connect enoent') || message.includes('econnrefused');
                expect(isProcessNotRunningError || isConnectionError).toBe(true);
            } else {
                // If it's not an Error instance, fail the test
                throw new Error('Caught an unknown error type during cleanup check.');
            }
        }
    }, 20000); // 20s timeout for this test
}); 