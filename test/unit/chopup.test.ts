import { describe, it, expect, vi, beforeEach, afterEach, MockedFunction } from 'vitest';
import type { Mocked } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { Chopup, LOGS_CHOPPED, REQUEST_LOGS_COMMAND, SEND_INPUT_COMMAND, INPUT_SENT, INPUT_SEND_ERROR_NO_CHILD } from '../../src/chopup';
import type { SpawnFunction } from '../../src/chopup';
import { FakeChildProcess } from '../../test/doubles/fake-child';
import { createServer as createMockIPCServer, createConnection as createMockIPCConnection, resetMockIpc } from '../../test/doubles/ipc-mock';
import type { IMockServer, IMockSocket } from '../../test/doubles/ipc-mock';
import type { ChildProcess, /* SpawnOptions */ } from 'node:child_process';
import type { MockInstance } from 'vitest';

vi.mock('node:fs/promises');
vi.mock('node:fs');

let mockTreeKillFnImplementation = (
    pid: number,
    signal: string | number | undefined,
    callback?: (error?: Error) => void
) => {
    if (callback) callback();
    return true;
};
vi.mock('tree-kill', () => ({
    default: (...args: [number, string | number | undefined, ((error?: Error) => void)?]) =>
        mockTreeKillFnImplementation(args[0], args[1], args[2])
}));

const mockLogDir = '/test/logs';
const mockCommand = 'test-cmd';
const mockArgs = ['arg1', 'arg2'];

