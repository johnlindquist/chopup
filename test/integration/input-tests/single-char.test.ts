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
        console.log('[SINGLE_CHAR_TEST] beforeAll: creating outputDir');
        await fs.mkdir(outputDir, { recursive: true });
        try {
            await fs.access(scriptPath, fs.constants.X_OK);
        } catch {
            await fs.chmod(scriptPath, '755');
        }
    });

    afterAll(async () => {
        console.log('[SINGLE_CHAR_TEST] afterAll: cleaning up chopupInstance');
        if (chopupInstance) {
            await chopupInstance.cleanup();
        }
    });

    it('should send "y" and verify "Confirmed: yes" output', async () => {
        console.log('[SINGLE_CHAR_TEST] Test start: y');
        const testId = 'single_char_y';
        const outputFile = path.join(outputDir, `${testId}_output.txt`);
        console.log('[SINGLE_CHAR_TEST] Spawning chopupInstance');
        chopupInstance = await spawnChopupWithScript(scriptPath, [outputFile], testId, 5000);
        expect(chopupInstance?.socketPath).toBeDefined();

        const testInput = 'y\n';
        console.log('[SINGLE_CHAR_TEST] Sending input: y');
        await chopupInstance.sendInput(testInput);

        let output = '';
        let found = false;
        const start = Date.now();
        while (Date.now() - start < 1000) {
            output = await chopupInstance.getWrappedProcessOutput();
            if (output.trim() === 'Confirmed: yes') {
                found = true;
                break;
            }
            await new Promise(r => setTimeout(r, 100));
        }
        console.log('[SINGLE_CHAR_TEST] Output:', output.trim());
        expect(found).toBe(true);
        console.log('[SINGLE_CHAR_TEST] Cleaning up chopupInstance');
        await chopupInstance.cleanup();
        console.log('[SINGLE_CHAR_TEST] Test end: y');
    }, 5000);

    it('should send "N" and verify "Confirmed: no" output', async () => {
        console.log('[SINGLE_CHAR_TEST] Test start: N');
        const testId = 'single_char_N';
        const outputFile = path.join(outputDir, `${testId}_output.txt`);
        if (chopupInstance) await chopupInstance.cleanup();
        console.log('[SINGLE_CHAR_TEST] Spawning chopupInstance');
        chopupInstance = await spawnChopupWithScript(scriptPath, [outputFile], testId, 5000);
        expect(chopupInstance?.socketPath).toBeDefined();

        const testInput = 'N\n';
        console.log('[SINGLE_CHAR_TEST] Sending input: N');
        await chopupInstance.sendInput(testInput);

        let output = '';
        let found = false;
        const start = Date.now();
        while (Date.now() - start < 1000) {
            output = await chopupInstance.getWrappedProcessOutput();
            if (output.trim() === 'Confirmed: no') {
                found = true;
                break;
            }
            await new Promise(r => setTimeout(r, 100));
        }
        console.log('[SINGLE_CHAR_TEST] Output:', output.trim());
        expect(found).toBe(true);
        console.log('[SINGLE_CHAR_TEST] Cleaning up chopupInstance');
        await chopupInstance.cleanup();
        console.log('[SINGLE_CHAR_TEST] Test end: N');
    }, 5000);

    it('should send invalid input and verify "Invalid input: ..." output', async () => {
        console.log('[SINGLE_CHAR_TEST] Test start: invalid');
        const testId = 'single_char_invalid';
        const outputFile = path.join(outputDir, `${testId}_output.txt`);
        if (chopupInstance) await chopupInstance.cleanup();
        console.log('[SINGLE_CHAR_TEST] Spawning chopupInstance');
        chopupInstance = await spawnChopupWithScript(scriptPath, [outputFile], testId, 5000);
        expect(chopupInstance?.socketPath).toBeDefined();

        const testInput = 'maybe\n';
        console.log('[SINGLE_CHAR_TEST] Sending input: maybe');
        await chopupInstance.sendInput(testInput);

        let output = '';
        let found = false;
        const start = Date.now();
        while (Date.now() - start < 1000) {
            output = await chopupInstance.getWrappedProcessOutput();
            if (output.trim().startsWith('Invalid input:')) {
                found = true;
                break;
            }
            await new Promise(r => setTimeout(r, 100));
        }
        console.log('[SINGLE_CHAR_TEST] Output:', output.trim());
        expect(found).toBe(true);
        console.log('[SINGLE_CHAR_TEST] Cleaning up chopupInstance');
        await chopupInstance.cleanup();
        console.log('[SINGLE_CHAR_TEST] Test end: invalid');
    }, 5000);
}); 