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
        console.log('[TEXT_ENTRY_TEST] beforeAll: creating outputDir');
        await fs.mkdir(outputDir, { recursive: true });
        try {
            await fs.access(scriptPath, fs.constants.X_OK);
        } catch {
            await fs.chmod(scriptPath, '755');
        }
    });

    afterAll(async () => {
        console.log('[TEXT_ENTRY_TEST] afterAll: cleanup (no chopupInstance ref)');
    });

    it('should send "John Doe" and verify "Name entered: John Doe" output', async () => {
        console.log('[TEXT_ENTRY_TEST] Test start: John Doe');
        const testId = 'john_doe';
        const outputFile = path.join(outputDir, `${testId}_output.txt`);
        console.log('[TEXT_ENTRY_TEST] Spawning chopupInstance');
        const instance = await spawnChopupWithScript(scriptPath, [outputFile], testId, 5000);
        const inputText = 'John Doe';
        console.log('[TEXT_ENTRY_TEST] Sending input:', inputText);
        await instance.sendInput(`${inputText}\n`);
        console.log('[TEXT_ENTRY_TEST] Waiting 200ms for output');
        await new Promise(resolve => setTimeout(resolve, 200));
        console.log('[TEXT_ENTRY_TEST] Checking output');
        const output = await instance.getWrappedProcessOutput();
        expect(output).toBe(`Name entered: ${inputText}\n`);
        console.log('[TEXT_ENTRY_TEST] Cleaning up chopupInstance');
        await instance.cleanup();
        console.log('[TEXT_ENTRY_TEST] Test end: John Doe');
    }, 5000);

    it('should handle an empty string input (just Enter) and verify "Name entered:" output', async () => {
        console.log('[TEXT_ENTRY_TEST] Test start: empty string');
        const testId = 'empty_string';
        const outputFile = path.join(outputDir, `${testId}_output.txt`);
        const instance = await spawnChopupWithScript(scriptPath, [outputFile], testId, 5000);
        console.log('[TEXT_ENTRY_TEST] Sending input: <empty>');
        await instance.sendInput('\n');
        let output = '';
        const expected = 'Name entered:';
        const start = Date.now();
        let found = false;
        while (Date.now() - start < 1000) {
            output = await instance.getWrappedProcessOutput();
            if (output.trim() === expected) {
                found = true;
                break;
            }
            await new Promise(r => setTimeout(r, 100));
        }
        console.log('[TEXT_ENTRY_TEST] Output:', output.trim());
        expect(found).toBe(true);
        await instance.cleanup();
        console.log('[TEXT_ENTRY_TEST] Test end: empty string');
    }, 5000);

    it('should handle input with leading/trailing spaces and verify correct output', async () => {
        console.log('[TEXT_ENTRY_TEST] Test start: leading/trailing spaces');
        const testId = 'leading_trailing_spaces';
        const outputFile = path.join(outputDir, `${testId}_output.txt`);
        const instance = await spawnChopupWithScript(scriptPath, [outputFile], testId, 5000);
        const inputText = '   leading and trailing spaces  ';
        console.log('[TEXT_ENTRY_TEST] Sending input:', inputText);
        await instance.sendInput(`${inputText}\n`);
        console.log('[TEXT_ENTRY_TEST] Waiting 200ms for output');
        await new Promise(resolve => setTimeout(resolve, 200));
        console.log('[TEXT_ENTRY_TEST] Checking output');
        const output = await instance.getWrappedProcessOutput();
        expect(output).toBe(`Name entered: ${inputText}\n`);
        await instance.cleanup();
        console.log('[TEXT_ENTRY_TEST] Test end: leading/trailing spaces');
    }, 5000);
}); 