describe('Chopup', () => {
    let fakeChildProcess: FakeChildProcess;
    let mockIPCServerInstance: IMockServer;
    let mockSpawnFn: MockedFunction<SpawnFunction>;
    let chopupNetCreateServerMock: MockedFunction<typeof createMockIPCServer>;
    let mockProcessPid: number;
    let listenSpy: MockInstance<Parameters<IMockServer['listen']>, ReturnType<IMockServer['listen']>>;

    beforeEach(() => {
        mockProcessPid = 12345;
        fakeChildProcess = new FakeChildProcess({ pid: 67890 });

        chopupNetCreateServerMock = vi.fn().mockImplementation(
            (connectionListenerProvidedByChopup) => {
                const server = createMockIPCServer(connectionListenerProvidedByChopup);
                const originalListen = server.listen;

                listenSpy = vi.spyOn(server, 'listen').mockImplementation((...args: Parameters<typeof originalListen>) => {
                    return originalListen.apply(server, args);
                });
                mockIPCServerInstance = server;
                return server;
            }
        );

        mockSpawnFn = vi.fn<Parameters<SpawnFunction>, ReturnType<SpawnFunction>>().mockReturnValue(fakeChildProcess as unknown as ChildProcess);

        mockTreeKillFnImplementation = vi.fn((pid, signal, callback) => {
            if (callback) callback();
            return true;
        });

        vi.spyOn(fsSync, 'existsSync').mockReturnValue(false);
        vi.spyOn(fsSync, 'mkdirSync').mockImplementation(() => mockLogDir);
        vi.spyOn(fsSync, 'unlinkSync').mockImplementation(() => { });
        vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
        vi.spyOn(fs, 'mkdir').mockResolvedValue(mockLogDir);
        vi.spyOn(fs, 'unlink').mockResolvedValue(undefined);
        vi.spyOn(global, 'process', 'get').mockReturnValue({
            ...process,
            pid: mockProcessPid,
            env: { ...process.env },
            on: vi.fn(),
            stdout: { fd: 1, write: vi.fn(), writable: true } as unknown as NodeJS.WriteStream & { fd: 1 },
            stderr: { fd: 2, write: vi.fn(), writable: true } as unknown as NodeJS.WriteStream & { fd: 2 },
            exit: vi.fn() as (code?: number) => never,
        });
        resetMockIpc();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetMockIpc();
    });

    const getTestSocketPath = () => path.join(mockLogDir, `chopup-${mockProcessPid}.sock`);

    const createChopupInstance = (socketPath?: string) => {
        const mockNetModule = { createServer: chopupNetCreateServerMock as unknown as typeof net.createServer };
        return new Chopup(
            mockCommand,
            mockArgs,
            mockLogDir,
            socketPath,
            mockSpawnFn as SpawnFunction,
            mockNetModule,
        );
    };

    describe('Constructor', () => {
        it('should initialize properties correctly', () => {
            const chopup = createChopupInstance();
            expect(chopup.getSocketPath()).toBe(getTestSocketPath());
        });

        it('should use provided socketPath if available', () => {
            const customSocketPath = '/custom/socket.sock';
            const chopup = createChopupInstance(customSocketPath);
            expect(chopup.getSocketPath()).toBe(customSocketPath);
        });

        it('should create log directory if it does not exist', () => {
            (fsSync.existsSync as MockedFunction<typeof fsSync.existsSync>).mockReturnValue(false);
            createChopupInstance();
            expect(fsSync.mkdirSync).toHaveBeenCalledWith(mockLogDir, { recursive: true });
        });

        it('should not create log directory if it already exists', () => {
            (fsSync.existsSync as MockedFunction<typeof fsSync.existsSync>).mockReturnValue(true);
            createChopupInstance();
            expect(fsSync.mkdirSync).not.toHaveBeenCalled();
        });
    });

    describe('run', () => {
        it('should initialize signal handlers, IPC server, and spawn child process', async () => {
            const chopup = createChopupInstance();
            const initializeSignalHandlersSpy = vi.spyOn(chopup as InstanceType<typeof Chopup>, 'initializeSignalHandlers' as keyof Chopup);
            const setupIpcServerSpy = vi.spyOn(chopup as InstanceType<typeof Chopup>, 'setupIpcServer' as keyof Chopup);

            await chopup.run();

            expect(initializeSignalHandlersSpy).toHaveBeenCalled();
            expect(setupIpcServerSpy).toHaveBeenCalled();
            expect(mockSpawnFn).toHaveBeenCalledWith(mockCommand, mockArgs, expect.any(Object));
            expect(fakeChildProcess.listenerCount('data')).toBeGreaterThanOrEqual(0);
            expect(fakeChildProcess.stdout?.listenerCount('data')).toBeGreaterThanOrEqual(1);
            expect(fakeChildProcess.stderr?.listenerCount('data')).toBeGreaterThanOrEqual(1);
            expect(fakeChildProcess.listenerCount('error')).toBeGreaterThanOrEqual(1);
            expect(fakeChildProcess.listenerCount('exit')).toBeGreaterThanOrEqual(1);
        });

        it('should log startup messages via logToConsole', async () => {
            const chopup = createChopupInstance();
            const logToConsoleSpy = vi.spyOn(chopup as InstanceType<typeof Chopup>, 'logToConsole' as keyof Chopup);
            await chopup.run();

            await new Promise(resolve => process.nextTick(resolve));

            expect(logToConsoleSpy).toHaveBeenCalledWith(expect.stringContaining(`Wrapping command: ${mockCommand}`));
            expect(logToConsoleSpy).toHaveBeenCalledWith(expect.stringContaining(`Child process PID: ${fakeChildProcess.pid}`));
            expect(logToConsoleSpy).toHaveBeenCalledWith(expect.stringContaining(`CHOPUP_SOCKET_PATH=${getTestSocketPath()}`));
        });
    });

    describe('IPC Server', () => {
        it('should start IPC server and listen on socket path', async () => {
            const chopup = createChopupInstance();
            await chopup.run();

            expect(chopupNetCreateServerMock).toHaveBeenCalled();
            expect(listenSpy).toHaveBeenCalledWith(getTestSocketPath(), expect.any(Function));
        });

        it('should handle "request-logs" command', async () => {
            const chopup = createChopupInstance();
            await chopup.run();

            const chopupInstance = chopup as Chopup & { logBuffer: any[] };
            chopupInstance.logBuffer.push({ timestamp: Date.now(), type: 'stdout', line: 'test log for request\n' });

            await new Promise<void>(resolve => mockIPCServerInstance.on('listening', resolve));
            const clientSocket = createMockIPCConnection(getTestSocketPath());
            await new Promise<void>(resolve => clientSocket.once('connect', resolve));

            const clientResponsePromise = new Promise<string>(resolve => clientSocket.once('data', data => resolve(data.toString())));

            clientSocket.write(JSON.stringify({ command: REQUEST_LOGS_COMMAND }));

            const response = await clientResponsePromise;
            expect(response).toBe(LOGS_CHOPPED);
            clientSocket.destroy();
        });

        it('should handle "send-input" command and write to child stdin', async () => {
            const chopup = createChopupInstance();
            await chopup.run();
            const testInput = 'hello child';

            const stdinWriteSpy = vi.spyOn(fakeChildProcess.stdin!, 'write');

            await new Promise<void>(resolve => mockIPCServerInstance.on('listening', resolve));
            const clientSocket = createMockIPCConnection(getTestSocketPath());
            await new Promise<void>(resolve => clientSocket.once('connect', resolve));

            clientSocket.write(JSON.stringify({ command: SEND_INPUT_COMMAND, input: testInput }));

            await new Promise(resolve => setTimeout(resolve, 500));

            expect(stdinWriteSpy).toHaveBeenCalledWith(testInput, expect.any(Function));

            clientSocket.destroy();
        });

        it('should handle "send-input" when child process stdin is not available', async () => {
            const chopup = createChopupInstance();
            await chopup.run();
            if (fakeChildProcess.stdin) fakeChildProcess.stdin.destroy();

            await new Promise<void>(resolve => mockIPCServerInstance.on('listening', resolve));
            const clientSocket = createMockIPCConnection(getTestSocketPath());
            await new Promise<void>(resolve => clientSocket.once('connect', resolve));
            const clientResponsePromise = new Promise<string>(resolve => clientSocket.once('data', data => resolve(data.toString())));

            clientSocket.write(JSON.stringify({ command: SEND_INPUT_COMMAND, input: 'test' }));

            const response = await clientResponsePromise;
            expect(response).toBe(INPUT_SEND_ERROR_NO_CHILD);
            clientSocket.destroy();
        });

        it('should handle unknown IPC command', async () => {
            const chopup = createChopupInstance();
            await chopup.run();

            await new Promise<void>(resolve => mockIPCServerInstance.on('listening', resolve));
            const clientSocket = createMockIPCConnection(getTestSocketPath());
            await new Promise<void>(resolve => clientSocket.once('connect', resolve));
            const clientResponsePromise = new Promise<string>(resolve => clientSocket.once('data', data => resolve(data.toString())));

            clientSocket.write(JSON.stringify({ command: 'unknown-command' }));
            const response = await clientResponsePromise;
            expect(response).toBe('UNKNOWN_COMMAND');
            clientSocket.destroy();
        });

        it('should handle IPC data parse error', async () => {
            const chopup = createChopupInstance();
            await chopup.run();
            await new Promise<void>(resolve => mockIPCServerInstance.on('listening', resolve));
            const clientSocket = createMockIPCConnection(getTestSocketPath());
            await new Promise<void>(resolve => clientSocket.once('connect', resolve));
            const clientResponsePromise = new Promise<string>(resolve => clientSocket.once('data', data => resolve(data.toString())));

            clientSocket.write('invalid json');
            const response = await clientResponsePromise;
            expect(response).toBe('IPC_PARSE_ERROR');
            clientSocket.destroy();
        });

        it('should remove existing socket file on IPC server setup if it exists', async () => {
            (fsSync.existsSync as MockedFunction<typeof fsSync.existsSync>).mockReturnValue(true);
            const chopup = createChopupInstance();
            await chopup.run();
            expect(fsSync.unlinkSync).toHaveBeenCalledWith(getTestSocketPath());
        });
    });

    describe('chopLog', () => {
        const MOCK_LAST_CHOP_TIME = 1600000000000;
        const MOCK_CHOP_TIME = 1600000005000;
        const MOCK_RECORD_OUTPUT_TIME = 1600000002000;

        it('should write logBuffer to file and clear buffer', async () => {
            const chopup = createChopupInstance();
            const chopupInstance = chopup as Chopup & { logBuffer: any[], lastChopTime: number, recordOutput: any, chopLog: any };

            let dateNowCallCount = 0;
            const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
                if (dateNowCallCount === 0) {
                    dateNowCallCount++;
                    return MOCK_CHOP_TIME;
                }
                return MOCK_RECORD_OUTPUT_TIME;
            });

            chopupInstance.lastChopTime = MOCK_LAST_CHOP_TIME;

            dateNowSpy.mockReturnValueOnce(MOCK_RECORD_OUTPUT_TIME);
            chopupInstance.recordOutput(Buffer.from('line1\n'), 'stdout');
            dateNowSpy.mockReturnValueOnce(MOCK_RECORD_OUTPUT_TIME);
            chopupInstance.recordOutput(Buffer.from('line2\n'), 'stderr');

            dateNowCallCount = 0;
            dateNowSpy.mockImplementationOnce(() => MOCK_CHOP_TIME);

            await chopupInstance.chopLog();

            const expectedFilename = path.join(mockLogDir, `${mockCommand}_${MOCK_LAST_CHOP_TIME}_${MOCK_CHOP_TIME}_log`);
            const isoTimestamp = new Date(MOCK_RECORD_OUTPUT_TIME).toISOString();
            const expectedContent = `[${isoTimestamp}] [stdout] line1\n[${isoTimestamp}] [stderr] line2\n`;

            expect(fs.writeFile).toHaveBeenCalledWith(expectedFilename, expectedContent);
            expect(chopupInstance.logBuffer.length).toBe(0);
            expect(chopupInstance.lastChopTime).toBe(MOCK_CHOP_TIME);
            dateNowSpy.mockRestore();
        });

        it('should handle final chop correctly', async () => {
            const chopup = createChopupInstance();
            const chopupInstance = chopup as Chopup & { logBuffer: any[], lastChopTime: number, recordOutput: any, chopLog: any };
            const dateNowSpy = vi.spyOn(Date, 'now');

            dateNowSpy.mockReturnValueOnce(MOCK_RECORD_OUTPUT_TIME);
            chopupInstance.recordOutput(Buffer.from('final line\n'), 'stdout');

            chopupInstance.lastChopTime = MOCK_LAST_CHOP_TIME;
            dateNowSpy.mockReturnValueOnce(MOCK_CHOP_TIME);

            await chopupInstance.chopLog(true);

            const expectedFilename = path.join(mockLogDir, `${mockCommand}_${MOCK_LAST_CHOP_TIME}_${MOCK_CHOP_TIME}_final_log`);
            const isoTimestamp = new Date(MOCK_RECORD_OUTPUT_TIME).toISOString();
            const expectedContent = `[${isoTimestamp}] [stdout] final line\n`;

            expect(fs.writeFile).toHaveBeenCalled();
            dateNowSpy.mockRestore();
        });

        it('should not write if logBuffer is empty and not finalChop', async () => {
            const chopup = createChopupInstance();
            const chopupInstance = chopup as Chopup & { chopLog: any };
            (fs.writeFile as MockedFunction<typeof fs.writeFile>).mockClear();
            await chopupInstance.chopLog(false);
            expect(fs.writeFile).not.toHaveBeenCalled();
        });
    });

    describe('recordOutput', () => {
        it('should add lines to logBuffer with correct timestamp and type', () => {
            const chopup = createChopupInstance();
            const chopupInstance = chopup as Chopup & { logBuffer: any[], recordOutput: any };
            const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(1234567890);

            chopupInstance.recordOutput(Buffer.from('out1\nout2'), 'stdout');
            chopupInstance.recordOutput(Buffer.from('err1'), 'stderr');

            const buffer = chopupInstance.logBuffer;
            expect(buffer.length).toBe(3);
            expect(buffer[0]).toEqual({ timestamp: 1234567890, type: 'stdout', line: 'out1\n' });
            expect(buffer[1]).toEqual({ timestamp: 1234567890, type: 'stdout', line: 'out2\n' });
            expect(buffer[2]).toEqual({ timestamp: 1234567890, type: 'stderr', line: 'err1\n' });
            dateNowSpy.mockRestore();
        });
    });

    describe('Cleanup and Signal Handling', () => {
        it('should perform final cleanup on child process exit', async () => {
            const chopup = createChopupInstance();
            const doCleanupSpy = vi.spyOn(chopup as InstanceType<typeof Chopup>, 'doCleanup' as keyof Chopup);
            await chopup.run();

            fakeChildProcess.exit(0, null);
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(doCleanupSpy).toHaveBeenCalledWith(0, null);
        });

        it('doCleanup should call performFinalCleanup and prevent multiple runs', async () => {
            const chopup = createChopupInstance();
            const chopupInstance = chopup as Chopup & { doCleanup: any, performFinalCleanup: any, cleanupInitiated: boolean };
            const performFinalCleanupSpy = vi.spyOn(chopupInstance, 'performFinalCleanup' as keyof Chopup).mockResolvedValue(undefined);

            await chopupInstance.doCleanup(0, 'SIGINT');
            expect(performFinalCleanupSpy).toHaveBeenCalledTimes(1);
            expect(chopupInstance.cleanupInitiated).toBe(true);

            await chopupInstance.doCleanup(0, 'SIGINT');
            expect(performFinalCleanupSpy).toHaveBeenCalledTimes(1);
        });

        it('performFinalCleanup should chop logs, close IPC, unlink socket, and kill child', async () => {
            const chopup = createChopupInstance();
            const chopupInstance = chopup as Chopup & { performFinalCleanup: any, chopLog: any, activeConnections: Set<net.Socket> };
            await chopup.run();
            (fsSync.existsSync as MockedFunction<typeof fsSync.existsSync>)
                .mockImplementation((p) => p === getTestSocketPath());

            const chopLogSpy = vi.spyOn(chopupInstance, 'chopLog' as keyof Chopup);
            const ipcServerCloseSpy = vi.spyOn(mockIPCServerInstance, 'close').mockImplementation((cb?: (err?: Error) => void) => { if (cb) cb(); return mockIPCServerInstance; });
            const socketUnlinkSpy = vi.spyOn(fs, 'unlink');

            const mockClientSocket1 = createMockIPCConnection(getTestSocketPath());
            chopupInstance.activeConnections.add(mockClientSocket1 as unknown as net.Socket);

            await chopupInstance.performFinalCleanup(0, null);

            expect(chopLogSpy).toHaveBeenCalledWith(true);
            expect(ipcServerCloseSpy).toHaveBeenCalled();
            expect(socketUnlinkSpy).toHaveBeenCalledWith(getTestSocketPath());
            expect(mockTreeKillFnImplementation).toHaveBeenCalledWith(fakeChildProcess.pid, 'SIGKILL', expect.any(Function));
        });

        it('initializeSignalHandlers should set up process signal listeners', () => {
            const chopup = createChopupInstance();
            (chopup as Chopup & { initializeSignalHandlers: any })['initializeSignalHandlers']();
            expect(process.on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
            expect(process.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
            expect(process.on).toHaveBeenCalledWith('exit', expect.any(Function));
        });
    });

    describe('getSocketPath', () => {
        it('should return the correct socket path', () => {
            const customPath = '/tmp/mysock.sock';
            const chopup = createChopupInstance(customPath);
            expect(chopup.getSocketPath()).toBe(customPath);

            const defaultChopup = createChopupInstance();
            expect(defaultChopup.getSocketPath()).toBe(getTestSocketPath());
        });
    });
}); 