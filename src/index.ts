#!/usr/bin/env node

import { program } from 'commander';
import path from 'node:path';
import { spawn } from 'node:child_process';
import chokidar from 'chokidar'; // Import chokidar
import fs from 'node:fs/promises'; // For file system operations

// Placeholder for actual logic
interface LogBufferEntry {
    timestamp: number;
    type: 'stdout' | 'stderr';
    line: string;
}
const logBuffer: LogBufferEntry[] = [];
let lastChopTime = Date.now();

program
    .version('0.1.0')
    .description('A tool to wrap long-running processes and chop their logs based on file changes.')
    .requiredOption('-w, --watch <path>', 'File or directory to watch for changes')
    .requiredOption('-l, --log-dir <path>', 'Directory to store chopped log files')
    .argument('<command_to_run...>', 'The command to run and its arguments (e.g., pnpm dev, or node myScript.js)')
    .action(async (commandToRun, options) => {
        const { watch: watchPath, logDir } = options;
        const [command, ...args] = commandToRun;

        const absoluteWatchPath = path.resolve(watchPath);
        const absoluteLogDir = path.resolve(logDir);

        console.log('--- Configuration ---');
        console.log(`Watch target: ${absoluteWatchPath}`);
        console.log(`Log directory: ${absoluteLogDir}`);
        console.log(`Command to run: ${command} ${args.join(' ')}`);
        console.log('---------------------\n');

        // 1. Validate paths and create logDir if it doesn't exist
        try {
            await fs.access(absoluteWatchPath); // Check if watch path exists
        } catch (error) {
            console.error(`[WRAPPER_ERROR] Watch path does not exist or is not accessible: ${absoluteWatchPath}`);
            process.exit(1);
        }
        try {
            await fs.mkdir(absoluteLogDir, { recursive: true }); // Create logDir if not exists
        } catch (error) {
            console.error(`[WRAPPER_ERROR] Could not create log directory: ${absoluteLogDir}`, error);
            process.exit(1);
        }

        const chopLogs = async () => {
            console.log(`\n[WRAPPER] File change detected. Chopping logs since ${new Date(lastChopTime).toISOString()}...`);
            const logsToOutput = logBuffer.filter(entry => entry.timestamp > lastChopTime);

            if (logsToOutput.length === 0) {
                console.log('[WRAPPER] No new logs to chop.');
                lastChopTime = Date.now(); // Still update chop time to now
                return;
            }

            const outputFileName = `log_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
            const outputFilePath = path.join(absoluteLogDir, outputFileName);

            try {
                const logContent = logsToOutput.map(entry => `[${new Date(entry.timestamp).toISOString()}] [${entry.type.toUpperCase()}] ${entry.line}`).join('\n');
                await fs.writeFile(outputFilePath, logContent);
                console.log(`[WRAPPER] Chopped logs saved to: ${outputFilePath}`);
            } catch (err) {
                console.error(`[WRAPPER_ERROR] Failed to write chopped log file: ${outputFilePath}`, err);
            }

            // Update lastChopTime and potentially clear/prune the buffer based on strategy
            lastChopTime = Date.now();
            // For now, let's keep the buffer growing. We can add pruning later.
            // logBuffer = logBuffer.filter(entry => entry.timestamp > lastChopTime); // Example: Prune old logs
        };

        // 2. Set up chokidar to watch the target path
        const watcher = chokidar.watch(absoluteWatchPath, {
            persistent: true,
            ignoreInitial: true, // Don't trigger on initial scan
        });

        watcher
            .on('add', filePath => { console.log(`[CHOKIDAR] File ${filePath} has been added`); chopLogs(); })
            .on('change', filePath => { console.log(`[CHOKIDAR] File ${filePath} has been changed`); chopLogs(); })
            .on('unlink', filePath => { console.log(`[CHOKIDAR] File ${filePath} has been removed`); chopLogs(); })
            .on('error', error => console.error(`[CHOKIDAR_ERROR] Watcher error: ${error}`))
            .on('ready', () => console.log('[CHOKIDAR] Initial scan complete. Ready for changes.'));

        console.log(`[CHOKIDAR] Watching for changes in: ${absoluteWatchPath}`);

        // 3. Spawn the commandToRun
        console.log('\nStarting the wrapped process...');
        const childProcess = spawn(command, args, {
            stdio: ['inherit', 'pipe', 'pipe'],
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
            watcher.close(); // Close watcher on child process error
            process.exit(1);
        });

        childProcess.on('close', (code) => {
            console.log(`\nChild process exited with code ${code}`);
            watcher.close().then(() => console.log('[CHOKIDAR] Watcher closed.'));
            // Perform a final log chop before exiting
            chopLogs().finally(() => {
                console.log('[WRAPPER] Exiting.');
                process.exit(code === null ? 1 : code);
            });
        });

        // Graceful shutdown handling
        const cleanup = (signal: NodeJS.Signals) => {
            console.log(`\n[WRAPPER] Received ${signal}. Terminating child process and watcher...`);
            watcher.close().then(() => console.log('[CHOKIDAR] Watcher closed due to signal.'));
            if (childProcess.pid && !childProcess.killed) {
                childProcess.kill(); // Send SIGTERM to the child
                setTimeout(() => {
                    if (childProcess.pid && !childProcess.killed) {
                        console.log('[WRAPPER] Child process did not exit gracefully, forcing kill.');
                        childProcess.kill('SIGKILL');
                    }
                }, 2000); // 2 seconds grace period
            }
        };

        process.on('SIGINT', cleanup.bind(null, 'SIGINT'));
        process.on('SIGTERM', cleanup.bind(null, 'SIGTERM'));
    });

program.parse(process.argv);

// if (!process.argv.slice(2).length) {
//   program.outputHelp();
// } 