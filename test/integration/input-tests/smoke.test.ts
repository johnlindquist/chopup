import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fsSync from 'node:fs';
import { spawnChopupWithScript } from '../test-utils/input-helpers';
import type { ChopupInstance } from '../test-utils/input-helpers';

const SCRIPT_DIR = path.resolve(__dirname, 'fixtures/scripts');
const ECHO_SCRIPT_PATH = path.join(SCRIPT_DIR, 'echo-input.js');

describe('Input Sending Smoke Test', () => {
    let chopupInstance: ChopupInstance | null = null;

    afterAll(async () => {
        if (chopupInstance) {
            await chopupInstance.cleanup();
        }
    });

    it('should successfully send input to a wrapped script and verify its output', async () => {
        chopupInstance = await spawnChopupWithScript(ECHO_SCRIPT_PATH, [], 'smoke_test_');
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