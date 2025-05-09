#!/usr/bin/env node

import { program } from 'commander';
import path from 'node:path';
import { spawn } from 'node:child_process';
import chokidar from 'chokidar'; // Import chokidar
import fs from 'node:fs/promises'; // For file system operations
import net from 'node:net'; // For IPC
import treeKill from 'tree-kill';

console.log('[DEBUG] process.argv:', process.argv);

let effectiveArgv = process.argv;
if (effectiveArgv.length > 2 && effectiveArgv[2] === '--') {
    console.log('[DEBUG] Slicing initial "--" from process.argv for commander parsing.');
    effectiveArgv = [effectiveArgv[0], effectiveArgv[1], ...effectiveArgv.slice(3)];
}
console.log('[DEBUG] effectiveArgv for commander:', effectiveArgv);

// Placeholder for actual logic
interface LogBufferEntry {
    timestamp: number;
    type: 'stdout' | 'stderr';
    line: string;
}
const logBuffer: LogBufferEntry[] = [];
let lastChopTime = Date.now();
let ipcServer: net.Server | null = null;
let metaFilePath: string | null = null;

const mainAction = async (commandToRun: string[], options: any) => {
    const { watch: watchPath, logDir, logPrefix, pidFile } = options;
    const [originalCommand, ...originalArgs] = commandToRun;
    const command = 'pnpm';
    const args = ['exec', originalCommand, ...originalArgs];

    const absoluteWatchPath = path.resolve(watchPath);
    const absoluteLogDir = path.resolve(logDir);

    console.log('--- Configuration ---');
    console.log(`Watch target: ${absoluteWatchPath}`);
    console.log(`Log directory: ${absoluteLogDir}`);
    console.log(`Log prefix: ${logPrefix}`);
    if (pidFile) {
        const absolutePidFile = path.resolve(pidFile);
        console.log(`PID file: ${absolutePidFile}`);
        metaFilePath = absolutePidFile.replace(/\\.pid$/, '') + '.meta.json';
        console.log(`Meta file for IPC: ${metaFilePath}`);
    }
    console.log(`Effective command to run: ${command} ${args.join(' ')} (original: ${originalCommand} ${originalArgs.join(' ')})`);
    console.log('---------------------\n');

    // 1. Validate paths and create logDir if it doesn't exist
    try {
        await fs.access(absoluteWatchPath);
    } catch (error) {
        console.error(`[WRAPPER_ERROR] Watch path does not exist or is not accessible: ${absoluteWatchPath}`);
        process.exit(1);
    }
    try {
        await fs.mkdir(absoluteLogDir, { recursive: true });
    } catch (error) {
        console.error(`[WRAPPER_ERROR] Could not create log directory: ${absoluteLogDir}`, error);
        process.exit(1);
    }

    if (pidFile) {
        try {
            await fs.writeFile(path.resolve(pidFile), process.pid.toString());
        } catch (error) {
            console.warn(`[WRAPPER_WARNING] Could not write PID file: ${path.resolve(pidFile)}`, error);
        }
    }

    const chopLogs = async (): Promise<string | null> => {
        console.log(`\n[WRAPPER] File event or request detected. Chopping logs since ${new Date(lastChopTime).toISOString()}...`);
        const logsToOutput = logBuffer.filter(entry => entry.timestamp > lastChopTime);

        if (logsToOutput.length === 0) {
            console.log('[WRAPPER] No new logs to chop.');
            lastChopTime = Date.now();
            return null;
        }

        const outputFileName = `${logPrefix}${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        const outputFilePath = path.join(absoluteLogDir, outputFileName);

        try {
            const logContent = logsToOutput.map(entry => `[${new Date(entry.timestamp).toISOString()}] [${entry.type.toUpperCase()}] ${entry.line}`).join('\n');
            await fs.writeFile(outputFilePath, logContent);
            console.log(`[WRAPPER] Chopped logs saved to: ${outputFilePath}`);
            lastChopTime = Date.now();
            return outputFilePath;
        } catch (err) {
            console.error(`[WRAPPER_ERROR] Failed to write chopped log file: ${outputFilePath}`, err);
            lastChopTime = Date.now(); // Still update time to prevent re-logging same error
            return null;
        }
    };

    const DEBOUNCE_DELAY_MS = 3000;
    let debounceTimer: NodeJS.Timeout | null = null;

    const triggerChopLogsDebounced = () => {
        console.log(`[WRAPPER] File event detected, debouncing chopLogs for ${DEBOUNCE_DELAY_MS}ms...`);
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            console.log('[WRAPPER] Debounce timer expired, calling chopLogs.');
            chopLogs();
        }, DEBOUNCE_DELAY_MS);
    };

    // IPC Server Setup
    if (metaFilePath) {
        ipcServer = net.createServer((socket) => {
            console.log('[IPC_SERVER] Client connected.');
            socket.on('data', async (data) => {
                const message = data.toString().trim();
                console.log(`[IPC_SERVER] Received raw data:`, data);
                console.log(`[IPC_SERVER] Received message: ${message}`);
                if (message === 'CHOP_LOGS_REQUEST') {
                    console.log('[IPC_SERVER] Processing CHOP_LOGS_REQUEST...');
                    // Clear any pending file-event-based debounce, as we are chopping now.
                    if (debounceTimer) {
                        clearTimeout(debounceTimer);
                        debounceTimer = null;
                        console.log('[IPC_SERVER] Cleared pending file event debounce timer.');
                    }
                    const newLogFilePath = await chopLogs();
                    if (newLogFilePath) {
                        socket.write(newLogFilePath);
                        console.log(`[IPC_SERVER] Sent log file path to client: ${newLogFilePath}`);
                    } else {
                        socket.write('NO_NEW_LOGS');
                        console.log('[IPC_SERVER] Sent NO_NEW_LOGS to client.');
                    }
                } else {
                    console.log(`[IPC_SERVER] Unknown message: ${message}`);
                    socket.write('ERROR_UNKNOWN_MESSAGE');
                }
                socket.end(); // Close connection after handling
            });
            socket.on('error', (err) => {
                console.error('[IPC_SERVER] Socket error:', err);
            });
            socket.on('end', () => {
                console.log('[IPC_SERVER] Client disconnected.');
            });
        });

        ipcServer.listen(0, 'localhost', async () => { // Listen on port 0 for a random free port
            const address = ipcServer?.address();
            if (address && typeof address !== 'string') {
                const port = address.port;
                console.log(`[IPC_SERVER] Listening on localhost:${port}`);
                try {
                    if (metaFilePath) { // Should always be true if ipcServer is created
                        await fs.writeFile(metaFilePath, JSON.stringify({ pid: process.pid, ipcPort: port }));
                        console.log(`[IPC_SERVER] Meta file written to ${metaFilePath}`);
                    }
                } catch (error) {
                    console.error(`[IPC_SERVER_ERROR] Could not write meta file: ${metaFilePath}`, error);
                    // Consider if we should exit or just disable IPC if meta file fails
                }
            }
        });
        ipcServer.on('error', (err) => {
            console.error('[IPC_SERVER_ERROR] Server error:', err);
            ipcServer = null; // Disable further IPC attempts if server fails
            if (metaFilePath) { // Attempt to clean up meta file if server fails to start
                fs.unlink(metaFilePath).catch(e => console.error(`[IPC_SERVER_ERROR] Failed to clean up meta file ${metaFilePath}`, e));
            }
        });
    }

    // 2. Set up chokidar to watch the target path
    const watcher = chokidar.watch(absoluteWatchPath, {
        persistent: true,
        ignoreInitial: true,
    });

    watcher
        .on('add', filePath => { console.log(`[CHOKIDAR] File ${filePath} has been added`); triggerChopLogsDebounced(); })
        .on('change', filePath => { console.log(`[CHOKIDAR] File ${filePath} has been changed`); triggerChopLogsDebounced(); })
        .on('unlink', filePath => { console.log(`[CHOKIDAR] File ${filePath} has been removed`); triggerChopLogsDebounced(); })
        .on('error', error => console.error(`[CHOKIDAR_ERROR] Watcher error: ${error}`))
        .on('ready', () => console.log('[CHOKIDAR] Initial scan complete. Ready for changes.'));

    console.log(`[CHOKIDAR] Watching for changes in: ${absoluteWatchPath}`);

    // 3. Spawn the commandToRun
    console.log('\nStarting the wrapped process...');
    const childProcess = spawn(command, args, {
        stdio: ['inherit', 'pipe', 'pipe'],
        cwd: process.cwd()
    });

    // 4. Pipe stdout/stderr from child process to logBuffer
    childProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter((line: string) => line.length > 0);
        for (const line of lines) {
            console.log(`[CHILD_STDOUT] ${line}`);
            logBuffer.push({ timestamp: Date.now(), type: 'stdout', line });
        }
    });

    childProcess.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter((line: string) => line.length > 0);
        for (const line of lines) {
            console.error(`[CHILD_STDERR] ${line}`);
            logBuffer.push({ timestamp: Date.now(), type: 'stderr', line });
        }
    });

    childProcess.on('error', (error) => {
        console.error(`[WRAPPER_ERROR] Failed to start child process: ${error.message}`);
        watcher.close();
        if (ipcServer) ipcServer.close();
        if (metaFilePath) fs.unlink(metaFilePath).catch(() => { });
        process.exit(1);
    });

    const cleanupAndExit = (code: number | null) => {
        console.log(`\nChild process exited with code ${code}`);
        watcher.close().then(() => console.log('[CHOKIDAR] Watcher closed.'));

        const doCleanup = () => {
            if (pidFile) {
                fs.unlink(path.resolve(pidFile)).catch(err => console.warn(`[WRAPPER_WARNING] Could not remove PID file: ${path.resolve(pidFile)}`, err));
            }
            if (metaFilePath) {
                fs.unlink(metaFilePath).catch(err => console.warn(`[WRAPPER_WARNING] Could not remove meta file: ${metaFilePath}`, err));
            }
            console.log('[WRAPPER] Exiting.');
            process.exit(code === null ? 1 : code);
        };

        console.log('[WRAPPER] Child process closed, performing final immediate chopLogs.');
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        chopLogs().finally(() => {
            if (ipcServer) {
                console.log('[WRAPPER] Closing IPC server...');
                ipcServer.close(() => {
                    console.log('[IPC_SERVER] Server closed.');
                    doCleanup();
                });
                // Add a timeout for server close, in case it hangs
                setTimeout(() => {
                    console.warn('[IPC_SERVER] Server close timed out. Forcing exit.');
                    doCleanup();
                }, 2000);
            } else {
                doCleanup();
            }
        });
        // Kill the entire process tree for the child
        if (childProcess && childProcess.pid) {
            treeKill(childProcess.pid, 'SIGKILL', (err) => {
                if (err) {
                    console.error('[WRAPPER] Error killing process tree:', err);
                } else {
                    console.log(`[WRAPPER] Killed process tree for PID ${childProcess.pid}`);
                }
            });
        }
    };

    childProcess.on('close', cleanupAndExit);

    // Graceful shutdown handling
    const gracefulShutdown = (signal: NodeJS.Signals) => {
        console.log(`\n[WRAPPER] Received ${signal}. Terminating child process and watcher...`);
        if (ipcServer) {
            console.log('[WRAPPER] Closing IPC server due to signal...');
            ipcServer.close(() => console.log('[IPC_SERVER] Server closed due to signal.'));
        }
        watcher.close().then(() => console.log('[CHOKIDAR] Watcher closed due to signal.'));
        if (childProcess && childProcess.pid) {
            treeKill(childProcess.pid, 'SIGKILL', (err) => {
                if (err) {
                    console.error('[WRAPPER] Error killing process tree:', err);
                } else {
                    console.log(`[WRAPPER] Killed process tree for PID ${childProcess.pid}`);
                }
            });
        }
        // Note: The 'close' event on childProcess will trigger the final chopLogs and exit.
    };

    process.on('SIGINT', gracefulShutdown.bind(null, 'SIGINT'));
    process.on('SIGTERM', gracefulShutdown.bind(null, 'SIGTERM'));
};

program
    .version('0.2.0')
    .description('A tool to wrap long-running processes and chop their logs based on file changes or IPC request.')
    .requiredOption('-w, --watch <path>', 'File or directory to watch for changes')
    .requiredOption('-l, --log-dir <path>', 'Directory to store chopped log files')
    .option('--log-prefix <prefix>', 'Prefix for log file names', 'log_')
    .option('--pid-file <path>', 'Path to save the PID of the wrapper process. Enables IPC if specified.')
    .argument('<command_to_run...>', 'The command to run and its arguments')
    .action(mainAction);

// New command for requesting logs
program
    .command('request-logs')
    .description('Requests the primary chopup instance to chop and save its current log buffer.')
    .requiredOption('--meta-file <path>', 'Path to the .meta.json file of the target chopup instance.')
    .action(async (options) => {
        const { metaFile } = options;
        console.log(`[REQUEST_LOGS_CLIENT] Attempting to request logs using meta file: ${metaFile}`);
        let metaData;
        try {
            const metaContent = await fs.readFile(path.resolve(metaFile), 'utf-8');
            metaData = JSON.parse(metaContent);
            if (!metaData.ipcPort || !metaData.pid) {
                throw new Error('Meta file is missing ipcPort or pid.');
            }
            console.log(`[REQUEST_LOGS_CLIENT] Target PID: ${metaData.pid}, IPC Port: ${metaData.ipcPort}`);
        } catch (error: any) {
            console.error(`[REQUEST_LOGS_CLIENT_ERROR] Failed to read or parse meta file: ${metaFile}`, error.message);
            process.exit(1);
            return;
        }

        const client = net.createConnection({ port: metaData.ipcPort, host: 'localhost' }, () => {
            console.log('[REQUEST_LOGS_CLIENT] Connected to primary instance.');
            console.log('[REQUEST_LOGS_CLIENT] Sending CHOP_LOGS_REQUEST...');
            client.write('CHOP_LOGS_REQUEST');
            console.log('[REQUEST_LOGS_CLIENT] CHOP_LOGS_REQUEST sent.');
        });

        let responseData = '';
        client.on('data', (data) => {
            responseData += data.toString();
            // Assuming the server sends the path and then closes the connection, or sends a newline
            if (responseData.includes('\n') || responseData.length > 0) { // Basic check, might need refinement
                const receivedPath = responseData.trim();
                if (receivedPath === 'NO_NEW_LOGS') {
                    console.log('[REQUEST_LOGS_CLIENT] Primary instance reported no new logs to chop.');
                } else if (receivedPath.startsWith('ERROR_')) {
                    console.error(`[REQUEST_LOGS_CLIENT_ERROR] Received error from primary instance: ${receivedPath}`);
                } else {
                    console.log(`[REQUEST_LOGS_CLIENT] New log file created by primary instance: ${receivedPath}`);
                }
                client.end();
            }
        });
        client.on('end', () => {
            console.log('[REQUEST_LOGS_CLIENT] Disconnected from primary instance.');
        });
        client.on('error', (err) => {
            console.error('[REQUEST_LOGS_CLIENT_ERROR] Connection error:', err.message);
            process.exit(1);
        });
    });

program.parse(effectiveArgv);

// if (!process.argv.slice(2).length) {
//   program.outputHelp();
// } 