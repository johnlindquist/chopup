import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, exec } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import treeKill from 'tree-kill';

const CLI_PATH = join(__dirname, '../../dist/index.js');
const TEST_SCRIPT_DIR = tmpdir();
const TEST_SCRIPT_NAME = 'input-prompt-test.js';
const TEST_SCRIPT_PATH = join(TEST_SCRIPT_DIR, TEST_SCRIPT_NAME);

const PROMPT_SCRIPT_LINES = [
    '// Excessive logging for test observability',
    'console.error("[PROMPT_SCRIPT] Started.");',
    'process.stdout.write("Are you sure? (y/n): ");',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.once("data", (data) => {',
    '  const answer = data.toString().trim();',
    '  // Log received data for debugging',
    '  console.error(`[PROMPT_SCRIPT] Received: "${answer}"`);',
    '  if (answer === "y") {',
    '    console.log("Confirmed!");',
    '    process.exit(0);',
    '  } else {',
    '    console.log(`Cancelled! Received: ${answer}`);',
    '    process.exit(1);',
    '  }',
    '});',
];
const PROMPT_SCRIPT = PROMPT_SCRIPT_LINES.join('\n');

describe('spawn-wrapper send-input command', () => {
    beforeAll(() => {
        writeFileSync(TEST_SCRIPT_PATH, PROMPT_SCRIPT, 'utf8');
        console.log(`[TEST_SETUP] Created test script at ${TEST_SCRIPT_PATH}`);
    });

    afterAll(() => {
        if (existsSync(TEST_SCRIPT_PATH)) {
            unlinkSync(TEST_SCRIPT_PATH);
            console.log(`[TEST_TEARDOWN] Deleted test script at ${TEST_SCRIPT_PATH}`);
        }
    });

    it('should send input to a wrapped process via send-input command and allow it to proceed', async () => {
        let wrapperProcess;
        let ipcSocketPath = '';

        try {
            // 1. Start the spawn-wrapper with the prompt script
            // Command: node dist/index.js run node /tmp/input-prompt-test.js
            console.log(`[TEST_RUN] Starting wrapper: node ${CLI_PATH} run node ${TEST_SCRIPT_PATH}`);
            wrapperProcess = spawn('node', [CLI_PATH, 'run', 'node', TEST_SCRIPT_PATH], {
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: true, // Important for tree-kill later if needed
            });

            let wrapperOutput = '';
            const outputPromise = new Promise<void>((resolve) => {
                wrapperProcess.stdout.on('data', (data) => {
                    const text = data.toString();
                    wrapperOutput += text;
                    process.stderr.write(`[WRAPPER_STDOUT] ${text}`);
                    // Extract IPC socket path
                    const socketMatch = text.match(/IPC socket: (.*)/);
                    if (socketMatch && socketMatch[1]) {
                        ipcSocketPath = socketMatch[1].trim();
                        console.log(`[TEST_RUN] Extracted IPC Socket Path: ${ipcSocketPath}`);
                    }
                    // Resolve once prompt is seen from wrapper OR socket path is found (whichever indicates readiness)
                    if (text.includes('Are you sure? (y/n):') && ipcSocketPath) {
                        console.log('[TEST_RUN] Prompt detected from wrapper and socket path found.');
                        resolve();
                    }
                });
                wrapperProcess.stderr.on('data', (data) => {
                    process.stderr.write(`[WRAPPER_STDERR] ${data.toString()}`);
                });
            });

            // Wait for the wrapper to start and print the socket path and for the prompt to appear
            console.log('[TEST_RUN] Waiting for wrapper to be ready...');
            await outputPromise;

            expect(ipcSocketPath).not.toBe('');
            console.log(`[TEST_RUN] Wrapper ready. IPC Socket: ${ipcSocketPath}`);

            // 2. Use the send-input command to send 'y'
            const sendInputCommand = `node ${CLI_PATH} send-input --socket "${ipcSocketPath}" --input "y"`;
            console.log(`[TEST_RUN] Executing send-input: ${sendInputCommand}`);

            await new Promise<void>((resolveExec, rejectExec) => {
                exec(sendInputCommand, (error, stdout, stderr) => {
                    process.stderr.write(`[SEND_INPUT_STDOUT] ${stdout}`);
                    process.stderr.write(`[SEND_INPUT_STDERR] ${stderr}`);
                    if (error) {
                        console.error(`[TEST_RUN] send-input command failed: ${error.message}`);
                        return rejectExec(error);
                    }
                    console.log('[TEST_RUN] send-input command completed.');
                    expect(stdout).toContain('INPUT_SENT');
                    resolveExec();
                });
            });

            // 3. Wait for the wrapped process to confirm and exit
            const exitCode = await new Promise<number | null>((resolveExit) => {
                wrapperProcess.on('exit', resolveExit);
            });

            console.log(`[TEST_RUN] Wrapper process exited with code: ${exitCode}`);

            // Refresh wrapperOutput to get all data since it might have been delayed
            // This is tricky, better to rely on specific log messages from wrapped script if possible
            // For now, we assume the initial output capture was enough for the prompt
            // and the important part is the 'Confirmed!' message from the prompt script relayed by wrapper

            expect(wrapperOutput).toContain('Confirmed!'); // Check if the prompt script confirmed
            // The wrapper process itself should exit cleanly (code 0) if the child exits cleanly
            expect(exitCode).toBe(0);

        } finally {
            if (wrapperProcess && wrapperProcess.pid) {
                console.log(`[TEST_TEARDOWN] Killing wrapper process tree PID: ${wrapperProcess.pid}`);
                // treeKill is not async, but we can wrap it or just call it.
                // For tests, direct kill might be okay, but tree-kill is per project rules.
                await new Promise<void>((resolveKill) => treeKill(wrapperProcess.pid, 'SIGKILL', resolveKill));
                console.log(`[TEST_TEARDOWN] Wrapper process tree for PID ${wrapperProcess.pid} should be killed.`);
            }
            // Clean up socket file if it still exists (though chopup should do this)
            if (ipcSocketPath && existsSync(ipcSocketPath)) {
                try { unlinkSync(ipcSocketPath); } catch (e) { console.error(`Error deleting socket file: ${e}`); }
            }
        }
    }, 15000); // Increased timeout for multiple process interactions
}); 