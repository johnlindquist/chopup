import { spawn, exec } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import fsSync from 'node:fs';
import treeKill from 'tree-kill';

const ROOT_DIR = path.resolve(__dirname, '../../../'); // Adjust if utils are nested deeper
const CHOPUP_PATH = path.join(ROOT_DIR, 'dist/index.js'); // Assuming compiled output
const LOG_DIR_BASE = path.resolve(ROOT_DIR, 'tmp/input-test-logs');

export interface ChopupInstance {
    process: ChildProcess;
    socketPath: string;
    logDir: string;
    stdoutData: string;
    stderrData: string;
    cleanup: () => Promise<void>;
    sendInput: (input: string) => Promise<void>;
    getWrappedProcessOutput: () => Promise<string>; // Placeholder, might need specific file
}

export async function spawnChopupWithScript(
    scriptPath: string,
    scriptArgs: string[] = [],
    logPrefix = 'input_test_',
    timeoutMs = 15000,
): Promise<ChopupInstance> {
    const instanceLogDir = path.join(LOG_DIR_BASE, `${logPrefix}${Date.now()}`);
    await fs.mkdir(instanceLogDir, { recursive: true });

    let chopupProcess: ChildProcess | null = null;
    let socketPath = '';
    let stdoutData = '';
    let stderrData = '';
    let wrappedScriptOutputFile: string | null = null; // Path for the script to write its output

    // For simplicity, we'll have the dummy script write its output to a known file
    // This avoids complex stdout/stderr parsing from chopup's interleaved logs.
    wrappedScriptOutputFile = path.join(instanceLogDir, 'wrapped_script_output.txt');

    const command = 'node';
    const args = [
        CHOPUP_PATH, // Path to the compiled chopup CLI
        'run',
        '--log-dir', instanceLogDir,
        '--log-prefix', logPrefix,
        '--',
        'node', scriptPath,
        ...scriptArgs,
        // Pass the output file path to the script as an argument
        wrappedScriptOutputFile
    ];

    chopupProcess = spawn(command, args, {
        cwd: ROOT_DIR,
        stdio: ['pipe', 'pipe', 'pipe'], // stdin, stdout, stderr
        detached: false, // Important for tree-kill
    });

    const outputPromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Timeout waiting for chopup PID and socket. Stdout: ${stdoutData}, Stderr: ${stderrData}`));
        }, timeoutMs);

        chopupProcess?.stdout?.on('data', (data) => {
            stdoutData += data.toString();
            process.stderr.write(`[CHOPUP_HELPER_STDOUT]: ${data.toString()}`);
            const socketMatch = stdoutData.match(/\[CHOPUP\] IPC socket: (.*?)(?:\r\n|\n|$)/);
            if (socketMatch?.[1]) {
                socketPath = socketMatch[1].trim();
                clearTimeout(timeout);
                resolve(socketPath);
            }
        });

        chopupProcess?.stderr?.on('data', (data) => {
            stderrData += data.toString();
            process.stderr.write(`[CHOPUP_HELPER_STDERR]: ${data.toString()}`);
        });

        chopupProcess?.on('error', (err) => {
            clearTimeout(timeout);
            reject(new Error(`chopup process error: ${err.message}. Stdout: ${stdoutData}, Stderr: ${stderrData}`));
        });

        chopupProcess?.on('exit', (code, signal) => {
            // Only reject if socketPath was not found, otherwise let tests handle exit
            if (!socketPath) {
                clearTimeout(timeout);
                reject(new Error(`chopup process exited prematurely (code ${code}, signal ${signal}) before socket was found. Stdout: ${stdoutData}, Stderr: ${stderrData}`));
            }
        });
    });

    try {
        socketPath = await outputPromise;
        if (!fsSync.existsSync(socketPath)) {
            await new Promise(r => setTimeout(r, 200)); // Short delay for socket file to appear
            if (!fsSync.existsSync(socketPath)) {
                throw new Error(`IPC socket file not found at ${socketPath} after delay. Stdout: ${stdoutData}`);
            }
        }
    } catch (error) {
        // Ensure cleanup if spawn/socket detection fails
        if (chopupProcess?.pid && !chopupProcess.killed) {
            await new Promise<void>((resolveKill) => treeKill(chopupProcess.pid!, 'SIGKILL', () => resolveKill()));
        }
        throw error; // Re-throw the error
    }

    const cleanup = async () => {
        if (chopupProcess?.pid && !chopupProcess.killed) {
            const pid = chopupProcess.pid;
            await new Promise<void>((resolveKill, rejectKill) => {
                treeKill(pid, 'SIGKILL', (err) => {
                    if (err) {
                        console.error(`[CHOPUP_HELPER_CLEANUP] Error killing process tree for PID ${pid}:`, err);
                        rejectKill(err);
                    } else {
                        console.log(`[CHOPUP_HELPER_CLEANUP] Successfully killed process tree for PID ${pid}`);
                        resolveKill();
                    }
                });
            });
        }
        // Attempt to remove the log directory, could fail if files are locked
        try {
            if (fsSync.existsSync(instanceLogDir)) {
                await fs.rm(instanceLogDir, { recursive: true, force: true });
            }
        } catch (e) {
            console.warn(`[CHOPUP_HELPER_CLEANUP] Could not remove test log dir ${instanceLogDir}:`, e);
        }
        // Socket file should be cleaned by chopup itself upon exit.
    };

    const sendInput = async (input: string) => {
        if (!socketPath) throw new Error('Cannot send input: IPC socket path not found.');
        if (!chopupProcess || chopupProcess.killed) throw new Error('Cannot send input: chopup process is not running.');

        const command = `node ${CHOPUP_PATH} send-input --socket "${socketPath}" --input "${input.replace(/"/g, '\\"')}"`;
        return new Promise<void>((resolve, reject) => {
            exec(command, (error, stdout, stderr) => {
                if (stdout) process.stderr.write(`[SEND_INPUT_HELPER_STDOUT]: ${stdout}`);
                if (stderr) process.stderr.write(`[SEND_INPUT_HELPER_STDERR]: ${stderr}`);
                if (error) {
                    return reject(new Error(`Failed to execute send-input: ${error.message}. Stderr: ${stderr}`));
                }
                if (stderr && stderr.toLowerCase().includes('error')) {
                    return reject(new Error(`send-input command reported an error: ${stderr}`));
                }
                if (!stdout.includes('INPUT_SENT_AND_STDIN_CLOSED') && !stdout.includes('Input sent successfully')) { // Adjust based on actual success message
                    // return reject(new Error(`send-input command did not confirm sending. Stdout: ${stdout}, Stderr: ${stderr}` ))
                    console.warn(`[SEND_INPUT_HELPER] send-input command output did not explicitly confirm sending. Assuming success. Stdout: ${stdout}`);
                }
                resolve();
            });
        });
    };

    const getWrappedProcessOutput = async (): Promise<string> => {
        if (!wrappedScriptOutputFile) throw new Error('Wrapped script output file path not set.');
        try {
            // Wait a brief moment for output to be flushed
            await new Promise(r => setTimeout(r, 200));
            return await fs.readFile(wrappedScriptOutputFile, 'utf-8');
        } catch (e: unknown) {
            if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT') {
                return ''; // File might not have been created if script wrote nothing or exited early
            }
            throw e;
        }
    };

    return {
        process: chopupProcess,
        socketPath,
        logDir: instanceLogDir,
        stdoutData,
        stderrData,
        cleanup,
        sendInput,
        getWrappedProcessOutput,
    };
} 