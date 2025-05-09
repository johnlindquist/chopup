import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawnChopupWithScript, TMP_DIR } from '../test-utils/input-helpers';
import type { ChopupInstance } from '../test-utils/input-helpers';

const SCRIPT_NAME = 'yes-no-prompt.js';
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures/scripts');
const scriptPath = path.join(FIXTURES_DIR, SCRIPT_NAME);

const testRunId = `single-char-tests_${Date.now()}`;
const baseLogDir = path.join(TMP_DIR, 'input-test-logs', testRunId);
const outputDir = path.join(baseLogDir, 'outputs');

describe('Single Character Input Test', () => {
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

    it('should send "y" and verify "Confirmed: yes" output', async () => {
        const testId = 'single_char_y';
        const outputFile = path.join(outputDir, `${testId}_output.txt`);
        chopupInstance = await spawnChopupWithScript(scriptPath, [outputFile], testId);
        expect(chopupInstance?.socketPath).toBeDefined();

        const testInput = 'y\n'; // Send 'y' followed by newline
        await chopupInstance.sendInput(testInput);

        // Allow time for script to process and write output
        await new Promise(resolve => setTimeout(resolve, 500));

        const output = await chopupInstance.getWrappedProcessOutput();
        expect(output.trim()).toBe('Confirmed: yes');
        await chopupInstance.cleanup();
    }, 20000);

    it('should send "N" and verify "Confirmed: no" output', async () => {
        const testId = 'single_char_N';
        const outputFile = path.join(outputDir, `${testId}_output.txt`);
        // Need a new instance for a new run
        if (chopupInstance) await chopupInstance.cleanup();
        chopupInstance = await spawnChopupWithScript(scriptPath, [outputFile], testId);
        expect(chopupInstance?.socketPath).toBeDefined();

        const testInput = 'N\n'; // Send 'N' followed by newline
        await chopupInstance.sendInput(testInput);

        await new Promise(resolve => setTimeout(resolve, 500));

        const output = await chopupInstance.getWrappedProcessOutput();
        expect(output.trim()).toBe('Confirmed: no');
        await chopupInstance.cleanup();
    }, 20000);

    it('should send invalid input and verify "Invalid input: ..." output', async () => {
        const testId = 'single_char_invalid';
        const outputFile = path.join(outputDir, `${testId}_output.txt`);
        if (chopupInstance) await chopupInstance.cleanup();
        chopupInstance = await spawnChopupWithScript(scriptPath, [outputFile], testId);
        expect(chopupInstance?.socketPath).toBeDefined();

        const testInput = 'maybe\n';
        await chopupInstance.sendInput(testInput);

        await new Promise(resolve => setTimeout(resolve, 500));

        const output = await chopupInstance.getWrappedProcessOutput();
        expect(output.trim().startsWith('Invalid input:')).toBe(true);
        await chopupInstance.cleanup();
    }, 20000);
}); 