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

    it('should fail gracefully if the target socket path is invalid', async () => {
        const invalidSocketPath = join(tmpdir(), 'nonexistent-chopup.sock');
        const sendInputCommand = `node ${CLI_PATH} send-input --socket "${invalidSocketPath}" --input "test"`;
        console.log(`[TEST_RUN_ERROR_SCENARIO] Executing send-input to invalid socket: ${sendInputCommand}`);

        let stderrOutput = '';
        try {
            await new Promise<void>((resolve, reject) => {
                exec(sendInputCommand, (error, stdout, stderr) => {
                    process.stderr.write(`[SEND_INPUT_INVALID_SOCKET_STDOUT] ${stdout}`);
                    process.stderr.write(`[SEND_INPUT_INVALID_SOCKET_STDERR] ${stderr}`);
                    stderrOutput = stderr; // Capture stderr
                    if (error) {
                        // Expected to error out
                        console.log('[TEST_RUN_ERROR_SCENARIO] send-input to invalid socket failed as expected.');
                        resolve(); // Resolve because error is expected
                        return;
                    }
                    // If it somehow doesn't error, fail the test
                    reject(new Error('send-input to invalid socket should have failed but did not.'));
                });
            });
        } catch (e) {
            // This catch is for the promise rejection, not the exec error itself handled above.
        }
        expect(stderrOutput).toMatch(/Connection error.*(ENOENT|ECONNREFUSED)/i); // ENOENT or ECONNREFUSED depending on OS/timing
    }, 10000);

    it('should fail gracefully if the wrapped process has already exited', async () => {
        let wrapperProcess;
        let ipcSocketPath = '';
        const quickExitScriptContent = "console.log('Quick exit!'); process.exit(0);";
        const quickExitScriptPath = join(TEST_SCRIPT_DIR, 'quick-exit-script.js');
        writeFileSync(quickExitScriptPath, quickExitScriptContent, 'utf8');

        try {
            console.log(`[TEST_RUN_CHILD_EXITED] Starting wrapper with quick exit script: node ${CLI_PATH} run node ${quickExitScriptPath}`);
            wrapperProcess = spawn('node', [CLI_PATH, 'run', 'node', quickExitScriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });

            let wrapperOutput = '';
            const socketPathPromise = new Promise<string>((resolve, reject) => {
                wrapperProcess.stdout.on('data', (data) => {
                    const text = data.toString();
                    wrapperOutput += text;
                    process.stderr.write(`[WRAPPER_QUICK_EXIT_STDOUT] ${text}`);
                    const match = text.match(/IPC socket: (.*)/);
                    if (match && match[1]) {
                        resolve(match[1].trim());
                    }
                });
                wrapperProcess.on('exit', () => setTimeout(() => reject(new Error('Wrapper exited before IPC socket was found')), 50));
            });
            ipcSocketPath = await socketPathPromise;
            console.log(`[TEST_RUN_CHILD_EXITED] Wrapper started, IPC socket: ${ipcSocketPath}`);

            // Wait for the child (and thus wrapper) to likely exit
            await new Promise(resolve => wrapperProcess.on('exit', resolve));
            console.log('[TEST_RUN_CHILD_EXITED] Wrapper process has exited.');
            await new Promise(r => setTimeout(r, 500)); // Give time for socket to be cleaned up / server to shut down fully

            const sendInputCommand = `node ${CLI_PATH} send-input --socket "${ipcSocketPath}" --input "test"`;
            console.log(`[TEST_RUN_CHILD_EXITED] Executing send-input: ${sendInputCommand}`);

            let stderrOutput = '';
            let stdoutOutput = '';
            try {
                await new Promise<void>((resolve, reject) => {
                    exec(sendInputCommand, (error, stdout, stderr) => {
                        stdoutOutput = stdout;
                        stderrOutput = stderr;
                        process.stderr.write(`[SEND_INPUT_CHILD_EXITED_STDOUT] ${stdout}`);
                        process.stderr.write(`[SEND_INPUT_CHILD_EXITED_STDERR] ${stderr}`);
                        // Expect an error from the CLI tool or connection refused
                        if (stderr.includes('ERROR_CHILD_PROCESS_NOT_AVAILABLE') || stderr.match(/Connection error.*(ECONNREFUSED|ENOENT)/i)) {
                            console.log('[TEST_RUN_CHILD_EXITED] send-input failed as expected after child exit.');
                            resolve();
                        } else if (error) { // Other CLI errors are also acceptable failures
                            console.log('[TEST_RUN_CHILD_EXITED] send-input failed with CLI error as expected.');
                            resolve();
                        }
                        else {
                            reject(new Error('send-input after child exit should have failed or reported child not available.'));
                        }
                    });
                });
            } catch (e) { /* Handled by promise rejection */ }

            // Check that either the specific server error was received, or a connection error occurred
            const receivedChildProcessNotAvailableError = stderrOutput.includes('ERROR_CHILD_PROCESS_NOT_AVAILABLE') || stdoutOutput.includes('ERROR_CHILD_PROCESS_NOT_AVAILABLE');
            const receivedConnectionError = !!stderrOutput.match(/Connection error.*(ECONNREFUSED|ENOENT)/i);
            const success = receivedChildProcessNotAvailableError || receivedConnectionError;
            expect(success).toBeTruthy();

        } finally {
            if (wrapperProcess && wrapperProcess.pid && !wrapperProcess.killed) {
                await new Promise<void>(resolveKill => treeKill(wrapperProcess.pid, 'SIGKILL', resolveKill));
            }
            if (existsSync(quickExitScriptPath)) unlinkSync(quickExitScriptPath);
            // Socket should ideally be cleaned by wrapper, but if test fails early, it might not be
            if (ipcSocketPath && existsSync(ipcSocketPath)) { try { unlinkSync(ipcSocketPath); } catch (e) { } }
        }
    }, 15000); // Increased timeout
}); 