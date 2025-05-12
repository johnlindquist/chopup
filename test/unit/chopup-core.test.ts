import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { Chopup, LOGS_CHOPPED, SEND_INPUT_COMMAND, REQUEST_LOGS_COMMAND, INPUT_SENT, INPUT_SEND_ERROR, INPUT_SEND_ERROR_NO_CHILD } from '../../src/chopup';
import { createServer, createConnection, resetMockIpc } from '../../src/test-doubles/ipc-mock';
import { FakeChildProcess } from '../../src/test-doubles/fake-child';
import fs from 'node:fs/promises';

const TEST_SOCKET_PATH = '/tmp/test-chopup-core.sock';
const TEST_LOG_DIR = '/tmp/test-chopup-logs';

let writeFileSpy: ReturnType<typeof vi.spyOn>;
let mkdirSpy: ReturnType<typeof vi.spyOn>;

function makeChopupWithMocks(fakeChild?: FakeChildProcess) {
    // Use IPC mock for net, and fake child for spawn
    const spawnFn = () => fakeChild || new FakeChildProcess();
    const netModule = { createServer };
    return new Chopup('echo', ['ok'], TEST_LOG_DIR, TEST_SOCKET_PATH, spawnFn, netModule);
}

describe('Chopup core logic', () => {
    let chopup: Chopup;
    let fakeChild: FakeChildProcess;

    beforeEach(() => {
        resetMockIpc();
        writeFileSpy = vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined as any);
        mkdirSpy = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as any);
        fakeChild = new FakeChildProcess();
        chopup = makeChopupWithMocks(fakeChild);
    });

    afterEach(() => {
        resetMockIpc();
        vi.clearAllMocks();
    });

    afterAll(() => {
        writeFileSpy.mockRestore();
        mkdirSpy.mockRestore();
    });

    it('chopLog creates a file and resets buffer', () => {
        (chopup as any).logBuffer = [
            { timestamp: Date.now(), type: 'stdout', line: 'line1\n' },
            { timestamp: Date.now(), type: 'stderr', line: 'line2\n' },
        ];
        chopup.chopLog();
        expect(writeFileSpy).toHaveBeenCalledTimes(1);
        expect((chopup as any).logBuffer).toEqual([]);
    });

    it('send-input handler writes to child stdin and responds', async () => {
        await chopup.run();
        const server = (chopup as any).ipcServer;
        await new Promise<void>(resolve => server.listen(TEST_SOCKET_PATH, resolve));
        // Move client creation after server.listen resolves
        const client = createConnection(TEST_SOCKET_PATH);
        await new Promise<void>(resolve => client.once('connect', resolve));
        const responsePromise = new Promise<string>(resolve => {
            client.on('data', data => resolve(data.toString()));
        });
        client.write(JSON.stringify({ command: SEND_INPUT_COMMAND, input: 'abc' }));
        const response = await Promise.race([
            responsePromise,
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        expect(response).toBe('CHOPUP_INPUT_SENT');
        fakeChild.stdin.end();
        const stdinContent = await fakeChild.getStdinContent();
        expect(stdinContent).toContain('abc');
    }, 10000);

    it('request-logs command triggers chopLog and responds', async () => {
        await chopup.run();
        // Add a log entry
        (chopup as any).logBuffer.push({ timestamp: Date.now(), type: 'stdout', line: 'test log entry\n' });
        const server = (chopup as any).ipcServer;
        await new Promise<void>(resolve => server.listen(TEST_SOCKET_PATH, resolve));
        // Move client creation after server.listen resolves
        const client = createConnection(TEST_SOCKET_PATH);
        await new Promise<void>(resolve => client.once('connect', resolve));
        const responsePromise = new Promise<string>(resolve => {
            client.on('data', data => resolve(data.toString()));
        });
        client.write(JSON.stringify({ command: REQUEST_LOGS_COMMAND }));
        const response = await Promise.race([
            responsePromise,
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        expect(response).toBe(LOGS_CHOPPED);
        expect(writeFileSpy).toHaveBeenCalled();
    }, 10000);

    it('send-input returns error if no child process', async () => {
        await chopup.run();
        (chopup as any).childProcess = null;
        const server = (chopup as any).ipcServer;
        await new Promise<void>(resolve => server.listen(TEST_SOCKET_PATH, resolve));
        // Move client creation after server.listen resolves
        const client = createConnection(TEST_SOCKET_PATH);
        await new Promise<void>(resolve => client.once('connect', resolve));
        const responsePromise = new Promise<string>(resolve => {
            client.on('data', data => resolve(data.toString()));
        });
        client.write(JSON.stringify({ command: SEND_INPUT_COMMAND, input: 'abc' }));
        const response = await Promise.race([
            responsePromise,
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        expect(response).toBe(INPUT_SEND_ERROR_NO_CHILD);
    }, 10000);
}); 