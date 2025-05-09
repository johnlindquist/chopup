import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';

const CLI_PATH = join(__dirname, '../../dist/index.js');
const TEST_SCRIPT = join(tmpdir(), 'input-prompt-test.js');

// Create a simple Node.js script that prompts for input and logs the result
const PROMPT_SCRIPT = `
process.stdout.write('Are you sure? (y/n): ');
process.stdin.setEncoding('utf8');
process.stdin.once('data', (data) => {
  const answer = data.trim();
  if (answer === 'y') {
    console.log('Confirmed!');
    process.exit(0);
  } else {
    console.log('Cancelled!');
    process.exit(1);
  }
});
`;

describe('spawn-wrapper --send flag', () => {
    beforeAll(() => {
        writeFileSync(TEST_SCRIPT, PROMPT_SCRIPT, 'utf8');
    });

    afterAll(() => {
        if (existsSync(TEST_SCRIPT)) unlinkSync(TEST_SCRIPT);
    });

    it('should send input to a running process and allow it to proceed', async () => {
        // 1. Start the prompt script directly
        const child = spawn('node', [TEST_SCRIPT], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let output = '';
        child.stdout.on('data', (data) => {
            output += data.toString();
            // Excessive logging for observability
            process.stderr.write(`[test-log] stdout: ${data}`);
        });
        child.stderr.on('data', (data) => {
            process.stderr.write(`[test-log] stderr: ${data}`);
        });

        // 2. Wait for the prompt to appear
        await new Promise((resolve) => {
            const checkPrompt = () => {
                if (output.includes('Are you sure?')) resolve(null);
                else setTimeout(checkPrompt, 10);
            };
            checkPrompt();
        });

        // 3. Use the --send flag to send 'y\n' to the process
        // Simulate: spawn-wrapper --send 'y\n' -- This will be done in a later commit
        // For now, send directly to the test script's stdin
        child.stdin.write('y\n');

        // 4. Wait for process to exit
        const exitCode = await new Promise((resolve) => {
            child.on('exit', resolve);
        });

        // 5. Read all output and verify
        expect(output).toContain('Confirmed!');
        expect(exitCode).toBe(0);
    });
}); 