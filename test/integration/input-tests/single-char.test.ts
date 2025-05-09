import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import { spawnChopupWithScript } from '../test-utils/input-helpers';
import type { ChopupInstance } from '../test-utils/input-helpers';

const SCRIPT_DIR = path.resolve(__dirname, 'fixtures/scripts');
const YES_NO_SCRIPT_PATH = path.join(SCRIPT_DIR, 'yes-no-prompt.js');

describe('Single Character Input Test', () => {
    let chopupInstance: ChopupInstance | null = null;

    afterAll(async () => {
        if (chopupInstance) {
            await chopupInstance.cleanup();
        }
    });

    it('should send "y" and verify "Confirmed: yes" output', async () => {
        chopupInstance = await spawnChopupWithScript(YES_NO_SCRIPT_PATH, [], 'single_char_y_');
        expect(chopupInstance?.socketPath).toBeDefined();

        const testInput = 'y\n'; // Send 'y' followed by newline
        await chopupInstance.sendInput(testInput);

        // Allow time for script to process and write output
        await new Promise(resolve => setTimeout(resolve, 500));

        const output = await chopupInstance.getWrappedProcessOutput();
        expect(output.trim()).toBe('Confirmed: yes');
    }, 20000);

    it('should send "N" and verify "Confirmed: no" output', async () => {
        // Need a new instance for a new run
        if (chopupInstance) await chopupInstance.cleanup();
        chopupInstance = await spawnChopupWithScript(YES_NO_SCRIPT_PATH, [], 'single_char_N_');
        expect(chopupInstance?.socketPath).toBeDefined();

        const testInput = 'N\n'; // Send 'N' followed by newline
        await chopupInstance.sendInput(testInput);

        await new Promise(resolve => setTimeout(resolve, 500));

        const output = await chopupInstance.getWrappedProcessOutput();
        expect(output.trim()).toBe('Confirmed: no');
    }, 20000);

    it('should send invalid input and verify "Invalid input: ..." output', async () => {
        if (chopupInstance) await chopupInstance.cleanup();
        chopupInstance = await spawnChopupWithScript(YES_NO_SCRIPT_PATH, [], 'single_char_invalid_');
        expect(chopupInstance?.socketPath).toBeDefined();

        const testInput = 'maybe\n';
        await chopupInstance.sendInput(testInput);

        await new Promise(resolve => setTimeout(resolve, 500));

        const output = await chopupInstance.getWrappedProcessOutput();
        expect(output.trim()).toBe('Invalid input: maybe');
    }, 20000);
}); 