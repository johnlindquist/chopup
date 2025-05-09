import { spawn, exec } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import fsSync from 'node:fs';
import treeKill from 'tree-kill';
import net from 'node:net';
// import { TMP_DIR } from './test-constants.ts'; // Removed faulty import

const ROOT_DIR = path.resolve(__dirname, '../../../'); // Adjust if utils are nested deeper
export const TMP_DIR = path.resolve(ROOT_DIR, 'tmp'); // Define TMP_DIR here

const CHOPUP_PATH = path.join(ROOT_DIR, 'dist/index.js'); // Assuming compiled output
const LOG_DIR_BASE = path.join(TMP_DIR, 'input-test-logs'); // Use the defined TMP_DIR

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

    const command = 'node';
    const args = [
        CHOPUP_PATH, // Path to the compiled chopup CLI
        'run',
        '--log-dir', instanceLogDir,
        '--log-prefix', logPrefix,
        '--',
        'node', scriptPath,
        ...scriptArgs // Only pass the output file as the first argument
    ];

    chopupProcess = spawn(command, args, {
        cwd: ROOT_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
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
            if (!socketPath) {
                clearTimeout(timeout);
                reject(new Error(`chopup process exited prematurely (code ${code}, signal ${signal}) before socket was found. Stdout: ${stdoutData}, Stderr: ${stderrData}`));
            }
        });
    });

    try {
        socketPath = await outputPromise;
        if (!fsSync.existsSync(socketPath)) {
            await new Promise(r => setTimeout(r, 200));
            if (!fsSync.existsSync(socketPath)) {
                throw new Error(`IPC socket file not found at ${socketPath} after delay. Stdout: ${stdoutData}`);
            }
        }
    } catch (error) {
        process.stderr.write(`[CHOPUP_HELPER_ERROR] Error after outputPromise: ${error instanceof Error ? error.message : String(error)}\n`);
        if (chopupProcess?.pid && !chopupProcess?.killed) {
            await new Promise<void>((resolveKill) => treeKill(chopupProcess.pid as number, 'SIGKILL', () => resolveKill()));
        }
        throw error;
    }

    const cleanup = async () => {
        if (chopupProcess?.pid && !chopupProcess?.killed) {
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
        try {
            if (fsSync.existsSync(instanceLogDir)) {
                await fs.rm(instanceLogDir, { recursive: true, force: true });
            }
        } catch (e) {
            console.warn(`[CHOPUP_HELPER_CLEANUP] Could not remove test log dir ${instanceLogDir}:`, e);
        }
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
                if (stderr?.toLowerCase().includes('error')) {
                    return reject(new Error(`send-input command reported an error: ${stderr}`));
                }
                if (!stdout.includes('INPUT_SENT_AND_STDIN_CLOSED') && !stdout.includes('Input sent successfully')) { // Adjust based on actual success message
                    console.warn(`[SEND_INPUT_HELPER] send-input command output did not explicitly confirm sending. Assuming success. Stdout: ${stdout}`);
                }
                resolve();
            });
        });
    };

    const getWrappedProcessOutput = async (): Promise<string> => {
        const outputFile = scriptArgs[0];
        if (!outputFile) throw new Error('Wrapped script output file path not set.');
        try {
            await new Promise(r => setTimeout(r, 200));
            return await fs.readFile(outputFile, 'utf-8');
        } catch (e: unknown) {
            if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT') {
                return '';
            }
            throw e;
        }
    };

    process.stderr.write(`[CHOPUP_HELPER] About to return from spawnChopupWithScript. sendInput is defined: ${typeof sendInput === 'function'}\n`);
    process.stderr.write(`[CHOPUP_HELPER] Socket path to be returned: ${socketPath}\n`);

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

// export { TMP_DIR }; // Removed duplicate export 