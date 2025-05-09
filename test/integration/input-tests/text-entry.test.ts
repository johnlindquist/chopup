import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
    spawnChopupWithScript,
    type ChopupInstance,
    TMP_DIR
} from '../test-utils/input-helpers';

const SCRIPT_NAME = 'text-entry-prompt.js';
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures/scripts');
const scriptPath = path.join(FIXTURES_DIR, SCRIPT_NAME);

const testRunId = `text-entry-tests_${Date.now()}`;
const baseLogDir = path.join(TMP_DIR, 'input-test-logs', testRunId);
const outputDir = path.join(baseLogDir, 'outputs');

describe('Text Entry Input Test', () => {
    beforeAll(async () => {
        await fs.mkdir(outputDir, { recursive: true });
        try {
            await fs.access(scriptPath, fs.constants.X_OK);
        } catch {
            await fs.chmod(scriptPath, '755');
        }
    });

    afterAll(async () => {
        // Optionally clean up logs
        // await fs.rm(baseLogDir, { recursive: true, force: true });
    });

    it('should send "John Doe" and verify "Name entered: John Doe" output', async () => {
        const testId = 'john_doe';
        const outputFile = path.join(outputDir, `${testId}_output.txt`);
        const instance = await spawnChopupWithScript(scriptPath, [outputFile], testId);
        const inputText = 'John Doe';
        await instance.sendInput(`${inputText}\n`);
        await new Promise(resolve => setTimeout(resolve, 500));
        const output = await instance.getWrappedProcessOutput();
        expect(output).toBe(`Name entered: ${inputText}\n`);
        await instance.cleanup();
    }, 20000);

    it('should handle an empty string input (just Enter) and verify "Name entered:" output', async () => {
        const testId = 'empty_string';
        const outputFile = path.join(outputDir, `${testId}_output.txt`);
        const instance = await spawnChopupWithScript(scriptPath, [outputFile], testId);

        await instance.sendInput('\n');

        // Wait for the script to process and write output (poll for up to 2s)
        let output = '';
        const expected = 'Name entered:';
        const start = Date.now();
        while (Date.now() - start < 2000) {
            output = await instance.getWrappedProcessOutput();
            if (output.trim() === expected) break;
            await new Promise(r => setTimeout(r, 100));
        }
        expect(output.trim()).toBe(expected);
        await instance.cleanup();
    }, 20000);

    it('should handle input with leading/trailing spaces and verify correct output', async () => {
        const testId = 'leading_trailing_spaces';
        const outputFile = path.join(outputDir, `${testId}_output.txt`);
        const instance = await spawnChopupWithScript(scriptPath, [outputFile], testId);
        const inputText = '   leading and trailing spaces  ';
        await instance.sendInput(`${inputText}\n`);
        await new Promise(resolve => setTimeout(resolve, 500));
        const output = await instance.getWrappedProcessOutput();
        expect(output).toBe(`Name entered: ${inputText}\n`);
        await instance.cleanup();
    }, 20000);
}); 